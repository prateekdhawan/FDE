# Assignment 3B — Semantic Search → Moment RAG (Design Note)

**Goal:** Build a baseline semantic-search RAG over a YouTube transcript, then a Moment RAG
version, and compare retrieval quality. Deliverable: this notebook + a short slide deck (Option 1).

## Source video
Andrej Karpathy × Stephanie Zhan (Sequoia) — *"From Vibe Coding to Agentic Engineering"*
`https://www.youtube.com/watch?v=96jN2OCOfLs` — ~29.7 min, 966 timed caption cues, ~6.3k words.
Chosen because it is an **interview** (clear topic shifts → real "moments"), in-range on length,
has captions, and is on a topic that is easy to judge answer quality on.

## Scope decisions (approved)
1. **Clean A/B comparison.** Hold the retriever constant and change **only** the segmentation —
   fixed-size chunks vs. semantic timestamped moments — so any improvement is attributable to
   *moments*, not to other tricks. Then, as a second step, layer the reference's query-side stack
   (decompose + hybrid + re-rank) onto the moment system to show the additional lift ("full Moment RAG").
2. **"Moment" = semantic topic-shift segment.** Group consecutive caption cues into coherent spans
   by detecting where consecutive-window embedding similarity drops (a topic boundary). Each moment
   carries `start`/`end` timestamps (+ a short title), so citations deep-link to `[mm:ss]`.

## Reference architecture (traversaal-ai / momentsearch — what we mirror)
Query-side intelligence; retrieval resolves to **timestamped moments**, not documents:
`self-query (topic filters) → decompose (2–4 sub-queries) → hybrid retrieve (dense kNN + BM25 +
HyDE question-vectors, RRF-fused) → cross-encoder re-rank → streamed cited answer with timestamp
deep-links`. HyDE is done **at ingestion** (each chunk pre-tagged with questions it answers).
Stack: OpenAI `text-embedding-3-large`, Qdrant, FastAPI, Docker/Fly. We build a **notebook-scale,
free** equivalent (deployment is the separate ARGUS assignment).

## Our stack (isolated, free — same posture as 3A)
| Concern | Choice | Why |
|---|---|---|
| Transcript | `youtube-transcript-api` | timed cues → timestamps are the "moment" citation |
| Embeddings | local `sentence-transformers` (all-MiniLM-L6-v2) | free, no API quota, fast |
| Answer LLM | **Gemini** free tier (OpenAI-compat endpoint, 3A client + 429 retry wrapper) | no OpenAI key; reuse 3A |
| Vector search | FAISS / numpy cosine | corpus is tiny |
| Sparse | `rank_bm25` + Reciprocal Rank Fusion | mirror reference hybrid |
| Re-rank | `fastembed` ONNX cross-encoder | free, local, same lib as reference |
| Query decompose | reuse 3A sub-query splitter (Gemini) | already built |

## Pipelines
- **Part 1 — Baseline:** fixed ~1000-char overlapping chunks → local embed → FAISS → dense top-k →
  Gemini answer. No timestamps, no hybrid, no re-rank (deliberately naive).
- **Part 2 — Moment RAG:** semantic moments (above) → local embed → dense + BM25 (RRF) → cross-encoder
  re-rank → Gemini answer citing `[mm:ss]` moments. Query decomposition on the moment path only.

## Comparison method
Fixed set of 5–8 queries (mix of specific/factual and cross-cutting/synthesis). For each: show
baseline chunks vs. retrieved moments (with timestamps) side-by-side, plus both answers. Add 3–5
bullets explaining *where and why* moments win. Optional light LLM-as-judge preference score
(quota-aware). No labeled ground truth — analysis is qualitative + a simple retrieval-hit check.

## Deliverable (Option 1)
Notebook (this) + deck: video & why → reference architecture → baseline design → Moment RAG design →
side-by-side comparison → findings, limitations, improvements.

## Isolation / non-negotiables
Personal course project. Gemini free tier only (no OpenAI/paid keys). Keys via Colab secrets, never
committed. If submitted, push to personal GitHub only — never the work login. Keep separate from work.
