/**
 * LUMINA gateway — the software backend. PROVIDED SKELETON: YOU BUILD THIS OUT.
 *
 * What is already here: the server, CORS, the request id, the pino request log, /health
 * (which nests the agent service's health), a 501 for every contract route, and the
 * static hosting of web/dist. That is deliberately the boring half.
 *
 * What you build (backend/gateway/, see README Part 2):
 *   1. X-User-Id enforcement           → 401 without it, on every route but /health
 *   2. zod validation from @lumina/contract → 400 on a bad body, with the zod message
 *   3. a per-user rate limit           → 429
 *   4. the proxy to the agent service, and SSE pass-through for /threads/:id/ask
 *   5. 502 for any upstream failure    → never a 2xx when the agent threw
 *
 * The browser talks ONLY to this service. No provider key is ever read here.
 */
import express from 'express';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import pino from 'pino';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { ZodTypeAny } from 'zod';
import {
  AskBody,
  CreateSpaceBody,
  CreateThreadBody,
  HealthResponse,
  REQUEST_HEADER,
  ROUTES,
  USER_HEADER
} from '@lumina/contract';
import { env } from './env.js';
import { proxyToAgent } from './proxy.js';
import { rateLimit } from './ratelimit.js';

const log = pino({ level: env.logLevel });
const app = express();

app.disable('x-powered-by');
app.use(cors({ origin: env.corsOrigins, credentials: false, exposedHeaders: [REQUEST_HEADER] }));

// One request id, reused if the caller sent one, generated if not, forwarded to the agent
// service and logged by both. This is what makes one request greppable end to end.
app.use((req, res, next) => {
  const id = (req.header(REQUEST_HEADER) ?? `req_${randomUUID().slice(0, 12)}`).trim();
  res.locals.requestId = id;
  res.setHeader(REQUEST_HEADER, id);
  next();
});

app.use(
  pinoHttp({
    logger: log,
    genReqId: (_req, res) => String(res.locals.requestId),
    customProps: (req, res) => ({
      requestId: res.locals.requestId,
      userId: req.header(USER_HEADER) ?? null
    }),
    // The ask route is a stream; one line when it closes is the useful line.
    autoLogging: true
  })
);

// JSON everywhere except the multipart upload route, which your handler owns.
app.use((req, res, next) =>
  req.path.endsWith('/documents') && req.method === 'POST'
    ? next()
    : express.json({ limit: '1mb' })(req, res, next)
);

// ---------------------------------------------------------------- /health (implemented)

app.get('/health', async (_req, res) => {
  let ai: { status: 'ok' | 'down' } & Record<string, unknown> = { status: 'down' };
  try {
    const upstream = await fetch(`${env.agentUrl}/health`, { signal: AbortSignal.timeout(3000) });
    const body = (await upstream.json()) as Record<string, unknown>;
    ai = { ...body, status: upstream.ok ? 'ok' : 'down' };
  } catch (err) {
    // Health tells the truth about a dead dependency. It never pretends.
    ai = { status: 'down', error: (err as Error).message };
  }

  const body: HealthResponse = {
    status: ai.status === 'ok' ? 'ok' : 'degraded',
    model: String(ai.model ?? 'unset'),
    searchProvider: (ai.searchProvider as HealthResponse['searchProvider']) ?? 'tavily',
    vectorStore: (ai.vectorStore as HealthResponse['vectorStore']) ?? 'atlas-vector-search',
    db: (ai.db as HealthResponse['db']) ?? 'down',
    ai
  };
  res.status(ai.status === 'ok' ? 200 : 503).json(body);
});

// ---------------------------------------------------------------- edge policy + proxy

/** The one auth rule: X-User-Id required on every route with auth:true. 401 without it. */
function requireUser(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const userId = (req.header(USER_HEADER) ?? '').trim();
  if (!userId) {
    res
      .status(401)
      .json({ error: 'X-User-Id header required', status: 401, requestId: String(res.locals.requestId) });
    return;
  }
  next();
}

/**
 * Validate a JSON body at the edge with the shared contract schema: a bad body is a 400 with the
 * zod message, decided here before the agent is ever touched. One definition, enforced at the door.
 */
const validate =
  (schema: ZodTypeAny) =>
  (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues
        .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
        .join('; ');
      res
        .status(400)
        .json({ error: msg || 'invalid request body', status: 400, requestId: String(res.locals.requestId) });
      return;
    }
    req.body = parsed.data;
    next();
  };

/** Body schemas for the JSON POSTs. The multipart upload is validated by the agent, not here. */
const BODY_SCHEMAS: Record<string, ZodTypeAny> = {
  'POST /threads': CreateThreadBody,
  'POST /threads/:threadId/ask': AskBody,
  'POST /spaces': CreateSpaceBody
};

/**
 * Wire every contract route (except /health): auth → validate → rate-limit → proxy to the agent.
 * The proxy is async; `.catch(next)` routes any rejection to the 502 error middleware, since Express
 * 4 would otherwise turn an unhandled rejection into a process crash.
 */
for (const route of ROUTES) {
  if (route.path === '/health') continue;
  const method = route.method.toLowerCase() as 'get' | 'post' | 'delete';
  const chain: express.RequestHandler[] = [];
  if (route.auth) chain.push(requireUser);
  const schema = BODY_SCHEMAS[`${route.method} ${route.path}`];
  if (schema) chain.push(validate(schema));
  if (route.method === 'POST' && route.path === '/threads/:threadId/ask') chain.push(rateLimit);
  app[method](route.path, ...chain, (req, res, next) => {
    proxyToAgent(req, res).catch(next);
  });
}

// ---------------------------------------------------------------- static UI

// In production the gateway serves the built UI, so / and /evals come from one origin.
if (existsSync(env.webDist)) {
  app.use(express.static(env.webDist));
  app.get(/^(?!\/(health|stats|threads|memory|spaces|artifacts|evals)).*/, (_req, res) => {
    res.sendFile(`${env.webDist}/index.html`);
  });
}

app.use((req, res) => {
  res.status(404).json({ error: `no route ${req.method} ${req.path}`, status: 404 });
});

// A thrown error is a 502 with a log line, never a 200 with a plausible body (rule A1).
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log.error({ err, requestId: res.locals.requestId }, 'gateway error');
  res.status(502).json({ error: err.message, status: 502, requestId: String(res.locals.requestId) });
});

app.listen(env.port, () => {
  log.info(
    { port: env.port, agentUrl: env.agentUrl, cors: env.corsOrigins },
    'gateway up — every route but /health returns 501 until you build it'
  );
});
