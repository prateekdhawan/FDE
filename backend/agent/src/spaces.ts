/**
 * M7 — Spaces & document upload. A Space is a folder of the user's own documents that a Space
 * search (M8) retrieves over. This file owns the SYNCHRONOUS half: CRUD + accepting an upload.
 * The asynchronous half (parse → chunk → embed → index) is the worker (worker.ts); this route
 * only stores the bytes and enqueues a job, then returns 202 fast.
 *
 * Why upload is 202-and-a-job, not do-it-inline (README Part 1 step 6 / the bench's accept202 cap,
 * p95 ≤ 300ms): a 60-page PDF is hundreds of embed calls and many seconds of work. Doing that in
 * the request would blow the latency SLA, hold an HTTP connection open for the whole ingest, and
 * lose all progress if the socket dropped. Instead: write the raw file to GridFS, insert a
 * `pending` DocumentDoc, enqueue an `index_document` JobDoc, return `{docId, status:'pending'}`.
 * The client polls GET /spaces/:id/documents to watch status walk pending → parsing → embedding →
 * indexed. The worker is a SEPARATE process (`npm run worker`); if it is down, uploads still
 * succeed and jobs simply queue — decoupling the accept from the compute is the entire point.
 *
 * Four routes, all auth:true (contract ROUTES):
 *   POST /spaces                       create        → 201 { spaceId, name }
 *   GET  /spaces                       list mine     → { spaces: [...] }
 *   POST /spaces/:spaceId/documents    upload        → 202 { docId, status:'pending' }
 *   GET  /spaces/:spaceId/documents    list docs     → { documents: [DocumentRow...] }
 *
 * Ownership is enforced the same way threads.ts does it: every query is scoped by userId, and a
 * space that isn't yours reads as 404, never 403 — we don't confirm it exists.
 */
import express from 'express';
import multer from 'multer';
import { GridFSBucket, ObjectId } from 'mongodb';
import {
  ACCEPTED_UPLOAD_TYPES,
  COLLECTIONS,
  CreateSpaceBody,
  GRIDFS_BUCKETS,
  MAX_UPLOAD_BYTES,
  newId,
  type CreateSpaceResponse,
  type DocumentDoc,
  type DocumentRow,
  type JobDoc,
  type ListDocumentsResponse,
  type ListSpacesResponse,
  type SpaceDoc,
  type UploadDocumentResponse
} from '@lumina/contract';
import { db } from './db.js';
import { requireUser } from './threads.js';

const spacesCol = async () => (await db()).collection<SpaceDoc>(COLLECTIONS.spaces);
const documentsCol = async () => (await db()).collection<DocumentDoc>(COLLECTIONS.documents);
const jobsCol = async () => (await db()).collection<JobDoc>(COLLECTIONS.jobs);

/** Jobs have no prefixed-id case in the contract's newId; mirror threads.ts's local scheme. */
const newJobId = () => `job_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const toIso = (v: string | Date): string => (v instanceof Date ? v : new Date(v)).toISOString();

/**
 * In-memory upload: the file never touches local disk (this process may be an ephemeral Fly
 * machine), we stream the buffer straight into GridFS. The size limit is enforced HERE, by multer,
 * so an over-large body is rejected before it is fully buffered — that is the 413.
 */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });

/**
 * multer surfaces a too-large body as MulterError LIMIT_FILE_SIZE. Left unhandled it would hit the
 * app's error middleware and become a 502 — but an oversized upload is the client's fault, so map
 * it to 413 (contract error code) and any other multer parse error to 400.
 */
const uploadSingle = (req: express.Request, res: express.Response, next: express.NextFunction): void => {
  upload.single('file')(req, res, (err: unknown) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: `file exceeds ${MAX_UPLOAD_BYTES} bytes`, status: 413 });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : 'upload failed', status: 400 });
      return;
    }
    next();
  });
};

export const spacesRouter = express.Router();

// ---------------------------------------------------------------- POST /spaces

spacesRouter.post('/spaces', requireUser, async (req, res) => {
  const parsed = CreateSpaceBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid body', status: 400 });
    return;
  }
  const doc: SpaceDoc = {
    _id: newId('spc'),
    userId: res.locals.userId as string,
    name: parsed.data.name.trim(),
    createdAt: new Date()
  };
  await (await spacesCol()).insertOne(doc);
  const body: CreateSpaceResponse = { spaceId: doc._id, name: doc.name };
  res.status(201).json(body);
});

// ---------------------------------------------------------------- GET /spaces

spacesRouter.get('/spaces', requireUser, async (_req, res) => {
  const rows = await (await spacesCol())
    .find({ userId: res.locals.userId as string })
    .sort({ createdAt: -1 })
    .toArray();
  const body: ListSpacesResponse = {
    spaces: rows.map((s) => ({ spaceId: s._id, name: s.name, createdAt: toIso(s.createdAt) }))
  };
  res.json(body);
});

// ---------------------------------------------------------------- POST /spaces/:spaceId/documents

spacesRouter.post('/spaces/:spaceId/documents', requireUser, uploadSingle, async (req, res) => {
  const userId = res.locals.userId as string;
  const { spaceId } = req.params;

  // Ownership BEFORE we write anything: an unowned space 404s and leaves no orphan GridFS file.
  const space = await (await spacesCol()).findOne({ _id: spaceId, userId });
  if (!space) {
    res.status(404).json({ error: `no space ${spaceId}`, status: 404 });
    return;
  }

  const file = req.file;
  if (!file) {
    res.status(400).json({ error: 'file field is required (multipart form field "file")', status: 400 });
    return;
  }
  if (!(ACCEPTED_UPLOAD_TYPES as readonly string[]).includes(file.mimetype)) {
    // Contract has no 415; a rejected content-type is a bad request → 400.
    res.status(400).json({ error: `unsupported type ${file.mimetype}`, status: 400 });
    return;
  }

  // Raw bytes → GridFS 'uploads' bucket. The worker reads them back by fileId.
  const bucket = new GridFSBucket(await db(), { bucketName: GRIDFS_BUCKETS.uploads });
  const fileId = await new Promise<ObjectId>((resolve, reject) => {
    const stream = bucket.openUploadStream(file.originalname, { contentType: file.mimetype });
    stream.on('error', reject);
    stream.on('finish', () => resolve(stream.id as ObjectId));
    stream.end(file.buffer);
  });

  const docId = newId('doc');
  const document: DocumentDoc = {
    _id: docId,
    spaceId: space._id, // definite SpaceId (req.params is string|undefined)
    userId,
    title: file.originalname,
    mimeType: file.mimetype,
    bytes: file.buffer.length,
    status: 'pending',
    pct: 0,
    fileId: String(fileId),
    createdAt: new Date()
  };
  await (await documentsCol()).insertOne(document);

  // Enqueue the ingest. `pending` is what the worker's atomic claim looks for.
  const job: JobDoc = {
    _id: newJobId(),
    kind: 'index_document',
    status: 'pending',
    payload: { docId, spaceId: space._id, userId },
    userId,
    attempts: 0,
    createdAt: new Date()
  };
  await (await jobsCol()).insertOne(job);

  const body: UploadDocumentResponse = { docId, status: 'pending' };
  res.status(202).json(body);
});

// ---------------------------------------------------------------- GET /spaces/:spaceId/documents

spacesRouter.get('/spaces/:spaceId/documents', requireUser, async (req, res) => {
  const userId = res.locals.userId as string;
  const { spaceId } = req.params;

  const space = await (await spacesCol()).findOne({ _id: spaceId, userId });
  if (!space) {
    res.status(404).json({ error: `no space ${spaceId}`, status: 404 });
    return;
  }

  const rows = await (await documentsCol())
    .find({ spaceId, userId })
    .sort({ createdAt: 1 })
    .toArray();
  const body: ListDocumentsResponse = { documents: rows.map(toDocumentRow) };
  res.json(body);
});

/** DocumentDoc (DB) → DocumentRow (wire). Drops the internals (fileId, mimeType, bytes, userId). */
function toDocumentRow(d: DocumentDoc): DocumentRow {
  return {
    docId: d._id,
    title: d.title,
    status: d.status,
    pct: d.pct,
    ...(d.pages !== undefined ? { pages: d.pages } : {}),
    ...(d.chunks !== undefined ? { chunks: d.chunks } : {}),
    ...(d.error !== undefined ? { error: d.error } : {})
  };
}
