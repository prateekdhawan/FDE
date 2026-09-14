import type { Request, Response, NextFunction } from 'express';
import { USER_HEADER } from '@lumina/contract';
import { env } from './env.js';

/**
 * Per-user, per-minute rate limit — the edge's spend/abuse guard.
 *
 * It sits on POST /threads/:id/ask only, and deliberately not on the cheap reads: the ask route is
 * the one that costs real money (LLM + search) and the one worth flooding, while the UI legitimately
 * *polls* GET /spaces/:id/documents once a second during indexing — throttling that would break the
 * product for no benefit. (The deep-search daily cap is a different, per-day ceiling enforced by the
 * agent; this is the per-minute request ceiling.)
 *
 * Fixed window, in memory: correct and O(1) for a single instance, keyed by X-User-Id so one user's
 * burst can never starve another. A tripped request returns 429 with resetsAt — the same shape as
 * every other cap — so a client knows exactly when to retry. (A multi-instance deploy would move
 * this counter to a shared store; documented in DESIGN.md, out of scope for one Fly machine.)
 */
const WINDOW_MS = 60_000;
const hits = new Map<string, { count: number; windowStart: number }>();

export function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const userId = (req.header(USER_HEADER) ?? '').trim();
  if (!userId) {
    next(); // auth runs first, so this is unreachable in practice; never 500 on a missing key here.
    return;
  }

  const now = Date.now();
  const rec = hits.get(userId);
  if (!rec || now - rec.windowStart >= WINDOW_MS) {
    hits.set(userId, { count: 1, windowStart: now });
    next();
    return;
  }

  rec.count += 1;
  if (rec.count > env.rateLimitPerMinute) {
    res.status(429).json({
      error: `rate limit exceeded: ${env.rateLimitPerMinute} requests/minute`,
      resetsAt: new Date(rec.windowStart + WINDOW_MS).toISOString(),
      status: 429,
      requestId: String(res.locals.requestId)
    });
    return;
  }
  next();
}
