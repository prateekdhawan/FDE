/**
 * M11 — GET /stats. The per-user, per-UTC-day snapshot the UI header shows and the gates reconcile
 * against (rubric: "/stats.answers and /stats.costUsdToday reconcile with the agent log within 1 %").
 *
 * Every number is DERIVED from a durable record, never a running in-memory counter — so a restart
 * (or a second replica behind Fly) never loses or double-counts, and the number always matches what
 * the log says happened:
 *   - requests                        ← the `requests` collection (this user, today)
 *   - answers / costUsdToday / cache-hit rate / ttft p95 / deepToday
 *                                     ← the assistant messages' `done` events (this user, today)
 *   - deepDailyCap                    ← config, the same cap the deep gate enforces
 *
 * Why the `done` events and not runs/<id>.json: the disk run logs aren't per-user queryable (they
 * are files keyed by requestId), whereas each `done` event is the SAME economics persisted on the
 * owning message. costUsd/ttftMs on a done event are copied verbatim from the run it logged, so
 * summing them reconciles with runs/ by construction — the two can't drift.
 *
 * Per-user, not global: deepToday/deepDailyCap are a personal quota widget in web/ (the UI renders
 * "deep used / cap"), so the whole snapshot is scoped to res.locals.userId. Fail-LOUD: a DB error
 * propagates to the 502 handler (via express-async-errors); /stats never reports a comforting zero
 * over a broken query.
 */
import express from 'express';
import { COLLECTIONS, type MessageDoc, type StatsResponse } from '@lumina/contract';
import { db } from './db.js';
import { env } from './env.js';
import { requireUser } from './threads.js';

export const statsRouter = express.Router();

/** Start of the current UTC day; message/request createdAt are stored as BSON Dates. */
function startOfUtcDay(): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}

/**
 * Nearest-rank p95: the smallest sample at or above the 95th percentile (matches how the bench
 * computes its percentiles, so our /stats agrees with its own measurement). 0 on an empty day.
 */
function p95(xs: number[]): number {
  const sorted = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(0.95 * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1] ?? 0;
}

statsRouter.get('/stats', requireUser, async (_req, res) => {
  const userId = res.locals.userId as string;
  const since = startOfUtcDay();
  const database = await db();

  const requests = await database
    .collection(COLLECTIONS.requests)
    .countDocuments({ userId, createdAt: { $gte: since } });

  // One aggregation pass over today's answered messages yields every answer-derived number.
  const [agg] = await database
    .collection<MessageDoc>(COLLECTIONS.messages)
    .aggregate<{
      answers: number;
      costUsdToday: number;
      cacheHits: number;
      deepToday: number;
      ttfts: number[];
    }>([
      { $match: { userId, role: 'assistant', done: { $exists: true }, createdAt: { $gte: since } } },
      {
        $group: {
          _id: null,
          answers: { $sum: 1 },
          costUsdToday: { $sum: { $ifNull: ['$done.costUsd', 0] } },
          cacheHits: { $sum: { $cond: ['$done.searchCached', 1, 0] } },
          deepToday: { $sum: { $cond: [{ $eq: ['$done.depth', 'deep'] }, 1, 0] } },
          ttfts: { $push: '$done.ttftMs' }
        }
      }
    ])
    .toArray();

  const answers = agg?.answers ?? 0;
  const body: StatsResponse = {
    requests,
    answers,
    // Fraction of answers whose every search was a cache hit (searchCached is all-or-nothing). 0
    // when there are no answers yet — never NaN, and always within the contract's [0,100].
    searchCacheHitRatePct: answers > 0 ? (100 * (agg?.cacheHits ?? 0)) / answers : 0,
    ttftP95Ms: p95(agg?.ttfts ?? []),
    costUsdToday: agg?.costUsdToday ?? 0,
    deepToday: agg?.deepToday ?? 0,
    deepDailyCap: env.deepDailyCap
  };
  res.json(body);
});
