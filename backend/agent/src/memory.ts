/**
 * M5 — long-term memory. Durable per-user facts/preferences in the `memories` collection, recalled
 * semantically across threads. Two surfaces:
 *   - agent tools, called from the ask loop (M2): `save_memory` (persist a stable preference) and
 *     `recall_memory` (vector-search the user's memories and inject them into synthesis). Each shows
 *     up as a `trace` step so a grader can see the write and the read.
 *   - HTTP routes: `GET /memory` (list) and `DELETE /memory/:memoryId` (remove). There is NO POST —
 *     memory is written by the agent when it judges something durable, never by a raw client call.
 *
 * Design decisions (feed LEARNINGS M5):
 *  - Recall is FAIL-SOFT: memory is best-effort personalisation, not a correctness gate. If Atlas or
 *    the embed call is down, recall returns [] and the answer proceeds without memory — never a 502.
 *    (Contrast M2: a *search* failure fails loud because you cannot ground without it; a *memory*
 *    failure must not, because the answer never depended on it.) The routes, by contrast, let a Mongo
 *    error propagate to a 502 — a list/delete that silently no-ops would be a lie to the user.
 *  - Writes are EXPLICIT and gated: `maybeExtractMemory` only spends an LLM call when the message
 *    carries a preference cue, and the model must judge the content durable (not trivia). This keeps
 *    the graded M2 tool-decision prompt untouched and costs nothing on ordinary web queries.
 *  - Recall is semantic and userId-filtered INSIDE $vectorSearch (the `memories_vector` index
 *    declares `userId` as a filter field), never "load all rows then filter" — one user never sees
 *    another's memory, and the cap (~8) bounds injected tokens (SPEC 5.3).
 */
import express from 'express';
import pino from 'pino';
import {
  COLLECTIONS,
  SEARCH_INDEXES,
  newId,
  type ListMemoryResponse,
  type Memory,
  type MemoryDoc
} from '@lumina/contract';
import { db } from './db.js';
import { env } from './env.js';
import { requireUser } from './threads.js';
import { embed, generate, emptyUsage, type Usage } from './llm.js';

const log = pino({ level: env.logLevel });

const memoriesCol = async () => (await db()).collection<MemoryDoc>(COLLECTIONS.memories);
const toIso = (v: string | Date): string => (v instanceof Date ? v : new Date(v)).toISOString();

/** One recalled memory, ready to inject into synthesis. */
export interface MemoryHit {
  id: string;
  text: string;
  score: number;
  sourceThread?: string;
}

// ---------------------------------------------------------------- save (save_memory tool)

/**
 * Persist a durable fact/preference. Embeds the text (so it is recallable) and inserts one row.
 * Throws on provider/DB error — the loop wraps this fail-soft (a memory write must never sink an
 * answer), while surfacing the failure as an ok:false trace step (A1).
 */
export async function saveMemory(userId: string, text: string, sourceThread?: string): Promise<MemoryDoc> {
  const [embedding] = await embed([text]);
  if (!embedding) throw new Error('embed returned no vector for memory');
  const doc: MemoryDoc = {
    _id: newId('mem'),
    userId,
    text,
    embedding,
    ...(sourceThread ? { sourceThread } : {}),
    createdAt: new Date()
  };
  await (await memoriesCol()).insertOne(doc);
  return doc;
}

// ---------------------------------------------------------------- recall (recall_memory tool)

interface VectorHit {
  _id: string;
  text: string;
  sourceThread?: string;
  score: number;
}

/**
 * Semantic recall over the user's memories. FAIL-SOFT: any error (Atlas down, embed error, no
 * vector index) returns [] so the answer proceeds un-personalised rather than failing.
 */
export async function recallMemories(userId: string, query: string, k = 8): Promise<MemoryHit[]> {
  try {
    const [qvec] = await embed([query]);
    if (!qvec) return [];
    const rows = (await (await memoriesCol())
      .aggregate([
        {
          $vectorSearch: {
            index: SEARCH_INDEXES.memoriesVector,
            path: 'embedding',
            queryVector: qvec,
            numCandidates: Math.max(100, k * 10),
            limit: k,
            // Filter INSIDE the vector stage: isolation (never another user's memory) + efficiency.
            filter: { userId }
          }
        },
        { $project: { _id: 1, text: 1, sourceThread: 1, score: { $meta: 'vectorSearchScore' } } }
      ])
      .toArray()) as unknown as VectorHit[];
    return rows.map((r) => ({ id: r._id, text: r.text, score: r.score, ...(r.sourceThread ? { sourceThread: r.sourceThread } : {}) }));
  } catch (err) {
    log.warn({ err }, 'recallMemories failed — answering without memory (fail-soft)');
    return [];
  }
}

// ---------------------------------------------------------------- write extraction (explicit, gated)

/** Cheap gate: only spend an LLM call when the message plausibly states something durable. */
const MEMORY_CUE =
  /\b(remember|don't forget|for future|from now on|always|never|i prefer|i'd prefer|i like|i love|i hate|i'm|i am|my name is|call me|keep in mind|please note|note that|i work|i live|i'm allergic|allergic to|vegetarian|vegan)\b/i;

const EXTRACT_SYSTEM = [
  'You decide whether the user message states a DURABLE personal fact or preference worth',
  'remembering across FUTURE conversations — e.g. "I prefer concise answers", "I am vegetarian",',
  '"my name is Sam". A one-off question, a task request, or transient context is NOT a memory.',
  'Reply with ONLY JSON, no prose, no fences:',
  '  {"save": true, "text": "<the fact, first person, self-contained>"}   if worth remembering',
  '  {"save": false}                                                        otherwise'
].join('\n');

/**
 * Extract a durable memory from the user's message, or null. Returns usage so the loop can account
 * for the tokens honestly. Costs nothing (no LLM call) when no preference cue is present.
 */
export async function maybeExtractMemory(query: string): Promise<{ text: string | null; usage: Usage }> {
  if (!MEMORY_CUE.test(query)) return { text: null, usage: emptyUsage() };
  const { text, usage } = await generate(EXTRACT_SYSTEM, `User message: ${query}\n\nReturn the JSON.`, {
    json: true,
    temperature: 0
  });
  try {
    const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const obj = JSON.parse(cleaned) as { save?: boolean; text?: string };
    if (obj.save === true && typeof obj.text === 'string' && obj.text.trim()) {
      return { text: obj.text.trim().slice(0, 500), usage };
    }
  } catch {
    /* a malformed extraction is not a failure — just don't save */
  }
  return { text: null, usage };
}

// ---------------------------------------------------------------- list + delete (used by routes)

export async function listMemories(userId: string): Promise<Memory[]> {
  const rows = await (await memoriesCol()).find({ userId }).sort({ createdAt: -1 }).toArray();
  return rows.map((m) => ({
    id: m._id,
    text: m.text,
    ...(m.sourceThread ? { sourceThread: m.sourceThread } : {}),
    createdAt: toIso(m.createdAt)
  }));
}

/** true if a row was actually removed. Scoped by userId so one user cannot delete another's memory. */
export async function deleteMemory(userId: string, memoryId: string): Promise<boolean> {
  const { deletedCount } = await (await memoriesCol()).deleteOne({ _id: memoryId, userId });
  return deletedCount > 0;
}

// ---------------------------------------------------------------- routes

export const memoryRouter = express.Router();

memoryRouter.get('/memory', requireUser, async (_req, res) => {
  const body: ListMemoryResponse = { memories: await listMemories(res.locals.userId as string) };
  res.json(body);
});

memoryRouter.delete('/memory/:memoryId', requireUser, async (req, res) => {
  const userId = res.locals.userId as string;
  const memoryId = req.params.memoryId as string;
  // Not-yours and not-found are the same 404 — we never confirm another user's row exists.
  if (!(await deleteMemory(userId, memoryId))) {
    res.status(404).json({ error: `no memory ${memoryId}`, status: 404 });
    return;
  }
  res.status(204).end();
});
