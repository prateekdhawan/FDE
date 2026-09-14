/**
 * M7 ingest pipeline — the PURE, testable half of document indexing: bytes -> parsed segments ->
 * chunks. No Mongo, no GridFS, no network; the worker (worker.ts) owns the I/O and calls these.
 * Keeping parse+chunk pure means the finicky bits (PDF page extraction, chunk boundaries, page
 * locators) can be verified on a generated PDF without a database — which matters here because
 * Atlas is TLS-blocked locally, so the DB half only runs at deploy.
 *
 * Locators are the point of a citation: a `doc` source must say WHERE in the document the claim is
 * (SPEC 7 / the bench's `pageLocator` check). So a PDF chunk carries `{page}` and a text/markdown
 * chunk carries `{line}` (+ the nearest `heading` when there is one). A chunk never straddles a
 * page boundary, or its page locator would be a lie.
 */
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Locator } from '@lumina/contract';

/** A parsed unit of the source: one PDF page, or one text/markdown paragraph. */
export interface Segment {
  text: string;
  locator: Locator;
}
export interface ParsedDoc {
  /** Present only for PDFs — the document's page count, surfaced on the DocumentRow. */
  pageCount?: number;
  segments: Segment[];
}
/** One embeddable/citable chunk: its text, where it came from, and its order in the doc. */
export interface ChunkSpec {
  text: string;
  locator: Locator;
  ord: number;
}

/**
 * Chunk sizing (chars, not tokens — cheaper to reason about and good enough at 1536-dim cosine).
 * ~1200 chars ~= 300 tokens: big enough to hold a self-contained passage, small enough that a hit
 * is precise and the embedding isn't diluted. 150-char overlap so a sentence split across a
 * boundary still lands whole in one chunk. These are the knobs recall@5 actually turns on.
 */
export const CHUNK_MAX_CHARS = 1200;
export const CHUNK_OVERLAP_CHARS = 150;
/** Bounds embedding cost/time on a pathological upload; a real doc is far under this. */
export const MAX_CHUNKS_PER_DOC = 800;

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- parse

export async function parseDocument(buf: Buffer, mimeType: string): Promise<ParsedDoc> {
  if (mimeType === 'application/pdf') return parsePdf(buf);
  return parseText(buf); // text/markdown, text/plain
}

async function parsePdf(buf: Buffer): Promise<ParsedDoc> {
  // Text extraction only — no rendering — so pdfjs needs no canvas/worker. `verbosity:0` silences
  // its font/polyfill warnings, which are irrelevant when we never paint a page.
  const doc = await getDocument({ data: new Uint8Array(buf), isEvalSupported: false, verbosity: 0 }).promise;
  const segments: Segment[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const text = collapse(content.items.map((it) => ('str' in it ? it.str : '')).join(' '));
    if (text) segments.push({ text, locator: { page: p } });
  }
  return { pageCount: doc.numPages, segments };
}

/** Split text/markdown into paragraphs (blank-line delimited), tracking line + nearest heading. */
function parseText(buf: Buffer): ParsedDoc {
  const lines = buf.toString('utf8').split(/\r?\n/);
  const segments: Segment[] = [];
  let heading: string | undefined;
  let acc: string[] = [];
  let startLine = 1;
  const flush = () => {
    const text = collapse(acc.join(' '));
    if (text) segments.push({ text, locator: { line: startLine, ...(heading ? { heading } : {}) } });
    acc = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trim();
    const h = /^(#{1,6})\s+(.+)$/.exec(trimmed); // markdown heading
    if (h) {
      flush();
      heading = h[2]?.trim();
      segments.push({ text: heading ?? trimmed, locator: { line: i + 1, ...(heading ? { heading } : {}) } });
      continue;
    }
    if (!trimmed) {
      flush();
      continue;
    }
    if (!acc.length) startLine = i + 1;
    acc.push(trimmed);
  }
  flush();
  return { segments };
}

// ---------------------------------------------------------------- chunk

/**
 * Pack segments into ~CHUNK_MAX_CHARS chunks, NEVER crossing a page boundary (so the page locator
 * stays honest), windowing any single over-long segment with overlap. `ord` is the chunk's position
 * in the document, used for stable ordering and as part of the chunk id.
 */
export function chunkSegments(parsed: ParsedDoc): ChunkSpec[] {
  const chunks: ChunkSpec[] = [];
  let acc = '';
  let accLoc: Locator | null = null;
  let accPage: number | undefined;

  const push = (text: string, locator: Locator) => {
    const t = text.trim();
    if (t && chunks.length < MAX_CHUNKS_PER_DOC) chunks.push({ text: t, locator, ord: chunks.length });
  };
  const flush = () => {
    if (acc.trim() && accLoc) push(acc, accLoc);
    acc = '';
    accLoc = null;
    accPage = undefined;
  };

  for (const seg of parsed.segments) {
    if (chunks.length >= MAX_CHUNKS_PER_DOC) break;
    // Never merge across pages: a chunk with a `{page}` locator must live on that one page.
    if (accLoc && seg.locator.page !== accPage) flush();

    if (seg.text.length > CHUNK_MAX_CHARS) {
      flush();
      const step = CHUNK_MAX_CHARS - CHUNK_OVERLAP_CHARS;
      for (let i = 0; i < seg.text.length && chunks.length < MAX_CHUNKS_PER_DOC; i += step) {
        push(seg.text.slice(i, i + CHUNK_MAX_CHARS), seg.locator);
      }
      continue;
    }

    if (acc.length + seg.text.length + 1 > CHUNK_MAX_CHARS) flush();
    if (!accLoc) {
      accLoc = seg.locator;
      accPage = seg.locator.page;
    }
    acc += (acc ? ' ' : '') + seg.text;
  }
  flush();
  return chunks;
}
