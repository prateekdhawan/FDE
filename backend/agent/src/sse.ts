/**
 * Server-Sent Events framing for the agent's ask route (M2).
 *
 * This is a deliberate copy of backend/gateway/src/sse.ts, not an import: the two are
 * separate workspace packages and the agent must stream correctly on its own (the gateway
 * only proxies bytes in M10). The framing is the part that is easy to get subtly wrong —
 * miss the flush or a header and every token arrives at once at the end, which reads as a
 * slow model and fails the TTFT SLA for a reason no profiler will ever show you.
 */
import type { Response } from 'express';

/**
 * The four headers that stop Express AND the upstream proxy (nginx / Fly) from buffering
 * the stream. `no-transform` also tells any proxy not to gzip it. Compression middleware
 * must NOT sit in front of this route — see index.ts.
 */
export function sseHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

/** One SSE frame + flush. The blank line terminates the frame; without it the client waits. */
export function sseSend(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  // @ts-expect-error `flush` exists when a compression middleware is present; harmless otherwise.
  if (typeof res.flush === 'function') res.flush();
}
