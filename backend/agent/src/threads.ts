/**
 * M4 — Threads & messages. The conversation store, so a follow-up question can see the
 * turns that came before it (README Part 1, step 3). Pure MongoDB — no provider key
 * touches this file, which is exactly why it is buildable before the agent loop (M2).
 *
 * Three routes, all auth:true (contract ROUTES / PRD 7):
 *   POST /threads            create a thread            → 201 { threadId }
 *   GET  /threads            list this user's threads   → { threads: [...] }  (newest first)
 *   GET  /threads/:threadId  read one thread's messages → { threadId, title, messages }
 *
 * The fourth thread route, POST /threads/:threadId/ask, is the agent loop (M2) and stays
 * 501 until then. When it lands it appends its turns through appendMessage() below, so the
 * write path already has one home rather than being scattered through the loop.
 *
 * Decisions worth remembering (feeds LEARNINGS.md M4):
 *  - Every query is scoped by userId, not just _id. The gateway enforces that an X-User-Id
 *    is PRESENT (401); the agent independently enforces that the caller OWNS the row. A
 *    thread that isn't yours reads as 404, never 403 — we don't confirm it exists. The
 *    bench probes exactly this: `GET /threads/thr_nope` must be 404.
 *  - createdAt is stored as a native BSON Date (sortable, and what the {userId, createdAt}
 *    index is built on) and serialised to an ISO string on the way out — the DB document
 *    type allows string|Date, but every HTTP response type is a `.datetime()` string.
 *    Typing each response body as its contract type makes the compiler catch a stray Date.
 *  - Messages carry no `ord` field, so order is createdAt ascending with _id as a
 *    deterministic tie-breaker. A user turn and its answer are seconds apart (never tied),
 *    but the tie-breaker keeps a same-millisecond burst stable.
 */
import express from 'express';
import {
  COLLECTIONS,
  CreateThreadBody,
  USER_HEADER,
  newId,
  type CreateThreadResponse,
  type DoneEvent,
  type GetThreadResponse,
  type ListThreadsResponse,
  type MessageDoc,
  type Source,
  type SubQuestion,
  type ThreadDoc,
  type ThreadMessage
} from '@lumina/contract';
import { db } from './db.js';

const threadsCol = async () => (await db()).collection<ThreadDoc>(COLLECTIONS.threads);
const messagesCol = async () => (await db()).collection<MessageDoc>(COLLECTIONS.messages);

/** Messages reuse the readable prefixed-id scheme; the contract's newId has no 'msg' case. */
const newMessageId = () => `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** DB stores Date; HTTP wants an ISO string. One place to cross that boundary. */
const toIso = (v: string | Date): string => (v instanceof Date ? v : new Date(v)).toISOString();

/**
 * X-User-Id gate. The public gateway is what normally enforces this, but the agent
 * re-checks so a direct call (curl in dev, or a misconfigured proxy) can never read data
 * unscoped. Same 401 shape the gateway returns.
 */
export function requireUser(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  const userId = (req.header(USER_HEADER) ?? '').trim();
  if (!userId) {
    res.status(401).json({ error: 'X-User-Id header is required', status: 401 });
    return;
  }
  res.locals.userId = userId;
  next();
}

export const threadsRouter = express.Router();

threadsRouter.post('/threads', requireUser, async (req, res) => {
  // Same contract schema the gateway validates with — one definition, so no drift.
  const parsed = CreateThreadBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid body', status: 400 });
    return;
  }
  const doc: ThreadDoc = {
    _id: newId('thr'),
    userId: res.locals.userId as string,
    // Title is optional at create time; the ask loop (M2) can rename from the first query.
    title: parsed.data.title?.trim() || 'New thread',
    createdAt: new Date()
  };
  await (await threadsCol()).insertOne(doc);
  const body: CreateThreadResponse = { threadId: doc._id };
  res.status(201).json(body);
});

threadsRouter.get('/threads', requireUser, async (_req, res) => {
  const rows = await (await threadsCol())
    .find({ userId: res.locals.userId as string })
    .sort({ createdAt: -1 }) // newest first — matches the {userId:1, createdAt:-1} index
    .toArray();
  const body: ListThreadsResponse = {
    threads: rows.map((t) => ({ threadId: t._id, title: t.title, createdAt: toIso(t.createdAt) }))
  };
  res.json(body);
});

threadsRouter.get('/threads/:threadId', requireUser, async (req, res) => {
  const userId = res.locals.userId as string;
  const { threadId } = req.params;
  const thread = await (await threadsCol()).findOne({ _id: threadId, userId });
  if (!thread) {
    // Not-found and not-yours are the same answer on purpose: we don't leak existence.
    res.status(404).json({ error: `no thread ${threadId}`, status: 404 });
    return;
  }
  const messages = await (await messagesCol())
    .find({ threadId, userId })
    .sort({ createdAt: 1, _id: 1 })
    .toArray();
  const body: GetThreadResponse = {
    threadId: thread._id,
    title: thread.title,
    messages: messages.map(toThreadMessage)
  };
  res.json(body);
});

/** MessageDoc (DB shape) → ThreadMessage (wire shape). Drops _id/threadId/userId, ISO-ifies. */
function toThreadMessage(m: MessageDoc): ThreadMessage {
  return {
    role: m.role,
    content: m.content,
    sources: m.sources,
    answerId: m.answerId,
    done: m.done,
    createdAt: toIso(m.createdAt)
  };
}

/**
 * The write path M2 calls once per turn (user turn, then the assistant answer). Kept here
 * so "messages" has a single home and the read path above has something to read.
 */
export interface NewMessage {
  threadId: string;
  userId: string;
  role: 'user' | 'assistant';
  content: string;
  answerId?: string;
  sources?: Source[];
  done?: DoneEvent;
  subQuestions?: SubQuestion[];
}

export async function appendMessage(input: NewMessage): Promise<MessageDoc> {
  const doc: MessageDoc = {
    _id: newMessageId(),
    threadId: input.threadId,
    userId: input.userId,
    role: input.role,
    content: input.content,
    answerId: input.answerId,
    sources: input.sources ?? [],
    done: input.done,
    subQuestions: input.subQuestions,
    createdAt: new Date()
  };
  await (await messagesCol()).insertOne(doc);
  return doc;
}
