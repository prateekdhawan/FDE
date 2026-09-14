/**
 * LUMINA agent service — the AI backend. PROVIDED SKELETON: YOU BUILD THIS OUT.
 * This is where the real work is. Provider keys live only in this process.
 *
 * What is already here: the server, /health (Mongo ping + which model, provider and
 * vector backend are live), and a 501 for every other route.
 *
 * What you build (README Part 1, in this order — each step is testable with curl -N):
 *   1. the QUICK loop: plan → choose tool → observe → repeat → answer, with web_search
 *      and fetch_page, streaming trace → sources → token → done. sources BEFORE the
 *      first token. Disable compression on this route and flush after every event.
 *   2. the search cache: in-process LRU over the searchCache collection (TTL index),
 *      key = sha256(normalized query + provider). searchCached only when every hit.
 *   3. threads + messages, so a follow-up sees the thread.
 *   4. memory: save_memory / recall_memory over the memories vector index; GET /memory,
 *      DELETE /memory/:id.
 *   5. the run log: one runs/<requestId>.json per answer, in the RunLog shape from the
 *      contract. Ten lines. The gates read it, so it is not optional.
 *   6. spaces + the jobs worker: upload → GridFS → parse → chunk → embed → upsert →
 *      read-your-write probe → indexed.
 *   7. hybrid retrieval: $vectorSearch + $search fused with RRF, page locators.
 *   8. DEEP search (depth: "deep"): plan_research decomposes the question into 3–6
 *      sub-questions, you stream a `plan` event BEFORE retrieving anything, research each
 *      sub-question, then merge the results into ONE citation numbering and synthesise.
 *      Every trace step and every source carries the subQuestion it served. Deep runs
 *      under the wider caps (maxToolCallsDeep, maxWallClockSecDeep) and behind
 *      DEEP_DAILY_CAP → 429 {error, resetsAt}.
 *
 * Three rules to hold on to while you write it:
 *   - Fail loud. A provider exception ends the run with terminated:"error" and a 502.
 *     Never a try/catch that returns a plausible answer. (Live Translate served English
 *     for weeks because of exactly that catch.)
 *   - Grounded or nothing. A citation that does not resolve to something retrieved in
 *     THIS request is an automatic fail.
 *   - Depth is opted into, never drifted into. A quick search may not call plan_research,
 *     however much the model would like to. Deep costs several times more, and a product
 *     that escalates itself is a product with an unbounded bill.
 */
// MUST be first: patches Express 4 so a rejected async route handler is forwarded to the error
// middleware (→ 502) instead of becoming an unhandled rejection that crashes the process. Our
// routes are `async (req,res)=>{ await db()... }`; without this a DB/provider error kills the agent
// rather than failing loud with a 502. Express 5 does this natively; on 4 it needs the shim.
import 'express-async-errors';
import express from 'express';
import pino from 'pino';
import { mkdirSync } from 'node:fs';
import { HealthResponse, ROUTES } from '@lumina/contract';
import { env } from './env.js';
import { pingDb } from './db.js';
import { threadsRouter } from './threads.js';
import { askRouter } from './ask.js';
import { memoryRouter } from './memory.js';
import { spacesRouter } from './spaces.js';
import { statsRouter } from './stats.js';
import { requestContext } from './requestlog.js';

const log = pino({ level: env.logLevel });
const app = express();

app.disable('x-powered-by');

// M11: set the correlation id (adopted from the gateway or minted) and log + persist one row per
// request on finish. First, so every route — including a 404 or a 400 — is greppable by one id.
app.use(requestContext);

app.use((req, res, next) =>
  req.path.endsWith('/documents') && req.method === 'POST'
    ? next()
    : express.json({ limit: '1mb' })(req, res, next)
);

mkdirSync(env.runsDir, { recursive: true });

// ---------------------------------------------------------------- /health (implemented)

app.get('/health', async (_req, res) => {
  const dbStatus = await pingDb();
  const body: HealthResponse = {
    status: dbStatus === 'ok' ? 'ok' : 'degraded',
    model: env.llmModel,
    searchProvider: env.searchProvider,
    vectorStore: env.vectorBackend,
    db: dbStatus,
    ai: { status: 'ok' }
  };
  res.status(dbStatus === 'ok' ? 200 : 503).json(body);
});

// ---------------------------------------------------------------- M4: threads & messages

app.use(threadsRouter);

// ---------------------------------------------------------------- M2: the quick loop + SSE

app.use(askRouter);

// ---------------------------------------------------------------- M5: memory (list + delete)

app.use(memoryRouter);

// ---------------------------------------------------------------- M7: spaces + document upload

app.use(spacesRouter);

// ---------------------------------------------------------------- M11: /stats

app.use(statsRouter);

// ---------------------------------------------------------------- everything else: 501

/** Routes that now have a real handler above; the loop must not shadow them with a 501. */
const IMPLEMENTED = new Set<string>([
  'GET /health',
  'GET /evals/report.json',
  'POST /threads',
  'GET /threads',
  'GET /threads/:threadId',
  'POST /threads/:threadId/ask',
  'GET /memory',
  'DELETE /memory/:memoryId',
  'POST /spaces',
  'GET /spaces',
  'POST /spaces/:spaceId/documents',
  'GET /spaces/:spaceId/documents',
  'GET /stats'
]);

const notImplemented = (route: string) => (_req: express.Request, res: express.Response) => {
  res.status(501).json({ error: `not implemented yet: ${route}. Build it in backend/agent/src/.`, status: 501 });
};

for (const route of ROUTES) {
  if (IMPLEMENTED.has(`${route.method} ${route.path}`)) continue;
  const method = route.method.toLowerCase() as 'get' | 'post' | 'delete';
  app[method](route.path, notImplemented(`${route.method} ${route.path}`));
}

app.use((req, res) => res.status(404).json({ error: `no route ${req.method} ${req.path}`, status: 404 }));

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log.error({ err }, 'agent error');
  res.status(502).json({ error: err.message, status: 502 });
});

app.listen(env.port, () => {
  log.info(
    {
      port: env.port,
      model: env.llmModel,
      searchProvider: env.searchProvider,
      vectorStore: env.vectorBackend,
      caps: {
        quick: { toolCalls: env.maxToolCalls, wallClockSec: env.maxWallClockSec },
        deep: { toolCalls: env.maxToolCallsDeep, wallClockSec: env.maxWallClockSecDeep, dailyCap: env.deepDailyCap }
      }
    },
    'agent up — every route but /health returns 501 until you build it'
  );
});
