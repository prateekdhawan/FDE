/**
 * M8 — hybrid document retrieval. The `search_documents` tool: given a query and a Space, find the
 * most relevant chunks the M7 worker indexed, so a docs answer can cite them with page/line locators.
 *
 * Why HYBRID (vector + text) fused with RRF, not vector-only:
 *   - Vector ($vectorSearch over the 1536-dim embeddings) captures *meaning* — it finds a passage
 *     about "car" when you ask about "automobile". But it is weak on rare exact tokens: a part
 *     number, an acronym, a name it never saw in training embed the same as noise.
 *   - Text ($search / BM25 over the raw chunk text) is the opposite: great on exact/rare terms,
 *     blind to paraphrase.
 *   - Reciprocal Rank Fusion combines the two RANKINGS (not their incomparable score scales):
 *     score(chunk) = Σ 1/(RRF_K + rank_in_list). A chunk near the top of *either* list scores well;
 *     a chunk near the top of *both* wins. RRF_K=60 is the standard damping so rank 1 doesn't
 *     dominate every fusion. Rank-based fusion is why we don't have to normalize cosine vs BM25.
 *
 * The `spaceId`+`userId` filter lives INSIDE each search stage (vector: filter fields; text:
 * compound.filter equals-on-token), NOT a later $match — filtering after a limited search would
 * return another Space's chunks first and then hide them, quietly wrecking recall (indexes.json
 * says exactly this).
 *
 * Fail model: the VECTOR arm is fail-loud (an Atlas/embed error propagates → 502; we cannot ground
 * a docs answer with no vector recall). The TEXT arm is fail-SOFT — if the BM25 index hiccups we
 * degrade to vector-only rather than sink the answer; hybrid is an enhancement over a working core.
 */
import pino from 'pino';
import type { Collection } from 'mongodb';
import {
  COLLECTIONS,
  SEARCH_INDEXES,
  type ChunkDoc,
  type DocumentDoc,
  type Locator
} from '@lumina/contract';
import { db } from './db.js';
import { embed } from './llm.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

/** One retrieved chunk, ready to become a `doc` Source and a synthesis passage. */
export interface DocHit {
  chunkId: string;
  docId: string;
  title: string;
  text: string;
  locator: Locator;
  score: number;
}

/** The RRF damping constant. Larger = flatter (rank differences matter less); 60 is the norm. */
const RRF_K = 60;
/** How wide each arm looks before fusion; deeper than the final K so fusion has material to work with. */
const ARM_LIMIT = 20;
const VECTOR_CANDIDATES = 100;

interface RawHit {
  _id: string;
  docId: string;
  text: string;
  locator: Locator;
}

/**
 * Retrieve the top-`k` chunks for `query` within (`spaceId`,`userId`), hybrid vector+text via RRF.
 * Returns [] when the Space has nothing relevant (an honest empty answer, not an error).
 */
export async function searchDocuments(
  query: string,
  spaceId: string,
  userId: string,
  k = 6
): Promise<DocHit[]> {
  const chunks = (await db()).collection<ChunkDoc>(COLLECTIONS.chunks);

  // --- vector arm (fail-loud): embed the query, ANN over cosine, filter inside the stage ---
  const [queryVector] = await embed([query]);
  if (!queryVector) throw new Error('failed to embed query for document search');
  const vecHits = await chunks
    .aggregate<RawHit>([
      {
        $vectorSearch: {
          index: SEARCH_INDEXES.chunksVector,
          path: 'embedding',
          queryVector,
          numCandidates: VECTOR_CANDIDATES,
          limit: ARM_LIMIT,
          filter: { spaceId, userId }
        }
      },
      { $project: { _id: 1, docId: 1, text: 1, locator: 1 } }
    ])
    .toArray();

  // --- text arm (fail-soft): BM25, token-equals filter; degrade to vector-only on any error ---
  const textHits = await searchTextArm(chunks, query, spaceId, userId);

  // --- fuse the two RANKINGS with RRF ---
  const score = new Map<string, number>();
  const meta = new Map<string, RawHit>();
  const accumulate = (list: RawHit[]) =>
    list.forEach((h, i) => {
      score.set(h._id, (score.get(h._id) ?? 0) + 1 / (RRF_K + i + 1));
      if (!meta.has(h._id)) meta.set(h._id, h);
    });
  accumulate(vecHits);
  accumulate(textHits);

  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
  if (!ranked.length) return [];

  // Titles live on the document, not the chunk — one lookup for the winners.
  const docIds = [...new Set(ranked.map(([id]) => meta.get(id)!.docId))];
  const docs = await (await db())
    .collection<DocumentDoc>(COLLECTIONS.documents)
    .find({ _id: { $in: docIds } })
    .project<{ _id: string; title: string }>({ title: 1 })
    .toArray();
  const titleById = new Map(docs.map((d) => [d._id, d.title]));

  return ranked.map(([id, s]) => {
    const m = meta.get(id)!;
    return { chunkId: id, docId: m.docId, title: titleById.get(m.docId) ?? m.docId, text: m.text, locator: m.locator, score: s };
  });
}

async function searchTextArm(
  chunks: Collection<ChunkDoc>,
  query: string,
  spaceId: string,
  userId: string
): Promise<RawHit[]> {
  try {
    return await chunks
      .aggregate<RawHit>([
        {
          $search: {
            index: SEARCH_INDEXES.chunksText,
            compound: {
              must: [{ text: { query, path: 'text' } }],
              filter: [
                { equals: { path: 'spaceId', value: spaceId } },
                { equals: { path: 'userId', value: userId } }
              ]
            }
          }
        },
        { $limit: ARM_LIMIT },
        { $project: { _id: 1, docId: 1, text: 1, locator: 1 } }
      ])
      .toArray();
  } catch (err) {
    // Fail-soft: hybrid degrades to vector-only rather than failing the whole docs answer.
    log.warn({ err: err instanceof Error ? err.message : err }, 'chunks_text arm failed; using vector-only');
    return [];
  }
}
