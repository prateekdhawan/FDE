/**
 * M7 — the jobs worker. A SEPARATE process (`npm run worker`), deliberately not started by
 * `npm run dev`: parsing/embedding a 60-page PDF must never run on the thread streaming someone's
 * answer, and the bench proves it by measuring search p95 *during* an ingest (runIngestDecoupling).
 * Decoupling the accept (spaces.ts, 202 + a job) from the compute (here) is the whole design.
 *
 * The claim is atomic so two workers can never grab the same job — findOneAndUpdate flips exactly
 * one `pending` row to `running` and hands it back. A worker killed mid-job leaves its row
 * `running` with a stale `claimedAt`; the sweeper returns that to `pending` (up to MAX_ATTEMPTS,
 * then `failed`), which is the crash-safety the skeleton calls out.
 *
 * Pipeline (index_document, the only job kind):
 *   GridFS read → parseDocument → chunkSegments → embedBatch → replace chunks →
 *   READ-YOUR-WRITE PROBE → status:'indexed'
 *
 * The probe is the subtle part: "upserted" is not "searchable". Atlas Search indexes are
 * eventually consistent, so after inserting the chunks we query the vector index for one we just
 * wrote and only flip the document to `indexed` once it comes back. That is what makes the bench's
 * "poll until indexed, then a doc search finds it" contract honest rather than racy.
 *
 * Status walks the doc through pending → parsing(10%) → embedding(50%) → indexed(100%), which is
 * exactly what the client sees polling GET /spaces/:id/documents.
 */
import { hostname } from 'node:os';
import pino from 'pino';
import { GridFSBucket, ObjectId } from 'mongodb';
import {
  COLLECTIONS,
  GRIDFS_BUCKETS,
  SEARCH_INDEXES,
  type ChunkDoc,
  type DocumentDoc,
  type JobDoc
} from '@lumina/contract';
import { env } from './env.js';
import { db } from './db.js';
import { parseDocument, chunkSegments } from './ingest.js';
import { embedBatch } from './llm.js';

const log = pino({ level: env.logLevel });

/** Identifies which worker holds a claim — useful in logs and to spot a machine that keeps dying. */
const workerId = `${hostname()}-${process.pid}`;

const POLL_MS = 1000;
/** A `running` job older than this is presumed dead (its worker crashed) and is swept. */
const STALE_MS = 2 * 60_000;
/** After this many claims a job is declared failed rather than retried forever. */
const MAX_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const jobsCol = async () => (await db()).collection<JobDoc>(COLLECTIONS.jobs);
const documentsCol = async () => (await db()).collection<DocumentDoc>(COLLECTIONS.documents);
const chunksCol = async () => (await db()).collection<ChunkDoc>(COLLECTIONS.chunks);

// ---------------------------------------------------------------- claim & sweep

/** Atomically take the oldest pending job. Returns null when the queue is empty. */
async function claim(): Promise<JobDoc | null> {
  const jobs = await jobsCol();
  const job = await jobs.findOneAndUpdate(
    { status: 'pending' },
    { $set: { status: 'running', claimedAt: new Date(), workerId }, $inc: { attempts: 1 } },
    { sort: { createdAt: 1 }, returnDocument: 'after' }
  );
  return job ?? null;
}

/**
 * Crash recovery. A `running` job whose `claimedAt` is older than STALE_MS lost its worker: return
 * it to `pending` so another worker retries — unless it has already burned MAX_ATTEMPTS, in which
 * case it (and its document) are marked failed so the client's poll terminates.
 */
async function sweepStale(): Promise<void> {
  const jobs = await jobsCol();
  const cutoff = new Date(Date.now() - STALE_MS);

  await jobs.updateMany(
    { status: 'running', claimedAt: { $lt: cutoff }, attempts: { $lt: MAX_ATTEMPTS } },
    { $set: { status: 'pending' }, $unset: { claimedAt: '', workerId: '' } }
  );

  const dead = await jobs.find({ status: 'running', claimedAt: { $lt: cutoff }, attempts: { $gte: MAX_ATTEMPTS } }).toArray();
  for (const j of dead) {
    await jobs.updateOne({ _id: j._id }, { $set: { status: 'failed', error: 'worker crashed (exceeded max attempts)' } });
    const docId = j.payload.docId;
    if (typeof docId === 'string') {
      await (await documentsCol()).updateOne({ _id: docId }, { $set: { status: 'failed', error: 'ingest worker crashed' } });
    }
  }
}

// ---------------------------------------------------------------- the pipeline

type DocPatch = Partial<Pick<DocumentDoc, 'status' | 'pct' | 'pages' | 'chunks' | 'error'>>;
const patchDoc = async (docId: string, patch: DocPatch) =>
  (await documentsCol()).updateOne({ _id: docId }, { $set: patch });

/** Pull the raw upload back out of GridFS as a single Buffer. */
async function gridfsRead(fileId: string): Promise<Buffer> {
  const bucket = new GridFSBucket(await db(), { bucketName: GRIDFS_BUCKETS.uploads });
  const parts: Buffer[] = [];
  return new Promise((resolve, reject) => {
    bucket
      .openDownloadStream(new ObjectId(fileId))
      .on('data', (c: Buffer) => parts.push(c))
      .on('error', reject)
      .on('end', () => resolve(Buffer.concat(parts)));
  });
}

/**
 * Read-your-write: query the vector index for the chunk we just wrote, using its own embedding as
 * the query (its nearest neighbour is itself, cosine≈1). Retry with backoff because the index is
 * eventually consistent — a fresh insert can take a beat to become searchable.
 */
async function probeIndexed(probe: ChunkDoc): Promise<void> {
  const chunks = await chunksCol();
  const maxTries = 20;
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    const hits = await chunks
      .aggregate<{ _id: string }>([
        {
          $vectorSearch: {
            index: SEARCH_INDEXES.chunksVector,
            path: 'embedding',
            queryVector: probe.embedding,
            numCandidates: 100,
            limit: 5,
            filter: { spaceId: probe.spaceId, userId: probe.userId }
          }
        },
        { $project: { _id: 1 } }
      ])
      .toArray();
    if (hits.some((h) => h._id === probe._id)) return;
    await sleep(Math.min(500 * attempt, 3000));
  }
  throw new Error('read-your-write probe failed: chunk not searchable after upsert');
}

async function processIndexDocument(job: JobDoc): Promise<void> {
  const docId = typeof job.payload.docId === 'string' ? job.payload.docId : null;
  if (!docId) throw new Error('index_document job has no docId in payload');

  const doc = await (await documentsCol()).findOne({ _id: docId });
  if (!doc) throw new Error(`document ${docId} not found`);

  // parse
  await patchDoc(docId, { status: 'parsing', pct: 10 });
  const buf = await gridfsRead(doc.fileId);
  const parsed = await parseDocument(buf, doc.mimeType);
  const specs = chunkSegments(parsed);
  if (specs.length === 0) throw new Error('no extractable text in document');

  // embed
  await patchDoc(docId, { status: 'embedding', pct: 50, ...(parsed.pageCount ? { pages: parsed.pageCount } : {}) });
  const vectors = await embedBatch(specs.map((s) => s.text));

  // upsert — delete-then-insert so a re-run (retry/sweep) is idempotent, never duplicated
  const chunks = await chunksCol();
  await chunks.deleteMany({ docId });
  const chunkDocs: ChunkDoc[] = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    const embedding = vectors[i];
    if (!embedding) throw new Error(`missing embedding for chunk ${i}`);
    chunkDocs.push({
      _id: `chk_${docId}_${spec.ord}`,
      docId,
      spaceId: doc.spaceId,
      userId: doc.userId,
      text: spec.text,
      locator: spec.locator,
      ord: spec.ord,
      embedding,
      createdAt: new Date()
    });
  }
  await chunks.insertMany(chunkDocs);

  // read-your-write probe, then — and only then — indexed
  await probeIndexed(chunkDocs[0]!);
  await patchDoc(docId, { status: 'indexed', pct: 100, chunks: chunkDocs.length });
  log.info({ docId, chunks: chunkDocs.length, pages: parsed.pageCount }, 'document indexed');
}

// ---------------------------------------------------------------- main loop

let stopping = false;

async function runOne(job: JobDoc): Promise<void> {
  try {
    if (job.kind === 'index_document') await processIndexDocument(job);
    else throw new Error(`unknown job kind ${job.kind}`);
    await (await jobsCol()).updateOne({ _id: job._id }, { $set: { status: 'done' } });
  } catch (e) {
    const error = errMsg(e);
    const jobs = await jobsCol();
    if (job.attempts >= MAX_ATTEMPTS) {
      // out of retries → fail the job AND its document, so the client's poll ends on `failed`.
      await jobs.updateOne({ _id: job._id }, { $set: { status: 'failed', error } });
      const docId = job.payload.docId;
      if (typeof docId === 'string') await patchDoc(docId, { status: 'failed', error });
      log.error({ jobId: job._id, error }, 'job failed permanently');
    } else {
      // transient (e.g. free-tier embed 429) → back to pending for another worker/pass.
      await jobs.updateOne({ _id: job._id }, { $set: { status: 'pending' }, $unset: { claimedAt: '', workerId: '' } });
      log.warn({ jobId: job._id, attempt: job.attempts, error }, 'job errored, will retry');
    }
  }
}

async function main(): Promise<void> {
  log.info({ workerId, mongoDb: env.mongoDb }, 'jobs worker up — polling for index_document jobs');
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { stopping = true; });

  while (!stopping) {
    try {
      await sweepStale();
      const job = await claim();
      if (!job) {
        await sleep(POLL_MS);
        continue;
      }
      await runOne(job);
    } catch (e) {
      // A loop-level error (usually Mongo unreachable) must not kill the worker — back off and retry.
      log.error({ error: errMsg(e) }, 'worker loop error; backing off');
      await sleep(POLL_MS * 3);
    }
  }
  log.info('jobs worker stopping');
}

void main();
