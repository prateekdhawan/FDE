/**
 * M2 — the quick search loop + SSE. This is the make-or-break core (20 pts): a hand-rolled
 * plan → pick tool → observe → repeat → answer loop, streamed as trace* → sources → token* →
 * done, with sources ALWAYS before the first token.
 *
 * Why hand-rolled and not an agent framework: the assignment grades the exact wire order, the
 * caps, the fail-loud behaviour and the grounding — all of which a framework hides behind its
 * own control flow. A loop you can read top to bottom is the point.
 *
 * Shape of this file: the loop is a PURE function, runQuickAnswer(query, emit, ctx), that knows
 * nothing about HTTP — it just calls emit() with contract events and returns the answer. The
 * Express route below is the thin transport shell: auth, validation, ownership, the SSE header
 * flush, persistence, and the fail-loud 502/error split. Separating them keeps the loop unit-
 * testable without a socket or a database.
 *
 * The four rules that decide the grade, all enforced here:
 *   1. Grounded or nothing — sources are the pages we fetched THIS request; synthesis may only
 *      cite [n] into that list, and we never answer with zero retrieval when a fetch is possible.
 *   2. Fail loud — an LLM/search provider exception propagates: 502 before the stream opens, or
 *      an `error` event once it has. Never a try/catch that returns a fake answer.
 *   3. Bounded & honest — quick caps (maxToolCalls / maxWallClockSec); hitting one ends the run
 *      terminated:"cap", never "done".
 *   4. plan_research is deep-only — this loop never offers it to the model.
 *
 * Deep search (depth:"deep") is M9; until then this route answers 501 for it, honestly.
 */
import express from 'express';
import pino from 'pino';
import {
  AskBody,
  COLLECTIONS,
  newId,
  type AskMode,
  type Depth,
  type DoneEvent,
  type Locator,
  type Source,
  type SubQuestion,
  type Terminated,
  type ThreadDoc,
  type TraceEvent
} from '@lumina/contract';
import { db } from './db.js';
import { env } from './env.js';
import { requireUser, appendMessage } from './threads.js';
import { sseHeaders, sseSend } from './sse.js';
import { addUsage, emptyUsage, estimateLlmCostUsd, generate, streamText, type Usage } from './llm.js';
import {
  fetchPage,
  groundedSnippet,
  SEARCH_COST_USD,
  type FetchedPage,
  type WebResult
} from './tools.js';
import { cachedSearch } from './searchCache.js';
import { recallMemories, saveMemory, maybeExtractMemory, type MemoryHit } from './memory.js';
import { searchDocuments, type DocHit } from './retrieval.js';
import { writeRunLog } from './runlog.js';

const log = pino({ level: env.logLevel });

/**
 * Softer per-tool caps than the hard AGENTS cap (maxToolCalls). Rationale: quality rule A3
 * fails >3 CONSECUTIVE calls of the same tool, and a quick answer needs at most a search or
 * two and a few pages — more just spends latency against the 12s answer SLA. Both stay well
 * under maxToolCalls (8).
 */
const MAX_SEARCHES = 2;
const MAX_FETCHES = 3;
/**
 * Pages read in ONE parallel batch. N concurrent fetches cost one fetch's wall-clock, not N —
 * the single biggest latency win here after cutting decision round-trips. Kept ≤ MAX_FETCHES so
 * a batch can never trip quality rule A3 (>3 consecutive same-tool calls).
 */
const FETCH_BATCH = 3;
/** How much of each page the model reads during synthesis. Bounds tokens/cost per answer. */
const READ_CHARS = 1800;
/**
 * How many document chunks a docs answer grounds on. 6 is the bench's `pageLocator` working set —
 * enough distinct passages to answer with page citations, few enough to stay inside the synthesis
 * token budget (each chunk is already ~1200 chars from the M7 chunker).
 */
const DOC_TOP_K = 6;
/**
 * Pages fetched per sub-question in a deep search. 2 keeps the fan-out affordable — with up to 6
 * sub-questions that is ≤6 searches + ≤12 fetches + 1 plan ≈ 19 tool calls, under the deep cap of
 * 24 — and, crucially, a batch of 2 can never trip A3 (>3 consecutive same-tool calls) because a
 * search always sits between one sub-question's fetches and the next's.
 */
const DEEP_FETCH_PER_SQ = 2;

/** A single frame emitter. The route wires this to SSE; a test wires it to an array. */
export type Emit = (event: 'plan' | 'trace' | 'sources' | 'token' | 'done', data: unknown) => void;

/** Thrown when the client hangs up mid-stream — not an error to 502, just a reason to stop. */
class AbortedError extends Error {}

interface Decision {
  action: 'web_search' | 'fetch_page' | 'answer';
  query?: string;
  /** For fetch_page: the result URLs to read, best first — read in one parallel batch. */
  urls?: string[];
  reason?: string;
}

/**
 * Mutable run state the loop fills in. Held by the caller so BOTH the success path and the
 * fail-loud catch can write a faithful run log (a provider error mid-loop still logged the
 * tool calls and tokens it spent up to the throw).
 */
export interface AskCtx {
  startedAt: number;
  firstTokenAt: number;
  trace: TraceEvent[];
  usage: Usage;
  searches: number;
  /** Searches that missed both cache tiers and hit the live provider — what we charge for and
   *  what makes `searchCached` false. `searches - cacheMisses` = cache hits this request. */
  cacheMisses: number;
  fetches: number;
  step: number;
  terminated: Terminated;
  /** Which gear is running. Governs the caps (quick vs deep) and labels the run log so the grader
   *  reads a deep run against the deep budget, not the quick one. */
  depth: Depth;
  /** Set on the HTTP path so memory can be recalled/saved for this user & thread. When absent
   *  (e.g. the M2 unit harness), memory is skipped entirely and the loop behaves identically. */
  userId?: string;
  threadId?: string;
  /** M8 routing: where to look ('auto' default) and which Space's documents to search over. */
  mode?: AskMode;
  spaceId?: string;
  isAborted: () => boolean;
}

export function newAskCtx(isAborted: () => boolean = () => false): AskCtx {
  return {
    startedAt: Date.now(),
    firstTokenAt: 0,
    trace: [],
    usage: emptyUsage(),
    searches: 0,
    cacheMisses: 0,
    fetches: 0,
    step: 0,
    terminated: 'done',
    depth: 'quick',
    isAborted
  };
}

// ---------------------------------------------------------------- the loop (pure, testable)

export async function runQuickAnswer(
  query: string,
  emit: Emit,
  ctx: AskCtx
): Promise<{ answer: string; sources: Source[]; done: DoneEvent }> {
  // Memory (M5) runs CONCURRENTLY with retrieval so its latency is hidden behind the seconds of
  // search + fetch: recall the user's durable prefs/facts, and — only if the message carries a
  // preference cue — extract a candidate memory to save. Both are best-effort; with no user (the
  // M2 unit harness) they resolve to empty and the loop is unchanged.
  const recallPromise: Promise<MemoryHit[]> = ctx.userId ? recallMemories(ctx.userId, query) : Promise.resolve([]);
  const extractPromise = ctx.userId ? maybeExtractMemory(query) : Promise.resolve({ text: null, usage: emptyUsage() });

  // ---- route: the web, or the Space's documents (M8) ------------------------------------
  // 'docs' → the Space's documents only; 'web' → the web; 'auto' → documents when a Space is
  // attached (falling back to the web if the Space turns up nothing relevant), else the web.
  // Depth is unchanged — this is still a quick answer, just over a different corpus.
  const useDocs = !!ctx.spaceId && (ctx.mode === 'docs' || ctx.mode === 'auto');
  let sources: Source[] = [];
  let readable: Readable[] = [];

  if (useDocs && ctx.spaceId) {
    if (ctx.mode === 'docs') {
      // docs-only: a retrieval failure is fail-loud — we cannot ground a docs answer without it.
      ({ sources, readable } = fromDocHits(await runDocRetrieval(query, ctx.spaceId, { emit, ctx })));
    } else {
      // auto + Space: try the documents first; on empty OR error, fall back to the web (fail-soft).
      let hits: DocHit[] = [];
      try {
        hits = await runDocRetrieval(query, ctx.spaceId, { emit, ctx });
      } catch {
        hits = []; // runDocRetrieval already emitted the ok:false trace; degrade to web
      }
      ({ sources, readable } = hits.length
        ? fromDocHits(hits)
        : fromWebPages(await runWebRetrieval(query, { emit, ctx })));
    }
  } else {
    ({ sources, readable } = fromWebPages(await runWebRetrieval(query, { emit, ctx })));
  }

  if (ctx.isAborted()) throw new AbortedError();

  // ---- resolve memory before synthesis ---------------------------------------------------
  // A save is a pure side effect (trace only). Recalled memories are injected into the synthesis
  // prompt to shape tone/preferences — never as citable [n] sources (they are not retrieved pages).
  const extracted = await extractPromise;
  ctx.usage = addUsage(ctx.usage, extracted.usage);
  if (ctx.userId && extracted.text) await runSaveMemory(extracted.text, { emit, ctx });

  const recallStart = Date.now();
  const recalled = await recallPromise;
  if (recalled.length) {
    ctx.step++;
    const ev: TraceEvent = {
      step: ctx.step,
      tool: 'recall_memory',
      input: { query },
      ok: true,
      ms: Date.now() - recallStart,
      reason: `recalled ${recalled.length} memory item(s)`
    };
    ctx.trace.push(ev);
    emit('trace', ev);
  }

  // ---- sources BEFORE the first token (the contract's hard ordering rule) ----------------
  emit('sources', sources);

  // ---- synthesis: stream the grounded answer ---------------------------------------------
  const { text: answer, usage: synthUsage } = await streamText(
    synthesisSystem(sources.length, recalled.length),
    synthesisUser(query, readable, recalled),
    (t) => {
      if (!ctx.firstTokenAt) ctx.firstTokenAt = Date.now();
      emit('token', { text: t });
    }
  );
  ctx.usage = addUsage(ctx.usage, synthUsage);

  // ---- done ------------------------------------------------------------------------------
  const now = Date.now();
  const done: DoneEvent = {
    answerId: newId('ans'),
    latencyMs: now - ctx.startedAt,
    ttftMs: (ctx.firstTokenAt || now) - ctx.startedAt,
    model: env.llmModel,
    tokens: { in: ctx.usage.inTokens, out: ctx.usage.outTokens },
    // Charge only LIVE searches (cache misses) — a cache hit made no provider call. This is the
    // whole economic point of M3 and what the bench's no-cache cost projection compares against.
    costUsd: estimateLlmCostUsd(ctx.usage) + ctx.cacheMisses * SEARCH_COST_USD,
    // All-or-nothing (SPEC 5.2): true only if there was a search AND every search was a cache hit.
    searchCached: ctx.searches > 0 && ctx.cacheMisses === 0,
    terminated: ctx.terminated,
    depth: 'quick'
  };
  emit('done', done);
  return { answer, sources, done };
}

// ---------------------------------------------------------------- the deep loop (M9, pure)

/**
 * Deep search: plan → fan-out → merge → synthesise. The decomposition IS the feature, so a `plan`
 * event streams FIRST (before any retrieval); then each sub-question is researched with a
 * deterministic search+fetch fan-out — NO per-sub-question LLM call, because on a slow provider that
 * would blow the wall clock, and the model's judgement was already spent deciding WHAT to research.
 * Every result set merges into ONE citation numbering so [n] means the same thing across the whole
 * answer, and every trace/source carries its sub-question index so the plan stays legible.
 *
 * Just 2 LLM calls regardless of breadth — the plan and the synthesis — matching the quick loop's
 * minimalism. Caps are the DEEP budget; a run that trips them stops early and reports terminated
 * 'cap' (never a "done" that quietly ran out of room).
 */
export async function runDeepAnswer(
  query: string,
  emit: Emit,
  ctx: AskCtx
): Promise<{ answer: string; sources: Source[]; done: DoneEvent; subQuestions: SubQuestion[] }> {
  const overCap = () =>
    Date.now() - ctx.startedAt >= env.maxWallClockSecDeep * 1000 || ctx.step >= env.maxToolCallsDeep;

  // Memory runs concurrently with planning + fan-out, exactly as in the quick loop.
  const recallPromise: Promise<MemoryHit[]> = ctx.userId ? recallMemories(ctx.userId, query) : Promise.resolve([]);
  const extractPromise = ctx.userId ? maybeExtractMemory(query) : Promise.resolve({ text: null, usage: emptyUsage() });

  // ---- plan: decompose, then stream the plan BEFORE any retrieval -------------------------
  if (ctx.isAborted()) throw new AbortedError();
  const planStart = Date.now();
  const plan = await planResearch(query);
  ctx.usage = addUsage(ctx.usage, plan.usage);

  // The plan event comes first (contract order: plan → trace* → sources → token* → done)...
  emit('plan', { subQuestions: plan.subQuestions, ...(plan.reason ? { reason: plan.reason } : {}) });
  // ...then the plan_research tool's own trace step, so it lands in the run log's toolCalls.
  ctx.step++;
  const planTrace: TraceEvent = {
    step: ctx.step,
    tool: 'plan_research',
    input: { query },
    ok: true,
    ms: Date.now() - planStart,
    reason: `decomposed into ${plan.subQuestions.length} sub-question(s)`
  };
  ctx.trace.push(planTrace);
  emit('trace', planTrace);

  // ---- fan out: research each sub-question (deterministic search + parallel fetch) ---------
  const fetchedUrls = new Set<string>();
  const tagged: { page: FetchedPage; subQuestion: number }[] = [];
  for (const sq of plan.subQuestions) {
    if (ctx.isAborted()) throw new AbortedError();
    if (overCap()) {
      ctx.terminated = 'cap';
      break;
    }
    const pages = await researchSubQuestion(sq, { emit, ctx, fetchedUrls, overCap });
    for (const page of pages) tagged.push({ page, subQuestion: sq.i });
  }

  if (ctx.isAborted()) throw new AbortedError();

  // ---- resolve memory (save is a side effect; recall shapes tone, never a citation) -------
  const extracted = await extractPromise;
  ctx.usage = addUsage(ctx.usage, extracted.usage);
  if (ctx.userId && extracted.text) await runSaveMemory(extracted.text, { emit, ctx });
  const recallStart = Date.now();
  const recalled = await recallPromise;
  if (recalled.length) {
    ctx.step++;
    const ev: TraceEvent = {
      step: ctx.step,
      tool: 'recall_memory',
      input: { query },
      ok: true,
      ms: Date.now() - recallStart,
      reason: `recalled ${recalled.length} memory item(s)`
    };
    ctx.trace.push(ev);
    emit('trace', ev);
  }

  // ---- merge every sub-question's results into ONE numbering, then synthesise -------------
  const { sources, readable } = mergeDeepSources(tagged);
  emit('sources', sources);

  const { text: answer, usage: synthUsage } = await streamText(
    synthesisSystem(sources.length, recalled.length, 'deep'),
    synthesisUser(query, readable, recalled),
    (t) => {
      if (!ctx.firstTokenAt) ctx.firstTokenAt = Date.now();
      emit('token', { text: t });
    }
  );
  ctx.usage = addUsage(ctx.usage, synthUsage);

  const now = Date.now();
  const done: DoneEvent = {
    answerId: newId('ans'),
    latencyMs: now - ctx.startedAt,
    ttftMs: (ctx.firstTokenAt || now) - ctx.startedAt,
    model: env.llmModel,
    tokens: { in: ctx.usage.inTokens, out: ctx.usage.outTokens },
    costUsd: estimateLlmCostUsd(ctx.usage) + ctx.cacheMisses * SEARCH_COST_USD,
    searchCached: ctx.searches > 0 && ctx.cacheMisses === 0,
    terminated: ctx.terminated,
    depth: 'deep',
    subQuestions: plan.subQuestions.length
  };
  emit('done', done);
  return { answer, sources, done, subQuestions: plan.subQuestions };
}

/**
 * Research one sub-question: one cached web_search, then read up to DEEP_FETCH_PER_SQ NEW pages in
 * one parallel batch. No decision LLM call — the fan-out is deterministic. The shared `fetchedUrls`
 * set means a URL already read for an earlier sub-question is skipped, so the merged source list
 * stays de-duplicated. Returns the pages fetched for THIS sub-question.
 */
async function researchSubQuestion(
  sq: SubQuestion,
  s: { emit: Emit; ctx: AskCtx; fetchedUrls: Set<string>; overCap: () => boolean }
): Promise<FetchedPage[]> {
  const { emit, ctx, fetchedUrls, overCap } = s;
  const searchResults: WebResult[] = [];
  // Search failure is a provider exception → fail loud (runSearch lets it throw).
  await runSearch(sq.question, `sub-question ${sq.i}`, { emit, ctx, searchResults, subQuestion: sq.i });
  if (overCap()) {
    ctx.terminated = 'cap';
    return [];
  }
  const urls = searchResults
    .filter((r) => !fetchedUrls.has(r.url))
    .slice(0, DEEP_FETCH_PER_SQ)
    .map((r) => r.url);
  if (!urls.length) return [];
  const fetched: FetchedPage[] = [];
  await runFetchBatch(urls, `sub-question ${sq.i}`, { emit, ctx, fetched, fetchedUrls, subQuestion: sq.i });
  return fetched;
}

/** Merge the per-sub-question pages into one [n] numbering; each source records its sub-question. */
function mergeDeepSources(tagged: { page: FetchedPage; subQuestion: number }[]): {
  sources: Source[];
  readable: Readable[];
} {
  const sources: Source[] = tagged.map(({ page, subQuestion }, i) => ({
    n: i + 1,
    kind: 'web' as const,
    title: page.title.slice(0, 300) || page.url,
    snippet: groundedSnippet(page),
    url: page.url,
    subQuestion
  }));
  const readable: Readable[] = tagged.map(({ page }, i) => ({
    n: i + 1,
    label: `${page.title} (${page.url})`,
    text: page.text
  }));
  return { sources, readable };
}

// ---------------------------------------------------------------- tool execution (shared)

/**
 * Run one web_search THROUGH the two-tier cache (M3): a cache hit skips the provider entirely and
 * is charged nothing. Append de-duped results, count it, emit its trace step. A provider exception
 * (only ever on a live miss) propagates (fail loud) — we cannot ground an answer with no search.
 */
async function runSearch(
  query: string,
  reason: string | undefined,
  s: { emit: Emit; ctx: AskCtx; searchResults: WebResult[]; subQuestion?: number }
): Promise<void> {
  s.ctx.step++;
  const t0 = Date.now();
  const { results, cached } = await cachedSearch(query);
  s.ctx.searches++;
  if (!cached) s.ctx.cacheMisses++;
  for (const r of results) if (!s.searchResults.some((x) => x.url === r.url)) s.searchResults.push(r);
  const ev: TraceEvent = {
    step: s.ctx.step,
    tool: 'web_search',
    input: { query },
    ok: true,
    ms: Date.now() - t0,
    reason,
    ...(s.subQuestion ? { subQuestion: s.subQuestion } : {})
  };
  s.ctx.trace.push(ev);
  s.emit('trace', ev);
}

/**
 * Read the chosen pages CONCURRENTLY: N fetches cost one fetch's wall-clock, not N. Each page
 * gets its own trace step in input order — ok:true, or ok:false + error (contract rule A1) for a
 * 404 / paywall / timeout, which is a normal observation, never a reason to fail the run.
 */
async function runFetchBatch(
  urls: string[],
  reason: string | undefined,
  s: { emit: Emit; ctx: AskCtx; fetched: FetchedPage[]; fetchedUrls: Set<string>; subQuestion?: number }
): Promise<void> {
  const batch = urls.filter((u) => !s.fetchedUrls.has(u));
  for (const u of batch) s.fetchedUrls.add(u);
  const settled = await Promise.all(
    batch.map(async (url) => {
      const t0 = Date.now();
      try {
        return { url, page: await fetchPage(url), ms: Date.now() - t0, error: null as string | null };
      } catch (err) {
        return { url, page: null, ms: Date.now() - t0, error: err instanceof Error ? err.message : 'fetch failed' };
      }
    })
  );
  for (const r of settled) {
    s.ctx.step++;
    s.ctx.fetches++;
    if (r.page) s.fetched.push(r.page);
    const ev: TraceEvent = {
      step: s.ctx.step,
      tool: 'fetch_page',
      input: { url: r.url },
      ok: r.page != null,
      ms: r.ms,
      ...(r.error ? { error: r.error } : {}),
      reason,
      ...(s.subQuestion ? { subQuestion: s.subQuestion } : {})
    };
    s.ctx.trace.push(ev);
    s.emit('trace', ev);
  }
}

/**
 * Persist an extracted durable memory and emit its save_memory trace step. FAIL-SOFT: a write
 * failure records an ok:false trace (with error — rule A1) but never throws — a memory write must
 * not sink an otherwise-good answer. Only called after ctx.userId + text are confirmed present.
 */
async function runSaveMemory(text: string, s: { emit: Emit; ctx: AskCtx }): Promise<void> {
  s.ctx.step++;
  const t0 = Date.now();
  const input = { text: text.slice(0, 200) };
  let ev: TraceEvent;
  try {
    await saveMemory(s.ctx.userId!, text, s.ctx.threadId);
    ev = { step: s.ctx.step, tool: 'save_memory', input, ok: true, ms: Date.now() - t0 };
  } catch (err) {
    ev = {
      step: s.ctx.step,
      tool: 'save_memory',
      input,
      ok: false,
      ms: Date.now() - t0,
      error: err instanceof Error ? err.message : 'save_memory failed'
    };
  }
  s.ctx.trace.push(ev);
  s.emit('trace', ev);
}

// ---------------------------------------------------------------- retrieval arms (web · docs)

/**
 * The WEB arm (M2): a deterministic seed search, then a bounded observe→decide→act loop that reads
 * the model-chosen pages in ONE parallel batch. Returns the fetched pages for synthesis.
 *
 * The first move is ALWAYS a search — there is nothing else to do with an empty context — so we run
 * it deterministically rather than spend an LLM round-trip whose only legal output is "search"; on a
 * slow provider each avoided decision call is seconds off the TTFT. The loop is bounded by the
 * DECISION count, not just the tool cap: the sequential round-trips ARE the latency, so we spend as
 * few as the answer needs. A search provider exception propagates (fail loud); a per-page fetch
 * error is a normal ok:false observation, never a reason to fail the run.
 */
async function runWebRetrieval(query: string, s: { emit: Emit; ctx: AskCtx }): Promise<FetchedPage[]> {
  const { emit, ctx } = s;
  const overCap = () =>
    Date.now() - ctx.startedAt >= env.maxWallClockSec * 1000 || ctx.step >= env.maxToolCalls;
  const searchResults: WebResult[] = [];
  const fetched: FetchedPage[] = [];
  const fetchedUrls = new Set<string>();

  if (ctx.isAborted()) throw new AbortedError();
  await runSearch(query, undefined, { emit, ctx, searchResults });

  let decisionsLeft = 2;
  while (decisionsLeft-- > 0) {
    if (ctx.isAborted()) throw new AbortedError();
    if (overCap()) {
      ctx.terminated = 'cap';
      break;
    }

    const { decision, usage } = await decideNext(query, searchResults, fetched, {
      searchesLeft: MAX_SEARCHES - ctx.searches,
      fetchesLeft: MAX_FETCHES - ctx.fetches
    });
    ctx.usage = addUsage(ctx.usage, usage);

    const action = resolveAction(decision, {
      searchResults,
      fetched,
      searches: ctx.searches,
      fetches: ctx.fetches,
      fetchedUrls
    });

    if (action.kind === 'answer') break;
    if (action.kind === 'web_search') {
      if (overCap()) {
        ctx.terminated = 'cap';
        break;
      }
      // Search failure is a provider exception → fail loud (runSearch lets it throw).
      await runSearch(action.query, action.reason, { emit, ctx, searchResults });
      continue; // re-decide against the new results
    }
    // fetch_page: read the chosen pages in ONE parallel batch, then synthesise. A quick answer
    // does not loop back to re-read — the judgement it needed was which pages to open.
    await runFetchBatch(action.urls, action.reason, { emit, ctx, fetched, fetchedUrls });
    break;
  }
  return fetched;
}

/**
 * The DOCUMENT arm (M8): the `search_documents` tool — hybrid vector+text retrieval over the Space's
 * indexed chunks (retrieval.ts), returning the top hits with page/line locators. Emits ONE trace
 * step. On error it records the ok:false step (rule A1) and RETHROWS — the caller decides whether
 * that is fail-loud (docs mode) or a fall-back to the web (auto mode).
 */
async function runDocRetrieval(
  query: string,
  spaceId: string,
  s: { emit: Emit; ctx: AskCtx }
): Promise<DocHit[]> {
  const { emit, ctx } = s;
  ctx.step++;
  const t0 = Date.now();
  const input = { query, spaceId };
  try {
    const hits = await searchDocuments(query, spaceId, ctx.userId!, DOC_TOP_K);
    const ev: TraceEvent = {
      step: ctx.step,
      tool: 'search_documents',
      input,
      ok: true,
      ms: Date.now() - t0,
      reason: `retrieved ${hits.length} chunk(s)`
    };
    ctx.trace.push(ev);
    emit('trace', ev);
    return hits;
  } catch (err) {
    const ev: TraceEvent = {
      step: ctx.step,
      tool: 'search_documents',
      input,
      ok: false,
      ms: Date.now() - t0,
      error: err instanceof Error ? err.message : 'search_documents failed'
    };
    ctx.trace.push(ev);
    emit('trace', ev);
    throw err;
  }
}

/**
 * A numbered passage the synthesiser can cite as [n], source-agnostic: `label` is the human header
 * (page URL, or doc title + locator) and `text` is the material to ground on. Web and doc arms both
 * produce these so synthesis and [n] grounding are identical regardless of where the answer came from.
 */
interface Readable {
  n: number;
  label: string;
  text: string;
}

/** Build the emitted `web` Sources + synthesis passages from fetched pages. */
function fromWebPages(fetched: FetchedPage[]): { sources: Source[]; readable: Readable[] } {
  const sources: Source[] = fetched.map((p, i) => ({
    n: i + 1,
    kind: 'web' as const,
    title: p.title.slice(0, 300) || p.url,
    snippet: groundedSnippet(p),
    url: p.url
  }));
  const readable: Readable[] = fetched.map((p, i) => ({
    n: i + 1,
    label: `${p.title} (${p.url})`,
    text: p.text
  }));
  return { sources, readable };
}

/**
 * Build the emitted `doc` Sources + synthesis passages from document hits. Each Source carries the
 * `docId` + `locator` (page/line) the bench's `pageLocator` check and the UI both need to point back
 * at the exact place in the document; the numbering is shared with the synthesis passages so [n]
 * resolves the same way it does for web answers.
 */
function fromDocHits(hits: DocHit[]): { sources: Source[]; readable: Readable[] } {
  const sources: Source[] = hits.map((h, i) => ({
    n: i + 1,
    kind: 'doc' as const,
    title: h.title.slice(0, 300) || h.docId,
    snippet: docSnippet(h.text) || h.title || h.docId,
    docId: h.docId,
    locator: h.locator
  }));
  const readable: Readable[] = hits.map((h, i) => ({
    n: i + 1,
    label: `${h.title}${locatorLabel(h.locator)}`,
    text: h.text
  }));
  return { sources, readable };
}

/** First ~40 words of a chunk, for the doc Source card snippet (contract requires min length 1). */
function docSnippet(text: string, words = 40): string {
  return text.trim().split(/\s+/).slice(0, words).join(' ');
}

/** Render a locator as a compact source suffix: " — p.3", " — Heading", or " — line 42". */
function locatorLabel(loc: Locator): string {
  if (loc.page != null) return ` — p.${loc.page}`;
  if (loc.heading) return ` — ${loc.heading}`;
  if (loc.line != null) return ` — line ${loc.line}`;
  return '';
}

// ---------------------------------------------------------------- the route (transport shell)

export const askRouter = express.Router();

askRouter.post('/threads/:threadId/ask', requireUser, async (req, res) => {
  const userId = res.locals.userId as string;
  const threadId = req.params.threadId as string;

  // Validate before opening any stream, so these stay clean HTTP status codes.
  const parsed = AskBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid body', status: 400 });
    return;
  }
  const { query, depth, mode, spaceId } = parsed.data;

  // docs mode is meaningless without a Space to search — reject before opening a stream. ('auto'
  // needs no Space: it just searches the web.) Isolation is enforced inside retrieval, not here:
  // searchDocuments filters chunks by userId INSIDE the search stage, so a foreign/absent spaceId
  // can only ever return nothing — never another user's chunks — which is why no ownership 404 is
  // needed on this route.
  if (mode === 'docs' && !spaceId) {
    res.status(400).json({ error: "mode 'docs' requires a spaceId", status: 400 });
    return;
  }

  // Deep search is the expensive gear, and the AGENT is the only enforcer of its per-user daily
  // cap (the gateway holds no state). Over the cap → 429 with when it resets, before any work or
  // stream. If the count query itself fails we let it throw → 502 (we won't allow unbounded deep
  // when we can't verify the budget).
  if (depth === 'deep') {
    const used = await deepRunsToday(userId);
    if (used >= env.deepDailyCap) {
      res.status(429).json({
        error: `deep search daily limit reached (${env.deepDailyCap}/day)`,
        resetsAt: nextUtcMidnight(),
        status: 429
      });
      return;
    }
  }

  // Ownership, same as the read routes: not-yours and not-found are the same 404.
  const threads = (await db()).collection<ThreadDoc>(COLLECTIONS.threads);
  const thread = await threads.findOne({ _id: threadId, userId });
  if (!thread) {
    res.status(404).json({ error: `no thread ${threadId}`, status: 404 });
    return;
  }

  // The one correlation id for this request — adopted from the gateway or minted, and already set
  // on the response header, by the requestContext middleware (M11). Reading it (rather than
  // re-deriving) guarantees the run log, the requests row and the x-request-id header all agree,
  // even on a direct call with no inbound header. The bench requires the response to carry it.
  const requestId = String(res.locals.requestId);

  // The user turn joins the thread the moment it is asked (so a follow-up sees it), and the
  // first question names an untitled thread (threads.ts anticipated this).
  await appendMessage({ threadId, userId, role: 'user', content: query });
  if (thread.title === 'New thread') {
    await threads.updateOne({ _id: threadId, userId }, { $set: { title: query.slice(0, 80) } });
  }

  // Headers flush lazily on the first event, so a provider exception on the very first decision
  // can still return a real 502 instead of a 200 stream carrying an error.
  let streamStarted = false;
  const emit: Emit = (event, data) => {
    if (!streamStarted) {
      sseHeaders(res);
      streamStarted = true;
    }
    sseSend(res, event, data);
  };

  const ctx = newAskCtx(() => !res.writableEnded && res.destroyed);
  ctx.userId = userId;
  ctx.threadId = threadId;
  ctx.mode = mode;
  ctx.spaceId = spaceId;
  ctx.depth = depth;

  try {
    let result: { answer: string; sources: Source[]; done: DoneEvent };
    let subQuestions: SubQuestion[] | undefined;
    if (depth === 'deep') {
      const deep = await runDeepAnswer(query, emit, ctx);
      result = deep;
      subQuestions = deep.subQuestions;
    } else {
      result = await runQuickAnswer(query, emit, ctx);
    }
    res.end();
    persist({
      requestId,
      query,
      threadId,
      userId,
      answer: result.answer,
      done: result.done,
      sources: result.sources,
      trace: ctx.trace,
      usage: ctx.usage,
      subQuestions
    });
  } catch (err) {
    if (err instanceof AbortedError) return; // client hung up — nothing to report
    const message = err instanceof Error ? err.message : 'agent error';
    ctx.terminated = 'error';
    log.error({ err, requestId }, 'ask failed');
    if (!streamStarted) {
      res.status(502).json({ error: message, status: 502 });
    } else if (!res.writableEnded) {
      sseSend(res, 'error', { status: 502, error: message });
      res.end();
    }
    // An errored run is honest and non-"done" → runs/failing/ (never relabelled as done).
    writeRunLogSafe(runLogFrom(requestId, query, ctx));
  }
});

// ---------------------------------------------------------------- decision step

async function decideNext(
  query: string,
  searchResults: WebResult[],
  fetched: FetchedPage[],
  budget: { searchesLeft: number; fetchesLeft: number }
): Promise<{ decision: Decision; usage: Usage }> {
  const { text, usage } = await generate(decisionSystem(budget), decisionUser(query, searchResults, fetched), {
    json: true,
    temperature: 0
  });
  return { decision: parseDecision(text), usage };
}

function parseDecision(text: string): Decision {
  try {
    const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const obj = JSON.parse(cleaned) as Partial<Decision> & { url?: string };
    if (obj.action === 'web_search' || obj.action === 'fetch_page' || obj.action === 'answer') {
      // Accept both {"urls":[...]} and a single {"url":"..."} — models emit either shape.
      const urls = Array.isArray(obj.urls)
        ? obj.urls.filter((u): u is string => typeof u === 'string')
        : typeof obj.url === 'string'
          ? [obj.url]
          : undefined;
      return { action: obj.action, query: obj.query, urls, reason: obj.reason };
    }
  } catch {
    /* fall through */
  }
  // A malformed decision is not a provider failure; default to "answer" and let the grounding
  // override below turn it into the fetch it should have been if we retrieved nothing.
  return { action: 'answer', reason: 'model returned an unparseable decision' };
}

// ---------------------------------------------------------------- plan step (deep, M9)

/**
 * Ask the model to decompose the question into focused, non-overlapping sub-questions — the ONE
 * planning LLM call of a deep search. A planning hiccup (unparseable output, or fewer than two
 * usable sub-questions) falls back to a deterministic 3-facet decomposition rather than failing
 * the run: the deep search still runs, just on a generic plan.
 */
async function planResearch(
  query: string
): Promise<{ subQuestions: SubQuestion[]; usage: Usage; reason?: string }> {
  const { text, usage } = await generate(
    planSystem(env.deepSubQuestionsMin, env.deepSubQuestionsMax),
    planUser(query),
    { json: true, temperature: 0.2 }
  );
  const { subQuestions, reason } = parsePlan(text, query, env.deepSubQuestionsMax);
  return { subQuestions, usage, reason };
}

function parsePlan(text: string, query: string, max: number): { subQuestions: SubQuestion[]; reason?: string } {
  try {
    const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const obj = JSON.parse(cleaned) as { subQuestions?: unknown; reason?: unknown };
    const raw = Array.isArray(obj.subQuestions) ? obj.subQuestions : [];
    const subQuestions: SubQuestion[] = raw
      .map((s) => {
        const question =
          typeof s === 'string'
            ? s
            : typeof (s as { question?: unknown })?.question === 'string'
              ? (s as { question: string }).question
              : '';
        const r = (s as { reason?: unknown })?.reason;
        return { question: question.trim(), reason: typeof r === 'string' ? r : undefined };
      })
      .filter((s) => s.question.length > 0)
      .slice(0, max)
      .map((s, i) => ({ i: i + 1, question: s.question, ...(s.reason ? { reason: s.reason } : {}) }));
    if (subQuestions.length >= 2) {
      return { subQuestions, reason: typeof obj.reason === 'string' ? obj.reason : undefined };
    }
  } catch {
    /* fall through to the deterministic fallback */
  }
  return { subQuestions: fallbackPlan(query), reason: 'planner output unusable; used a generic decomposition' };
}

/** A generic 3-facet decomposition when the planner fails — always contract-valid (≥2 sub-questions). */
function fallbackPlan(query: string): SubQuestion[] {
  return [
    { i: 1, question: query, reason: 'the question as asked' },
    { i: 2, question: `background and key context for: ${query}`, reason: 'establish the context' },
    { i: 3, question: `recent developments and differing views on: ${query}`, reason: 'currency and balance' }
  ];
}

const planSystem = (min: number, max: number) =>
  [
    "You are LUMINA's research planner. Break the user's question into focused, NON-overlapping",
    'sub-questions that together fully answer it.',
    `Return between ${min} and ${max} sub-questions.`,
    'Each must be independently searchable on the web and cover a DISTINCT facet (definitions,',
    'causes, comparisons, specific entities, recent developments, counter-arguments, etc.).',
    'Return STRICT JSON only, no prose outside it:',
    '{"subQuestions":[{"question":"...","reason":"why this facet matters"}],"reason":"one line on the overall approach"}'
  ].join('\n');

const planUser = (query: string) => `Question: ${query}\n\nReturn the research plan as JSON.`;

/**
 * Turn the model's wish into a legal action, enforcing grounding and the tool budgets. This is
 * where "never answer with nothing retrieved" and the caps actually bite. fetch_page resolves to
 * a LIST of URLs so the loop can read them in one parallel batch.
 */
type ResolvedAction =
  | { kind: 'web_search'; query: string; reason?: string }
  | { kind: 'fetch_page'; urls: string[]; reason?: string }
  | { kind: 'answer' };

function resolveAction(
  decision: Decision,
  state: {
    searchResults: WebResult[];
    fetched: FetchedPage[];
    searches: number;
    fetches: number;
    fetchedUrls: Set<string>;
  }
): ResolvedAction {
  const unfetched = state.searchResults.filter((r) => !state.fetchedUrls.has(r.url)).map((r) => r.url);
  const fetchesLeft = MAX_FETCHES - state.fetches;
  const canSearch = state.searches < MAX_SEARCHES;

  let { action } = decision;

  // Grounding override: refuse to answer with nothing fetched while a page is still fetchable.
  if (action === 'answer' && state.fetched.length === 0 && fetchesLeft > 0 && unfetched.length > 0) {
    action = 'fetch_page';
  }

  if (action === 'web_search') {
    if (canSearch) {
      return {
        kind: 'web_search',
        query: (decision.query || '').trim().slice(0, 400) || fallbackQuery(state),
        reason: decision.reason
      };
    }
    // Out of search budget: read what we already found, or answer if there is nothing to read.
    action = 'fetch_page';
  }

  if (action === 'fetch_page') {
    const urls = pickFetchUrls(decision, unfetched, fetchesLeft);
    return urls.length ? { kind: 'fetch_page', urls, reason: decision.reason } : { kind: 'answer' };
  }

  return { kind: 'answer' };
}

/**
 * Which pages to read: the model's picks that are real, unfetched result URLs FIRST (best-first
 * judgement preserved), topped up with the next best-ranked results — a parallel batch makes the
 * extra pages free in wall-clock and they lift grounding/recall — capped to batch size and budget.
 */
function pickFetchUrls(decision: Decision, unfetched: string[], fetchesLeft: number): string[] {
  const cap = Math.max(0, Math.min(FETCH_BATCH, fetchesLeft));
  const allow = new Set(unfetched);
  const chosen: string[] = [];
  for (const u of decision.urls ?? []) if (allow.has(u) && !chosen.includes(u)) chosen.push(u);
  for (const u of unfetched) {
    if (chosen.length >= cap) break;
    if (!chosen.includes(u)) chosen.push(u);
  }
  return chosen.slice(0, cap);
}

// A search override needs a query even if the model gave none; reuse its own last search text.
const fallbackQuery = (state: { searchResults: WebResult[] }) => state.searchResults[0]?.title ?? 'search';

// ---------------------------------------------------------------- prompts

const decisionSystem = (budget: { searchesLeft: number; fetchesLeft: number }) =>
  [
    "You are LUMINA's quick web-search agent. A web search has ALREADY run; its results are shown.",
    'Decide the SINGLE next action. Reply with ONLY a JSON object, no prose, no fences:',
    '  {"action":"fetch_page","urls":["...","..."],"reason":"..."}  read these result pages (fetched in parallel)',
    '  {"action":"web_search","query":"...","reason":"..."}         results are poor — search again, better query',
    '  {"action":"answer","reason":"..."}                            fetched pages already answer the question',
    'Rules:',
    '- Prefer fetch_page: choose the 1-3 result URLs most likely to answer the question, best first.',
    '- NEVER answer from search snippets alone — answer only from pages that have been fetched.',
    '- Use web_search only if the current results clearly cannot answer the question.',
    `- Budget left this run: ${budget.searchesLeft} search(es), ${budget.fetchesLeft} fetch(es).`,
    '- "reason" is one short clause: why this step.'
  ].join('\n');

function decisionUser(query: string, searchResults: WebResult[], fetched: FetchedPage[]): string {
  const parts = [`Question: ${query}`, ''];
  if (!searchResults.length && !fetched.length) {
    parts.push('You have gathered nothing yet.');
  }
  if (searchResults.length) {
    parts.push('Search results:');
    searchResults.forEach((r, i) => {
      parts.push(`[${i + 1}] ${r.title}`);
      parts.push(`    ${r.url}`);
      if (r.snippet) parts.push(`    ${r.snippet.slice(0, 140)}`);
    });
    parts.push('');
  }
  if (fetched.length) {
    parts.push('Pages already fetched (you can answer from these):');
    fetched.forEach((p) => parts.push(`- ${p.url} (${p.title})`));
    parts.push('');
  }
  parts.push('Decide the next action as JSON.');
  return parts.join('\n');
}

const synthesisSystem = (sourceCount: number, memoryCount = 0, depth: Depth = 'quick') => {
  // Recalled memories personalise tone/format only — they are NOT retrieved sources, so honoring
  // them must never turn into a citation or a "fact" stated as if it were grounded.
  const memoryLine =
    memoryCount > 0
      ? ' Honor the user preferences/facts under "User memory" in tone and format, but NEVER cite them as [n] and never state a remembered fact as if it were sourced.'
      : '';
  if (sourceCount === 0) {
    return [
      'You are LUMINA. No sources could be retrieved for this question.',
      'Say briefly and plainly that you could not find sources to answer it.',
      'Do NOT use any [n] citations and do NOT invent facts.' + memoryLine
    ].join('\n');
  }
  // Deep answers span several sub-investigations, so they must be synthesised (not a per-source
  // list); quick answers stay short. The grounding rules are identical either way.
  const styleLine =
    depth === 'deep'
      ? '- Be thorough and well-organised: synthesise ACROSS the sources into a structured answer covering the facets of the question; do not just list facts source by source.'
      : '- Be concise.';
  return [
    'You are LUMINA, a web answer engine. Write a clear, accurate answer to the question using',
    `ONLY the ${sourceCount} numbered sources provided.`,
    '- End every factual sentence with the citation(s) it rests on, like [1] or [2][3].',
    `- Use only the source numbers 1..${sourceCount}. Never invent a number or cite one you were not given.`,
    '- If the sources do not answer the question, say so; do not fill the gap from memory.',
    styleLine + ' Do not add a "Sources" list — the UI shows sources separately.' + memoryLine
  ].join('\n');
};

// Source-agnostic: `readable` carries pre-numbered passages whether they came from web pages or
// document chunks, so synthesis (and citation grounding) is identical across the two arms.
function synthesisUser(query: string, readable: Readable[], memories: MemoryHit[] = []): string {
  const parts = [`Question: ${query}`, ''];
  if (memories.length) {
    parts.push('User memory (preferences/facts to honor — do NOT cite as sources):');
    memories.forEach((m) => parts.push(`- ${m.text}`));
    parts.push('');
  }
  if (readable.length) {
    parts.push('Sources:');
    readable.forEach((r) => {
      parts.push(`[${r.n}] ${r.label}`);
      parts.push(r.text.slice(0, READ_CHARS));
      parts.push('');
    });
  }
  parts.push('Write the grounded answer now.');
  return parts.join('\n');
}

// ---------------------------------------------------------------- persistence

function persist(a: {
  requestId: string;
  query: string;
  threadId: string;
  userId: string;
  answer: string;
  done: DoneEvent;
  sources: Source[];
  trace: TraceEvent[];
  usage: Usage;
  subQuestions?: SubQuestion[];
}): void {
  // The assistant turn joins the thread; a follow-up will see it and its sources. A deep answer also
  // stores its plan (subQuestions) so the answer stays explainable after the stream — and so the
  // per-user daily-cap count (deepRunsToday) has a durable record to count.
  appendMessage({
    threadId: a.threadId,
    userId: a.userId,
    role: 'assistant',
    content: a.answer,
    answerId: a.done.answerId,
    sources: a.sources,
    done: a.done,
    subQuestions: a.subQuestions
  }).catch((err) => log.error({ err, requestId: a.requestId }, 'appendMessage failed'));

  writeRunLogSafe({
    requestId: a.requestId,
    query: a.query,
    depth: a.done.depth ?? 'quick',
    terminated: a.done.terminated,
    model: a.done.model,
    tokens: a.usage.inTokens + a.usage.outTokens,
    wallClockSec: a.done.latencyMs / 1000,
    costUsd: a.done.costUsd,
    ttftMs: a.done.ttftMs,
    latencyMs: a.done.latencyMs,
    searchCached: a.done.searchCached,
    toolCalls: a.trace.map((t) => ({ name: t.tool, ok: t.ok, error: t.error }))
  });
}

/** Build a run log from ctx alone — used by the fail-loud path, which has no DoneEvent. */
function runLogFrom(requestId: string, query: string, ctx: AskCtx): Parameters<typeof writeRunLog>[0] {
  const now = Date.now();
  return {
    requestId,
    query,
    depth: ctx.depth,
    terminated: ctx.terminated,
    model: env.llmModel,
    tokens: ctx.usage.inTokens + ctx.usage.outTokens,
    wallClockSec: (now - ctx.startedAt) / 1000,
    costUsd: estimateLlmCostUsd(ctx.usage) + ctx.cacheMisses * SEARCH_COST_USD,
    ttftMs: (ctx.firstTokenAt || now) - ctx.startedAt,
    latencyMs: now - ctx.startedAt,
    searchCached: ctx.searches > 0 && ctx.cacheMisses === 0,
    toolCalls: ctx.trace.map((t) => ({ name: t.tool, ok: t.ok, error: t.error }))
  };
}

function writeRunLogSafe(run: Parameters<typeof writeRunLog>[0]): void {
  try {
    writeRunLog(run);
  } catch (err) {
    log.error({ err, requestId: run.requestId }, 'writeRunLog failed');
  }
}

// ---------------------------------------------------------------- deep-search daily cap (M9)

/** Start of the current UTC day, as a Date — message.createdAt is stored as a BSON Date. */
function startOfUtcDay(): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}

/** ISO timestamp of the next UTC midnight — when a user's deep-search budget refills. */
function nextUtcMidnight(): string {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1)).toISOString();
}

/**
 * How many deep searches this user has completed today (UTC). Counted from the assistant messages
 * that recorded a deep DoneEvent — the durable record every successful deep answer leaves. A failed
 * deep search (502) writes no assistant message, so it does NOT consume the budget: the cap limits
 * expensive COMPLETED work, not transient provider errors. Enforced request-time, before running.
 */
async function deepRunsToday(userId: string): Promise<number> {
  const messages = (await db()).collection(COLLECTIONS.messages);
  return messages.countDocuments({
    userId,
    role: 'assistant',
    'done.depth': 'deep',
    createdAt: { $gte: startOfUtcDay() }
  });
}
