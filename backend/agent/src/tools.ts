/**
 * The two tools of the quick loop (M2): web_search and fetch_page. Everything the agent knows
 * about the world in a quick search comes through here.
 *
 * The fail-loud boundary is deliberate and lives here:
 *   - web_search throwing (Tavily HTTP/network error) is a PROVIDER exception → the loop lets
 *     it propagate → terminated:"error" + 502. We cannot ground an answer with no search.
 *   - fetch_page throwing (a 404, a 403 paywall, a timeout, non-HTML) is a NORMAL observation,
 *     not a system failure. Pages fail all the time. The loop records it as a trace step with
 *     ok:false + an error string (contract rule A1) and carries on.
 *
 * Grounding (the whole point). Every source's `snippet` must be a verbatim ≥12-token run of
 * the page, because the benchmark re-fetches source.url, runs stripHtml over the RAW html
 * (not a reader-view), normalizes, and checks the snippet is really in there. So we extract
 * clean article text for the model to READ (Readability), but choose the stored snippet from
 * that text only after confirming it survives the SAME stripHtml+normalize the bench uses —
 * mirrored below so we grade ourselves the way the bench will.
 */
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { env, secrets } from './env.js';

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

export interface FetchedPage {
  url: string;
  title: string;
  /** Clean article text (Readability) — what the model reads and synthesizes from. */
  text: string;
  /** stripHtml(rawHtml) — the exact haystack the bench grounds against. */
  rawText: string;
}

/** Estimated per-call price of a Tavily basic search; confirm against billing at M13. */
export const SEARCH_COST_USD = 0.005;

// ---------------------------------------------------------------- web_search (Tavily)

export async function webSearch(query: string, maxResults = 5): Promise<WebResult[]> {
  if (env.searchProvider !== 'tavily') {
    throw new Error(`search provider "${env.searchProvider}" not implemented (only tavily)`);
  }
  if (!secrets.tavily) throw new Error('TAVILY_API_KEY is not set');

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: secrets.tavily,
      query,
      search_depth: 'basic',
      max_results: maxResults
    }),
    signal: AbortSignal.timeout(15_000)
  });
  // Non-2xx from the search provider is a provider exception → fail loud (let it throw).
  if (!res.ok) throw new Error(`tavily ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const json = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  return (json.results ?? [])
    .filter((r) => r.url)
    .map((r) => ({ title: r.title || r.url!, url: r.url!, snippet: r.content ?? '' }));
}

// ---------------------------------------------------------------- fetch_page (Readability)

export async function fetchPage(url: string): Promise<FetchedPage> {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; LuminaBot/1.0; +course-project)' },
    redirect: 'follow',
    signal: AbortSignal.timeout(12_000)
  });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const html = await res.text();

  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document).parse();
  const readerText = normalizeSpace(article?.textContent ?? '');
  const domText = normalizeSpace(dom.window.document.body?.textContent ?? '');
  return {
    url,
    title: (article?.title || dom.window.document.title || url).trim(),
    // Prefer the reader view; fall back to the whole DOM's text if Readability found nothing.
    text: readerText || domText,
    rawText: stripHtml(html)
  };
}

/** Collapse runs of whitespace so the model reads clean prose and token windows are stable. */
const normalizeSpace = (s: string): string => s.replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- grounding (mirrors the bench)

// These three are a faithful copy of benchmark/lib.mjs so a snippet we accept is a snippet the
// bench will accept. If the bench's normalize ever changes, this must change with it.
const stripHtml = (html: string): string =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ');

const normalize = (s: string): string =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9']+/g, ' ')
    .trim();

/** True when some 12-consecutive-token window of `snippet` appears verbatim in `haystack`. */
export function snippetIsGrounded(snippet: string, haystack: string, minTokens = 12): boolean {
  const need = normalize(snippet).split(' ').filter(Boolean);
  const hay = normalize(haystack);
  if (!need.length || !hay) return false;
  if (need.length <= minTokens) return hay.includes(need.join(' '));
  for (let i = 0; i + minTokens <= need.length; i++) {
    if (hay.includes(need.slice(i, i + minTokens).join(' '))) return true;
  }
  return false;
}

/**
 * Pick a ~`words`-word excerpt of the page that is guaranteed grounded. We slide over the
 * clean article text (nice, readable passages) and return the first window that survives the
 * bench's check against the raw page. If none does (rare — reader text reflowed vs raw html),
 * we fall back to a slice of rawText itself, which is grounded by definition.
 */
export function groundedSnippet(page: FetchedPage, words = 40): string {
  const tokens = page.text.split(' ').filter(Boolean);
  for (let i = 0; i + 12 <= tokens.length; i += 12) {
    const cand = tokens.slice(i, i + words).join(' ');
    if (snippetIsGrounded(cand, page.rawText)) return cand;
  }
  const raw = page.rawText.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  return raw.slice(0, words).join(' ') || page.text.slice(0, 300) || page.title;
}
