import type { Request, Response } from 'express';
import { Readable } from 'node:stream';
import { REQUEST_HEADER, USER_HEADER } from '@lumina/contract';
import { env } from './env.js';
import { sseHeaders } from './sse.js';

/**
 * Reverse-proxy one browser request to the agent service and relay the reply.
 *
 * The gateway is a dumb pipe on purpose — the agent owns every decision. So the two things this
 * function must get exactly right are (1) not corrupting a stream and (2) not lying about a
 * failure:
 *   - An SSE reply (text/event-stream) is relayed byte-for-byte AS IT ARRIVES, flushing each
 *     chunk, so tokens reach the browser when the agent emits them (buffering here would fail the
 *     TTFT SLA for a reason no profiler shows).
 *   - Any other reply is forwarded status + body VERBATIM, so the agent's 400 / 404 / 413 / 429
 *     (with its resetsAt) / 501 / 502 — and their bodies — reach the client unchanged. The gateway
 *     never invents a status the agent didn't send.
 *   - A failure to REACH the agent is a 502, never a 2xx over a dead upstream (rule A1).
 *
 * No provider key is ever read here; we forward only identity (X-User-Id), correlation
 * (X-Request-Id) and the content type. Nothing secret can leak downstream because nothing secret
 * lives in this process.
 */
export async function proxyToAgent(req: Request, res: Response): Promise<void> {
  const requestId = String(res.locals.requestId);
  const target = `${env.agentUrl}${req.originalUrl}`;

  const headers: Record<string, string> = { [REQUEST_HEADER]: requestId };
  const userId = req.header(USER_HEADER);
  if (userId) headers[USER_HEADER] = userId;
  const contentType = req.header('content-type');

  // Body: GET/DELETE carry none. The multipart upload is streamed raw (it was never parsed here, so
  // the boundary survives untouched). Every other POST was json-parsed + validated by the edge, so
  // we re-serialise the clean object.
  let body: RequestInit['body'] | undefined;
  let duplex: 'half' | undefined;
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    if (contentType?.includes('multipart/form-data')) {
      body = Readable.toWeb(req) as unknown as RequestInit['body'];
      duplex = 'half';
      headers['content-type'] = contentType; // keep the boundary
    } else {
      body = JSON.stringify(req.body ?? {});
      headers['content-type'] = 'application/json';
    }
  }

  // If the browser hangs up mid-stream, abort the upstream so the agent stops working (and spending)
  // for a client that has gone.
  const controller = new AbortController();
  res.on('close', () => controller.abort());

  let upstream: Awaited<ReturnType<typeof fetch>> | undefined;
  try {
    const init: RequestInit & { duplex?: 'half' } = {
      method: req.method,
      headers,
      signal: controller.signal
    };
    if (body !== undefined) {
      init.body = body;
      if (duplex) init.duplex = duplex;
    }
    upstream = await fetch(target, init);
  } catch (err) {
    if (controller.signal.aborted) return; // client gone; nothing to send
    // Agent unreachable or it tore the connection before replying: fail loud with 502.
    if (!res.headersSent) {
      res
        .status(502)
        .json({ error: `agent unreachable: ${(err as Error).message}`, status: 502, requestId });
    }
    return;
  }

  const ct = upstream.headers.get('content-type') ?? '';

  // ---- SSE pass-through: relay frames as they arrive, flushing so the stream stays live.
  const upstreamBody = upstream.body;
  if (ct.includes('text/event-stream') && upstreamBody) {
    sseHeaders(res);
    const reader = upstreamBody.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          res.write(Buffer.from(value));
          // @ts-expect-error `flush` exists under a compression middleware; harmless without one.
          if (typeof res.flush === 'function') res.flush();
        }
      }
    } catch {
      // Client disconnected or the upstream tore down mid-stream — the stream already carried what
      // it could; there is nothing honest left to send.
    } finally {
      if (!res.writableEnded) res.end();
    }
    return;
  }

  // ---- Non-stream: forward status + body verbatim (this is how the agent's 4xx/5xx and the
  // deep-cap 429's resetsAt reach the client unchanged).
  const text = await upstream.text();
  if (!res.headersSent) {
    res.status(upstream.status);
    if (ct) res.setHeader('content-type', ct);
    res.send(text);
  }
}
