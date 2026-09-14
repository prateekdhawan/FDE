# DESIGN.md — LUMINA

## Components

Five pieces, plus three stateful things that are not services.

- **Web UI** (provided) — React + Vite, built to static files and served from **Vercel**. It
  talks to exactly one thing: the gateway.
- **Gateway service** — Express on `:8787`, **public**, deployed on Fly.io. The edge.
- **Agent service** — Express on `:8000`, **private** (Fly internal networking), deployed on
  Fly.io. The loop, the tools, memory, RAG, deep search. The only holder of provider keys.
- **Jobs worker** — a background loop the agent service starts (`npm run worker`) that polls the
  `jobs` collection and runs document ingestion off the request path.
- **MongoDB Atlas** — one cluster, database `lumina`. Holds all authoritative state, the vectors,
  and the raw uploaded files (GridFS).

Not services, but they carry state or make decisions: the **`jobs` collection** (the ingestion
work queue and the crash-recovery record), the **search cache** (an in-process LRU in front of a
TTL'd `searchCache` collection), and the **run logs** (`runs/<requestId>.json`, one per answer —
the trajectory the grader reads).

## Responsibilities

The interesting part is what each component is the *only* one allowed to do.

- Only the **agent service** may hold a provider key or call the LLM, the search provider, or the
  embeddings API. The gateway reads no key, ever.
- Only the **gateway** may talk to the browser: it owns CORS, serves the UI, checks `X-User-Id`
  (→ `401`), validates request bodies with the shared zod contract (→ `400`), enforces a per-user
  rate limit (→ `429`), assigns the `X-Request-Id`, passes the SSE stream through unbuffered, and
  maps any upstream failure to `502`.
- Only the **agent service** decides a deep request is over its daily cap (→ `429`). That decision
  lives here, not on the edge, because a cap on the gateway is one you bypass by calling the agent
  directly — so the cap belongs where the spend happens.
- The **agent loop** is the only thing that chooses tools, and it is handed a *different toolset by
  depth*: a quick run cannot even see `plan_research`, so it cannot escalate itself into a run that
  costs several times more. It owns the caps, the honest `terminated` value, cost accounting, and
  writing the run log.
- Only the **worker** advances a document toward `indexed`. The upload handler's only job is to
  store the file and enqueue — it never parses or embeds synchronously.

## Communication

- **Browser ↔ gateway:** HTTP for everything; Server-Sent Events for `POST /threads/:id/ask`. If
  the gateway is down the browser gets a plain network error and the UI shows the request failed.
- **Gateway ↔ agent:** HTTP, with the ask route proxied as a pass-through SSE stream (no
  buffering, flush per event). If the agent throws or is unreachable, the gateway returns `502` —
  never a `2xx` with a plausible body. An in-flight stream that breaks upstream ends as an `error`
  event and the connection closes; the gateway never fabricates a `done`.
- **Agent ↔ Atlas:** the MongoDB driver over TLS. If Mongo is down, `/health` reports `db: down`,
  the service is `degraded`, and any request that needs to persist fails loudly (`502`) rather than
  pretending to succeed.
- **Agent ↔ worker:** entirely through the `jobs` collection — the agent inserts a `pending` row,
  the worker claims and drains it. This is deliberately decoupled: if the worker is down, uploads
  still return `202` and jobs simply queue; when it comes back it drains them. A worker killed
  mid-job leaves a `running` row with a stale `claimedAt`, and a sweeper returns it to `pending`
  without re-running the stages that already finished.
- **Agent ↔ providers (LLM / search / embeddings):** HTTPS. A provider exception ends the run with
  `terminated: "error"` and surfaces as a `502`. There is no `try/catch` that returns a fallback
  answer — that is the exact bug (Live Translate) this rule exists to prevent.

## State

- **Authoritative (in Atlas), owned by the agent/worker:** `threads`, `messages`, `memories`
  (with embeddings), `spaces`, `documents`, `chunks` (with embeddings + page/heading/line
  locators), `jobs`, `requests`, and the GridFS `uploads` bucket.
- **Cache / disposable:** the `searchCache` collection (rows expire via a TTL index; deleting it
  only costs a re-search) and the in-process **LRU** in front of it (pure speed, lost on restart,
  and that is harmless). `searchCached: true` is reported only when *every* search in a request was
  a hit. The `runs/` files are an append-only audit log (mirrored to a `runs` collection once
  deployed, since a container's disk is not durable).
- **The "written but not yet searchable" story:** Atlas Search indexes are eventually consistent,
  so upserting chunks does not make them findable the same instant. The worker therefore runs a
  **read-your-write probe** — it queries the vector index for the document it just wrote and only
  flips the status to `indexed` once one of its own chunks comes back. Until then the document sits
  at `embedding`/`pct < 100`, so an answer can never cite a document that is not actually
  retrievable yet.

## Trade-offs

Four decisions a reasonable engineer might have made differently.

1. **Atlas Vector Search instead of a dedicated vector store (Pinecone/Qdrant).** Keeping the
   embedding, the chunk text, its locator, and `spaceId` in one document makes a citation a single
   read and makes per-Space isolation a plain filter — no second store to keep in sync. The cost:
   Atlas M0 caps me at three search indexes and its indexes are only eventually consistent, which
   is exactly why the probe above has to exist.
2. **A hand-rolled agent loop instead of a framework (LangChain/LlamaIndex).** The assignment
   grades the *honesty of the trajectory* — every step traced, `terminated` truthful, tools gated
   by depth. A framework hides precisely those seams, so I gave up its free plumbing to keep
   control of them.
3. **Hybrid retrieval (vector + text fused with RRF) instead of vector-only.** Vector search alone
   misses exact-keyword and code-like queries; fusing a text index recovers them and lifts recall.
   The cost is a second index and the fusion step, against the M0 index budget.
4. **(The one I'm unsure about) An in-process LRU in front of the Mongo search cache.** On a single
   instance this gives near-instant repeat hits. But if I ever scale the agent to more than one
   instance, the LRUs don't share, so two instances can both miss and re-search the same query, and
   the real hit rate drops toward whatever the Mongo tier alone provides. At course scale it's one
   instance and the Mongo tier still catches cross-instance repeats, so I kept it — but I don't
   think it survives horizontal scaling without a shared cache (Redis), and I haven't proven that
   either way.
