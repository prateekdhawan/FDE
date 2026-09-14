/**
 * M11 — request correlation + the HTTP request log (5 pts: observability + /stats).
 *
 * Two small observability jobs, one middleware:
 *   1. Correlation id. The gateway forwards an X-Request-Id; the agent ADOPTS it (or mints one for
 *      a direct curl) into res.locals and echoes it back on the response. One id now greps a single
 *      request across the gateway pino log, the agent pino log, the run log and the requests row.
 *      Every route gets it — the ask route used to derive its own; it now reads this one, so there
 *      is exactly ONE id per request even when no gateway set a header (see ask.ts).
 *   2. The `requests` collection. On response finish we write one RequestDoc — the HTTP-layer record
 *      behind GET /stats' `requests` count and a durable, requestId-keyed audit of who called what
 *      and how it ended. This is the log side of "one X-Request-Id correlates a request across the
 *      gateway and agent logs" (rubric).
 *
 * Deliberately NOT here: answer economics (cost, tokens, ttft, terminated, depth). Those live on the
 * assistant message's `done` event and in runs/<id>.json — the records /stats sums and the gates
 * reconcile against. Duplicating them into RequestDoc would invite two numbers that can disagree;
 * this record stays at the HTTP layer, one row per request, and nothing more.
 *
 * Fail-soft: the log is a side effect. It runs on `finish`, after the response is already sent, so a
 * DB hiccup can only be swallowed and warned — it can never turn a good answer into an error. (The
 * fail-LOUD path is the request handler itself; a broken log must not masquerade as a broken API.)
 */
import express from 'express';
import pino from 'pino';
import { COLLECTIONS, REQUEST_HEADER, USER_HEADER, newId, type RequestDoc } from '@lumina/contract';
import { db } from './db.js';
import { env } from './env.js';

const log = pino({ level: env.logLevel });

/**
 * Set the correlation id for the request and, on finish, log one line and persist the RequestDoc.
 * Mounted before every router so the id exists for all routes (including a 404 or a validation 400).
 */
export function requestContext(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  // Adopt the gateway's id so both services share one key; mint one for a direct call. Same derive
  // the ask route used, now the single source of truth (it reads res.locals.requestId from here).
  const requestId = (req.header(REQUEST_HEADER) ?? '').trim() || newId('req');
  res.locals.requestId = requestId;
  res.setHeader(REQUEST_HEADER, requestId);

  const startedAt = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - startedAt;
    const route = (req.route?.path as string | undefined) ?? req.path;
    const userId = (req.header(USER_HEADER) ?? '').trim();
    // Correlation log line: emitted for EVERY request (with or without a user) so a request is
    // greppable across services even when it 401s.
    log.info({ requestId, userId: userId || null, route, status: res.statusCode, ms }, 'request');

    // The requests row is per-user (RequestDoc.userId is required, and /stats is per-user): a call
    // with no X-User-Id (/health, a rejected 401) has nobody to attribute it to, so it is logged
    // above but not persisted. Fire-and-forget — the response is already on the wire.
    if (!userId) return;
    void writeRequestLog({
      requestId,
      userId,
      route,
      status: res.statusCode,
      ms,
      createdAt: new Date() // BSON Date, so /stats' `createdAt >= startOfUtcDay()` compares correctly
    });
  });

  next();
}

async function writeRequestLog(doc: RequestDoc): Promise<void> {
  try {
    await (await db()).collection<RequestDoc>(COLLECTIONS.requests).insertOne(doc);
  } catch (err) {
    // A dropped observability row is not worth a log-storm; one warn is enough to notice a trend.
    log.warn({ err, requestId: doc.requestId }, 'requests-log write failed (non-fatal)');
  }
}
