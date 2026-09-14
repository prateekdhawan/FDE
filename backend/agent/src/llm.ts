/**
 * LLM provider adapter — Google Gemini via raw REST (M2).
 *
 * Why raw fetch and not an SDK: backend/agent/package.json ships `openai` (for embeddings on
 * the OpenAI path) but no @google SDK, and the provider is a student choice the assignment
 * grades only through HTTP behaviour. One small file of fetch calls is less surface area than
 * a dependency, and it keeps the provider swappable behind three functions.
 *
 * Why Gemini at all (the isolation constraint): this is a personal, out-of-work project, so it
 * may not touch any Salesforce/office LLM infra. A personal Google AI Studio free-tier key
 * powers BOTH chat and embeddings at no cost. OpenAI ($5) stays as the documented fallback.
 *
 * Auth: Gemini keys go in the `?key=` query param, NOT an Authorization: Bearer header
 * (Bearer returns 401 API_KEY_SERVICE_BLOCKED). The key is read from `secrets.google`, which
 * lives only in this process — never in the gateway, never in the browser.
 *
 * Three entry points, matching the loop's needs:
 *   generate()   one-shot completion; used with {json:true} for the loop's tool decisions
 *   streamText() token-by-token synthesis, so the UI paints as the answer arrives (TTFT)
 *   embed()      1536-dim vectors for RAG/memory (M5/M7/M8); cosine indexes need no unit norm
 *
 * Fail loud (README Part 1): any non-2xx from Gemini throws. The ask loop lets that propagate
 * so the request ends terminated:"error" + 502 — never a try/catch that invents an answer.
 */
import { env, secrets } from './env.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** Token accounting from Gemini's usageMetadata; summed across every call in a request. */
export interface Usage {
  inTokens: number;
  outTokens: number;
}

export const emptyUsage = (): Usage => ({ inTokens: 0, outTokens: 0 });
export const addUsage = (a: Usage, b: Usage): Usage => ({
  inTokens: a.inTokens + b.inTokens,
  outTokens: a.outTokens + b.outTokens
});

/**
 * Estimated price for gemini-3.6-flash. These are PLACEHOLDER rates to confirm against the
 * live price sheet at M13 (benchmark/sla.json's cost_model is a separate, also-placeholder
 * table). Flash-class pricing keeps a quick answer far under the $0.05/answer SLA either way.
 */
const LLM_IN_USD_PER_MTOK = 0.1;
const LLM_OUT_USD_PER_MTOK = 0.4;
export function estimateLlmCostUsd(u: Usage): number {
  return (u.inTokens / 1e6) * LLM_IN_USD_PER_MTOK + (u.outTokens / 1e6) * LLM_OUT_USD_PER_MTOK;
}

// ---------------------------------------------------------------- Gemini wire shapes (partial)

interface GeminiPart {
  text?: string;
}
interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
}
interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  /** Gemini 3.x are thinking models: reasoning tokens billed as output, hidden from text. */
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}
interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
}

/**
 * Honest token accounting on a thinking model: output = candidates + thoughts. totalTokenCount
 * already includes both, so total − prompt is the truthful billable output; fall back to the
 * explicit sum if total is absent. (Our model runs thinkingLevel:"low" → thoughts ≈ 0, but the
 * cost and run-log numbers must stay correct even if that changes.)
 */
const usageFrom = (m?: GeminiUsageMetadata): Usage => {
  const inTokens = m?.promptTokenCount ?? 0;
  const outTokens =
    m?.totalTokenCount != null
      ? m.totalTokenCount - inTokens
      : (m?.candidatesTokenCount ?? 0) + (m?.thoughtsTokenCount ?? 0);
  return { inTokens, outTokens };
};

const textFrom = (c?: GeminiCandidate): string =>
  (c?.content?.parts ?? []).map((p) => p.text ?? '').join('');

function requireKey(): string {
  if (!secrets.google) throw new Error('GOOGLE_API_KEY is not set — the agent has no LLM provider');
  return secrets.google;
}

function requestBody(system: string, user: string, json: boolean, temperature: number) {
  return {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      temperature,
      // gemini-3.5-flash-lite is a thinking model; "low" makes it effectively skip reasoning
      // (measured: 0 thought tokens, TTFT ~0.9s), which is what a quick web answer needs to
      // meet the 2.5s TTFT / 12s answer SLAs. Deep search (M9) can dial this up per call.
      thinkingConfig: { thinkingLevel: 'low' },
      ...(json ? { responseMimeType: 'application/json' } : {})
    }
  };
}

// ---------------------------------------------------------------- generate (one-shot)

/**
 * A single completion. With {json:true} the model is asked for pure JSON (temperature 0, so
 * the tool decision is as deterministic as the model allows). Returns the raw text so the
 * caller can parse and apply its own fallback — an LLM emitting slightly-off JSON is a normal
 * event to recover from, not a provider exception to fail loud on.
 */
export async function generate(
  system: string,
  user: string,
  opts: { json?: boolean; temperature?: number } = {}
): Promise<{ text: string; usage: Usage }> {
  const url = `${GEMINI_BASE}/models/${env.llmModel}:generateContent?key=${requireKey()}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody(system, user, opts.json ?? false, opts.temperature ?? 0)),
    signal: AbortSignal.timeout(60_000)
  });
  if (!res.ok) {
    throw new Error(`gemini generateContent ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = (await res.json()) as GeminiResponse;
  return { text: textFrom(json.candidates?.[0]), usage: usageFrom(json.usageMetadata) };
}

// ---------------------------------------------------------------- streamText (synthesis)

/**
 * Streamed synthesis. `?alt=sse` makes Gemini emit `data: {chunk}` lines; each chunk carries
 * a little more text. `onToken` fires per chunk so the ask route can forward it as an SSE
 * `token` frame immediately — that first forwarded chunk is what the TTFT SLA measures.
 * usageMetadata arrives on the final chunk (cumulative), so we keep the last one seen.
 */
export async function streamText(
  system: string,
  user: string,
  onToken: (text: string) => void,
  opts: { temperature?: number } = {}
): Promise<{ text: string; usage: Usage }> {
  const url = `${GEMINI_BASE}/models/${env.llmModel}:streamGenerateContent?alt=sse&key=${requireKey()}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody(system, user, false, opts.temperature ?? 0.2)),
    signal: AbortSignal.timeout(120_000)
  });
  if (!res.ok || !res.body) {
    throw new Error(`gemini streamGenerateContent ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let usage = emptyUsage();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Gemini's SSE frames are newline-delimited `data: {json}` lines. Parse whole lines and
    // keep the trailing partial in the buffer for the next read.
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      const chunk = JSON.parse(payload) as GeminiResponse;
      const t = textFrom(chunk.candidates?.[0]);
      if (t) {
        full += t;
        onToken(t);
      }
      if (chunk.usageMetadata) usage = usageFrom(chunk.usageMetadata);
    }
  }
  return { text: full, usage };
}

// ---------------------------------------------------------------- embed (RAG / memory)

/**
 * Embeddings for RAG and memory. `outputDimensionality: 1536` is REQUIRED: the Atlas indexes
 * in scripts/indexes.json are built for numDimensions 1536 / similarity cosine, and Gemini's
 * gemini-embedding-001 defaults to 3072. The vectors come back not unit-normalized, which is
 * fine precisely because the indexes use cosine (scale-invariant) — no normalization needed.
 * Not called by the quick loop; wired into memory (M5) and document retrieval (M7/M8).
 */
export async function embed(texts: string[]): Promise<number[][]> {
  const key = requireKey();
  const out: number[][] = [];
  for (const text of texts) {
    const url = `${GEMINI_BASE}/models/${env.embeddingModel}:embedContent?key=${key}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: `models/${env.embeddingModel}`,
        content: { parts: [{ text }] },
        outputDimensionality: 1536
      }),
      signal: AbortSignal.timeout(60_000)
    });
    if (!res.ok) {
      throw new Error(`gemini embedContent ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const json = (await res.json()) as { embedding?: { values?: number[] } };
    const values = json.embedding?.values;
    if (!values || values.length !== 1536) {
      throw new Error(`gemini embedContent returned ${values?.length ?? 0} dims, expected 1536`);
    }
    out.push(values);
  }
  return out;
}

/**
 * Batched embeddings for INGEST (M7). A 60-page PDF is hundreds of chunks; embedding them one HTTP
 * call at a time both wastes wall-clock and, worse, hammers the free tier's requests-per-minute
 * limit (a burst of 200 single calls is 200 requests; 4 batches is 4). `batchEmbedContents` embeds
 * up to BATCH_SIZE texts per request, so the whole doc is a handful of calls. Order is preserved:
 * the i-th embedding is for the i-th text. Fail-loud like `embed` (a provider error fails the job).
 */
const EMBED_BATCH_SIZE = 50;
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const key = requireKey();
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const slice = texts.slice(i, i + EMBED_BATCH_SIZE);
    const url = `${GEMINI_BASE}/models/${env.embeddingModel}:batchEmbedContents?key=${key}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requests: slice.map((text) => ({
          model: `models/${env.embeddingModel}`,
          content: { parts: [{ text }] },
          outputDimensionality: 1536
        }))
      }),
      signal: AbortSignal.timeout(120_000)
    });
    if (!res.ok) {
      throw new Error(`gemini batchEmbedContents ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const json = (await res.json()) as { embeddings?: Array<{ values?: number[] }> };
    const embeddings = json.embeddings ?? [];
    if (embeddings.length !== slice.length) {
      throw new Error(`gemini batchEmbedContents returned ${embeddings.length} vectors for ${slice.length} texts`);
    }
    for (const e of embeddings) {
      if (!e.values || e.values.length !== 1536) {
        throw new Error(`gemini batchEmbedContents returned ${e.values?.length ?? 0} dims, expected 1536`);
      }
      out.push(e.values);
    }
  }
  return out;
}
