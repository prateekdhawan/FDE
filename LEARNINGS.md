# LUMINA — Learnings Log (Objective 2)

One section per module: **options considered → what we chose → why → the trade-off we
accepted → the gotcha.** This is the durable record of *why* the system looks the way it does,
and it feeds the graded `DESIGN.md` trade-offs section.

---

## Glossary (plain English)

Terms from `PLAN.md` you'll meet as we go:

- **Monorepo / workspaces** — one repo holding several npm packages (`web`, `gateway`,
  `agent`, `contract`) that can depend on each other. `npm install` at the root wires them together.
- **Gateway / edge service** — the public front door. Handles browser concerns (auth, CORS,
  rate limits) and forwards real work to the agent. Holds no secrets.
- **Agent service** — the "brain". Runs the loop, calls the LLM and search, talks to the DB.
- **Agent loop** — plan → pick a tool → run it → look at the result → repeat → stop. The core
  pattern of an AI agent. We write it ourselves (no framework) so we control every step.
- **Tool** — a function the LLM can choose to call (`web_search`, `fetch_page`, etc.). The model
  decides *which* and *when*; our code actually runs it.
- **SSE (Server-Sent Events)** — a one-way stream from server to browser over HTTP. Lets the
  answer appear token-by-token instead of all at once.
- **SSE pass-through** — the gateway relays the agent's stream to the browser unchanged and
  un-buffered (buffering is the #1 bug: tokens arrive all at once at the end).
- **TTFT (time to first token)** — how long until the first word appears. A key latency metric.
- **Grounding** — every citation `[n]` must point to text the system actually retrieved this
  request. No made-up sources, ever.
- **Terminated (done / cap / error)** — *why* the loop stopped: finished, hit a limit, or threw.
  Reporting this honestly is graded.
- **RAG (Retrieval-Augmented Generation)** — answer from *your* documents by retrieving relevant
  chunks and feeding them to the LLM, instead of relying on what the model already "knows".
- **Embedding** — a list of numbers (here, 1536 of them) representing the meaning of a piece of
  text, so "similar meaning" becomes "close vectors".
- **Vector search** — find text with similar meaning by comparing embeddings (cosine similarity).
- **Text search (BM25/keyword)** — classic keyword matching. Good where exact words matter.
- **Hybrid retrieval** — combine vector + text results for better recall than either alone.
- **RRF (Reciprocal Rank Fusion)** — a simple, robust way to merge two ranked lists into one.
- **Chunking** — splitting a document into passages small enough to embed and cite precisely.
- **Locator** — where a chunk came from: `{page}` for PDFs, `{heading}`/`{line}` for text. Makes
  a citation say "p. 14".
- **recall@5** — of the questions in the gold set, how often the right passage is in the top 5
  retrieved. Target ≥ 0.70.
- **LRU cache** — "least recently used" in-memory cache; evicts the stalest entries when full.
- **TTL index** — a MongoDB index that auto-deletes documents after a time-to-live. Used to
  expire cached search results.
- **GridFS** — MongoDB's way of storing files (the raw uploads) inside the database.
- **Jobs worker** — a background process that picks up queued jobs (parse/embed a document) so
  the upload request can return instantly (`202 Accepted`).
- **Read-your-write probe** — after indexing a doc, actually query the index for it before
  marking it `indexed`. "Upserted" is not "searchable" — indexes are eventually consistent.
- **Deep search** — the expensive gear: break a question into 3-6 sub-questions, research each,
  merge into one set of citations. Opt-in only; capped per user per day.
- **Query decomposition / fan-out** — turning one hard question into several researchable ones
  and pursuing each.
- **Spend gate** — the per-user daily cap on deep searches; over the limit → `429`. Enforced in
  the *agent* service so it can't be bypassed by calling around the gateway.
- **zod** — a TypeScript library that validates data shapes at runtime. The "contract" is written
  in zod, so the UI, gateway, and agent all agree on exactly what each request/response looks like.
- **Private networking** — the agent service is reachable only by the gateway, never from the
  public internet — so keys and the spend cap can't be bypassed.

---

## M0 — Setup

**What M0 is:** get the plumbing real — one `.env`, a live Atlas cluster, all indexes built —
so every later module has something concrete to run against.

**Decisions / why:**
- **One `.env` at the repo root, read by both services.** Simpler than per-service config; the
  gateway and agent share the same wiring values (ports, URLs) and only the agent reads the secret
  keys. Trade-off: you must remember the *gateway* holds no keys even though it can see the file.
- **Indexes built by a script, asynchronously.** `create-indexes.mjs` creates the collections,
  the regular/TTL indexes, and the Atlas vector/text search indexes from `scripts/indexes.json`.
  Search indexes build in the background — "created" ≠ "queryable". You confirm with `--status`
  until each says `READY (queryable)` before trusting any retrieval result. This is the same
  "write ≠ searchable" lag the RAG ingest probe (M7) has to handle.
- **Password with letters+numbers only.** A DB password with `@ : / ? %` must be percent-encoded
  inside the `mongodb+srv://` URI (the `@` is the user/host delimiter). Alphanumeric side-steps it.

**Gotchas we actually hit:**
- **`bad auth` ≠ network problem.** Getting an auth *rejection* (not a timeout) proves the network
  and IP allow-list are fine; the fault is purely the credentials. Root cause here: the Atlas
  *account login* is **not** a *Database Access* user — you must create a database user under
  **Security → Database Access**. Fixed by creating a clean `lumina` user with
  *readWriteAnyDatabase*.
- **M0 free tier allows only 3 search indexes *total* (vector + text combined) per cluster.** The
  loaded **sample dataset** (`sample_mflix.movies/default`) was silently using the 3rd slot, so our
  `chunks_text` index failed with "maximum number of FTS indexes reached." Fix: drop the unrelated
  sample search index (deletes no documents, reversible) → the slot frees → `chunks_text` builds.
  Lesson for the design doc: the free tier's 3-index budget is a real constraint the architecture
  lives inside (2 vector + 1 text = exactly 3, none to spare).

**Provider keys — resolved in M2 (note updated).** The scaffold's `env.ts` still *defaults* to
`ANTHROPIC_API_KEY`/`claude-sonnet-5` (LLM) + `OPENAI_API_KEY`/`text-embedding-3-small` (embeddings),
but the isolation constraint ruled those out and the only adapter we actually implemented is **Gemini**
(raw REST, `llm.ts`). So the real `.env` needs `GOOGLE_API_KEY` (chat **and** embeddings) + `TAVILY_API_KEY`
(search), with `LLM_PROVIDER=google`, `LLM_MODEL=gemini-3.5-flash-lite`, `EMBEDDING_MODEL=gemini-embedding-001`
overriding the defaults so `/health` names the model actually served. See §M2.

## M1 — DESIGN.md

**What it is:** the graded design doc answering five questions (Components, Responsibilities,
Communication, State, Trade-offs). Parsed *by heading* by `eval/build-report.mjs` and rendered to
a stranger on `/evals` — so the five `##` headings must stay exact, and the prose must be in your
own words.

**The five questions, and why each is asked:**
- **Components** — forces you to name the *non-service* state carriers (the job queue, the cache,
  the run logs), which is where real systems actually break.
- **Responsibilities** — the value is in the *exclusions*: "only the agent holds a key", "only the
  agent enforces the cap". If two components can both do a thing, neither truly owns it.
- **Communication** — the graded sentence is "what happens when the other end is down." A design
  that only describes the happy path hasn't been thought through.
- **State** — separating *authoritative* from *cache* is the whole game: you must be able to delete
  the cache and lose nothing. Plus the eventual-consistency story (write ≠ searchable).
- **Trade-offs** — every choice gave something up; naming it (incl. one you're *unsure* about) is
  the honesty the rubric rewards.

**Key decisions captured (options → choice → why → trade-off):**
- **Vector store:** Pinecone/Qdrant vs pgvector vs *Atlas Vector Search*. Chose Atlas → one
  document per citation, `spaceId` a plain filter, no second store to sync. Trade-off: M0's
  3-index limit + eventual consistency (→ the read-your-write probe).
- **Agent loop:** LangChain/LlamaIndex vs *hand-rolled*. Chose hand-rolled → full control of the
  trace, caps, honest `terminated`, and depth-gated tools (a framework hides these). Trade-off:
  we write plumbing ourselves.
- **Retrieval:** vector-only vs *hybrid (vector+text, RRF)*. Chose hybrid → recovers keyword/code
  queries, higher recall. Trade-off: a second index + fusion step against the index budget.
- **Deep-cap placement:** gateway vs *agent service*. Chose agent → a cap on the edge is bypassed
  by calling the agent directly.
- **Worker:** worker_threads vs *separate polling process*. Chose separate loop over the `jobs`
  collection → crash isolation + uploads never block the stream. Trade-off: one more process to run.
- **Unsure:** in-process LRU in front of the Mongo cache — great on one instance, but doesn't share
  across instances if we scale horizontally. Kept for now; flagged as the honest "not sure" item.

**Gotcha:** the doc is parsed by heading — renaming/removing a `##` heading makes `/evals` show that
section as MISSING. Keep exactly the five.

## M2 — Quick loop + SSE

**What M2 is:** the make-or-break core (20 pts) — a hand-rolled *plan → pick tool → observe →
repeat → answer* loop over two tools (`web_search`, `fetch_page`), streamed as
`trace* → sources → token* → done`, with **sources always before the first token**, grounded
citations, fail-loud on provider errors, and honest caps (`terminated: done|cap|error`).

**Shape — loop as a pure function, route as a thin shell.** `runQuickAnswer(query, emit, ctx)`
knows nothing about HTTP: it calls `emit()` with contract events and returns the answer. The
Express route is only transport: auth, validation, ownership (404-not-403), the lazy SSE header
flush, persistence, and the 502-vs-`error`-event split. Why: the assignment grades the exact wire
order and the fail-loud behaviour, and a loop with no socket or DB in it is unit-testable without
either — which mattered enormously when Atlas TLS was down (see Gotchas) and I could still verify
the entire loop against a live provider through a throwaway harness.

**Decisions / why:**
- **Provider: Google Gemini via raw `fetch`, not an SDK.** The isolation constraint (personal,
  out-of-work project → no Salesforce/office LLM infra) rules out the obvious internal routes; a
  personal Google AI Studio *free-tier* key powers both chat and embeddings at no cost. Raw REST
  over an SDK because the package ships no `@google` client and the provider is graded only through
  HTTP behaviour — one small file is less surface than a dependency and keeps the provider swappable
  behind three functions (`generate` / `streamText` / `embed`). Gotcha: Gemini keys go in the
  `?key=` **query param**, not `Authorization: Bearer` (Bearer → 401 `API_KEY_SERVICE_BLOCKED`).
- **Deterministic first search — the biggest single design choice.** The first move of a web answer
  is *always* a search (nothing else is legal with an empty context; the grounding override proves
  it), so spending an LLM round-trip whose only valid output is "search" is pure waste. We run the
  seed search directly and only *then* start asking the model. Removes one whole round-trip from
  every answer.
- **Model decides judgement, not mechanics.** After the seed search the model's job is the part the
  loop can't fake: *which* results are worth reading (returned as a URL list, fetched in parallel),
  or whether the results are so poor a refined query is needed. The loop is bounded by the
  **decision count** (≤2), not just the tool cap — because on a slow provider the sequential
  round-trips *are* the latency, so we spend as few as the answer needs. Common path = **2 LLM
  calls** (1 decision + 1 synthesis), down from ~5 in the first cut.
- **Parallel fetch batch.** The chosen pages are read concurrently — N fetches cost one fetch's
  wall-clock, not N. Batch size ≤ `MAX_FETCHES` (3) so it can never trip quality rule A3
  (>3 consecutive same-tool calls); each page still emits its own trace step (`ok:true`, or
  `ok:false`+`error` for a 404/paywall/timeout — a normal observation, never a run failure).
- **Grounding snippet mirrors the bench.** We extract clean article text (Readability) for the model
  to *read*, but choose the stored `snippet` only after confirming it survives the **same**
  `stripHtml → normalize → 12-token-window` check the benchmark runs when it re-fetches the URL. So
  we grade ourselves the way the grader will; verified 2/2 verifiable sources grounded.
- **Fail loud, split by stream state.** A `web_search` throw (provider/network) propagates → the
  route returns **502 before the stream opens**, or emits an `error` event if it already opened.
  Never a try/catch that invents an answer. A `fetch_page` throw is caught *inside* the loop as a
  normal `ok:false` observation. The run log routes by outcome: `done → runs/`, `cap`/`error →
  runs/failing/` (never relabelled).
- **Honest token accounting on a thinking model.** Gemini 3.x bill hidden reasoning as output;
  `outTokens = totalTokenCount − promptTokenCount` captures thoughts even when `thinkingLevel:"low"`
  reports zero, so cost/run-log numbers stay truthful if that ever changes.

**The latency investigation (the hard part) — and its honest conclusion.**
The first working loop passed every *correctness* gate but failed both timing SLAs badly
(TTFT ≈ latency ≈ 17s). Rather than guess, I profiled each primitive in isolation, then stripped my
code out entirely with raw `curl`:
- Raw `curl` to `generateContent` (no Node, no my code): **3.5-flash-lite ≈ 10s, 3.6-flash ≈ 3s**,
  identical with and without `thinkingConfig` — for a 3-token completion. Meanwhile the host's TTFB
  (`/robots.txt`) is ~150ms, so the network path is fine.
- Conclusion: the dominant latency is **free-tier Gemini per-request server latency (3–10s+,
  wildly variable by model and hour** — `3.5-flash-lite` was 0.87s in an earlier session, 10s now).
  This is not fixable in code, and it means **local runs cannot validate the timing SLA**: a single
  LLM call alone exceeds the 2500 ms TTFT budget.
- What code *can* do is cut the **number of sequential LLM round-trips**, which is the multiplier on
  that per-call cost. Hence the two changes above (deterministic first search + decision-count cap →
  5 calls to 2) and the parallel fetch. These are correct under *any* provider and pay off directly
  when deployed on a faster path.

**Trade-offs we accepted:**
- **Stay on the free tier and document the caveat** (deliberate choice): zero cost and full
  isolation, at the price that the two *timing* SLA rows (`ttft_p95`, `answer_p95`) will likely read
  red when the bench runs against this tier. Correctness, grounding, cost, and `terminated` all pass;
  the timing gate is provider-bound, not architecture-bound, and the M3 search cache (50% of the
  workload is repeats) plus deploy-region latency are the levers left. Documented rather than chased,
  because chasing 2500 ms would mean dropping the decision call to a fixed pipeline — sacrificing the
  agentic tool-choice this module exists to demonstrate.
- **Deterministic seed search** slightly narrows model agency (it can't choose *not* to search
  first) — accepted, because with an empty context there is no other legal move.
- **Topping the fetch batch up to 3** means the model's URL-selection judgement is one input among
  ranked results, not the sole gate — accepted, because parallel fetch makes the extra pages free in
  wall-clock and they lift grounding/recall.

**Gotchas we actually hit:**
- **Atlas TLS handshake failure (`SSL alert number 80`) — root-caused, environmental, not code.**
  Diagnosed with `openssl s_client`: TCP to the Atlas shard *succeeds* (`CONNECTED` to the real
  ap-south-1 IP `159.41.196.248`), but a middlebox kills the handshake — `SSL alert 80`
  (`internal_error`) on **both TLS 1.2 and 1.3**, after our ClientHello and before any certificate.
  Plain HTTPS (`google.com:443`) handshakes cleanly, so it is **27017-specific**: an endpoint
  TLS-inspection agent (`ciscod.exe` running + a corporate MITM CA at
  `NODE_EXTRA_CA_CERTS=…\.aisuite\conf\npm-sfdc-certs.pem`) MITMs 443 with its own CA but cannot
  proxy the MongoDB wire protocol, so it aborts. **Not fixable in code:** `tlsInsecure` /
  `NODE_EXTRA_CA_CERTS` only affect *our* validation of *their* cert, but here the far side
  terminates first; both TLS versions already fail; and pointing this personal project at the SFDC
  CA would break isolation. (Switching the LLM to Groq is orthogonal — the block is Mongo's port,
  not the LLM.) It blocks the Mongo-backed parts of the ask route (ownership, `appendMessage`) **and**
  the Mongo tier of the M3 cache — so both were built with Mongo behind a seam and verified without
  it (M2 via a pure-function harness; M3 via the in-process LRU tier + a fail-soft Mongo path). The
  middlebox exists only on this work laptop; the Fly.io deploy has no such agent, so the live
  Mongo + HTTP+SSE path is verified at **M12** — which is where the assignment grades it anyway
  ("evidence from the deployed app").
- **`thinkingBudget:0` is rejected (400) across Gemini 3.x**, and `gemini-2.5-*` return 404 ("no
  longer available to new users"). `thinkingLevel:"low"` is the supported way to suppress reasoning.
- **`noUncheckedIndexedAccess`** makes `req.params.threadId` `string | undefined`; narrow once at the
  top of the handler.

## M3 — Search cache

**What M3 is:** a two-tier cache over search *results* (never answers — freshness is never served
stale) in `backend/agent/src/searchCache.ts`, called from M2's `runSearch`. In-process **LRU** in
front of a MongoDB **`searchCache`** collection with a **TTL index** on `expiresAt`
(`expireAfterSeconds:0`), keyed by `sha256(normalized query + provider)`, `searchCached:true` in the
`done` event only when every search in the request was a hit.

**Decisions / why:**
- **Two tiers (LRU → Mongo), not one.** Options: (a) LRU only — fast, zero infra, but cold-starts
  empty on every process and shares nothing across a multi-instance deploy; (b) Mongo only — shared
  and survives restarts, but every hit pays a network round-trip; (c) both, LRU in front. Chose
  **(c)**: the LRU absorbs the hot repeats with no network (and *alone* clears the bench's ≥50%,
  because the bench is one long-lived process over exact-string repeats), while Mongo makes the cache
  real across instances/restarts. Trade-off: two write paths and a coherence risk (an LRU entry
  outliving its Mongo row) — closed by giving the LRU entry the **same `expiresAt`** as the row.
- **A cache is an optimisation, not a correctness gate → the Mongo tier is FAIL-SOFT.** A cache-backend
  outage bypasses to a live search and serves a correct, uncached answer; it never becomes a 502.
  Only the *live search* is fail-loud, and it sits **outside** every `try/catch`. This is the mirror
  image of M2's rule: a *search-provider* error must fail loud (you cannot ground without a search);
  a *cache* error must not (correctness never depended on it). This is also exactly what let M3 ship
  and be verified while Atlas is blocked — the down-Mongo path *is* the current local state.
- **A tiny circuit breaker on the Mongo tier** (skip it for 60s after a failure). Simpler alternative
  — bare `try/catch`, no breaker — rejected because with `serverSelectionTimeoutMS:5000` it would add
  ~5s to **every** search while Mongo is down. The breaker pays the timeout once, then skips; correct
  in both environments (down-locally and up-in-prod).
- **Charge only cache MISSES for search cost.** A hit made no provider call, so it costs nothing:
  `costUsd = llm + cacheMisses·SEARCH_COST_USD`. This is the economic point of the module, and the
  bench's `projectedMonthlyNoCacheUsd` exists to show the saving.
- **`searchCached` is all-or-nothing.** True only if there was ≥1 search and every search was a hit;
  a run that refined with a second, live search is honestly *not* "cached." Matches how the bench
  reads `done.searchCached` across the repeat workload.
- **Conservative key normalisation** (fold case + whitespace + trailing punctuation only). Options:
  minimal (exact string) vs conservative vs aggressive (strip all interior punctuation, like the
  grounding `normalize`). Chose **conservative**: it catches the real near-dupes ("What is X?" /
  "what is x") without merging genuinely distinct queries. The bench's repeats are exact-string so
  even minimal would pass; aggressive normalisation is the documented lever if a higher *real-world*
  hit rate is ever needed.
- **Time-sensitive queries bypass entirely** (SPEC SHOULD): "today"/"latest"/"current"/"now"/a
  year ≥ current → live search, no read **and no write** (never store a volatile row to serve stale).
  Trade-off: a "now"-containing evergreen query pays for a live search — accepted, erring toward
  freshness is never wrong, only slightly costlier.

**Verified (LRU tier + logic, without Atlas):** 16/16 in a throwaway harness (stubbed `fetch`, Mongo
forced unreachable) — normalize/key determinism + provider-sensitivity; time-sensitive detection both
directions; first call = live **miss**; near-duplicate repeat = LRU **hit that made ZERO provider
calls**; time-sensitive never caches (2 calls → 2 live searches); and search still succeeds with Mongo
down (fail-soft). The Mongo tier's real hit/write is **deploy-verified (M12)**, same as M2's transport
shell — see the Atlas gotcha above.

**Gotchas:**
- `WebResult[]` is not assignable to the contract's `results: z.record(z.unknown())[]` (no index
  signature) — one boundary cast at the Mongo write, commented inline.
- Mongo's TTL monitor runs on a **~60s cycle**, so an expired row can linger; the read filters
  `expiresAt > now` so a just-expired row is never served — belt-and-braces over the TTL index.

## M4 — Threads + messages

**What M4 is:** the conversation store — three routes (create / list / read a thread) plus the
message write-seam the ask loop (M2) will call — so a follow-up question can see the turns
before it. Pure MongoDB, no provider key, which is why it ships before the agent loop.

**Decisions / why:**
- **Ownership is enforced in the agent, not only at the gateway.** The gateway enforces that an
  `X-User-Id` is *present* (→401); the agent additionally filters *every* query by `userId` and
  treats "not yours" the same as "doesn't exist" (→**404, never 403**). Defense in depth: the
  private service never trusts that the edge scoped the data, and 404-not-403 avoids confirming a
  thread exists to a stranger. Trade-off: the user check lives in two services — accepted, because
  re-reading one header is cheap and the alternative (agent trusting its caller) is the whole
  class of IDOR bugs. The bench probes this exactly: `GET /threads/thr_nope` must be 404.
- **Store `createdAt` as a native Date; serialise ISO on the way out.** The DB document type
  (`iso = string | Date`) accepts either, but every HTTP response type is a `.datetime()` string.
  A Date keeps the `{userId, createdAt:-1}` index sort correct and cheap; a single `toIso()`
  crosses the boundary. Typing each response body with its contract type (`ListThreadsResponse`,
  `GetThreadResponse`) makes `tsc` reject a stray Date *before* runtime — the compiler is the test.
- **App-generated prefixed ids.** `newId('thr')` from the contract for threads (readable in a URL
  and a log line); a local `msg_…` generator for messages, because the contract's `newId` has no
  'msg' case and the contract is a red line — and `MessageDoc._id` is a plain string, so a local
  generator is contract-legal.
- **Validate with the contract's own zod schema inside the agent.** `CreateThreadBody.safeParse`
  → 400 with the zod message. The same schema the gateway will use, so there is no second
  definition to drift from.
- **Message order = `createdAt` asc with `_id` as tie-breaker.** `MessageDoc` has no `ord` field
  (unlike `ChunkDoc`), and the messages index is `{threadId:1, createdAt:1}`. A user turn and its
  answer are seconds apart, but the tie-breaker keeps a same-millisecond burst deterministic.

**Route wiring:** the three handlers live in `backend/agent/src/threads.ts` as an Express `Router`
mounted before the 501 loop; the loop now skips an `IMPLEMENTED` set instead of a hardcoded
two-route check, so each finished route stops returning 501 without disturbing the rest.
`requireUser` is attached **per route** (not router-level `.use`), so it never 401s unrelated
paths that merely pass through the mounted router (e.g. the auth-free `/evals/report.json`).

**Gotchas we actually hit:**
- **A throwaway `.mjs` in `C:\tmp` can't resolve the repo's `node_modules`.** Node resolves modules
  from the *script's* own directory upward, not from cwd — so `dotenv`/`mongodb` were "not found".
  Fix: keep one-off scripts *inside* the repo (and delete them after).
- **201 vs 200 on create.** The provided bench treats any 2xx as success (`if (!res.ok) throw`), so
  `POST /threads` can return a correct `201 Created` and still pass — no need to flatten to 200.

**Verified (live, against the agent on :8000):** 401 without `X-User-Id`; `201 {threadId}` with and
without a title (title trimmed; defaults to "New thread"); 400 on an empty title; `GET /threads`
newest-first and scoped per user; own thread → messages **in order** with `sources`/`done`/`answerId`
mapped and `createdAt` ISO-ified; unknown id and another user's id both → 404.

## M5 — Memory

**What M5 is:** durable, per-user facts/preferences that persist **across threads** (unlike M4's
per-thread message history) — written by two agent tools (`save_memory`, `recall_memory`) and
managed by two HTTP routes (`GET /memory`, `DELETE /memory/:memoryId`). Recall is a semantic
`$vectorSearch` over the `memories` collection, filtered by `userId`. Lives in
`backend/agent/src/memory.ts`, wired into the ask loop.

**Memory vs. thread history — why a separate store at all.** Thread messages (M4) answer "what did
we say *in this conversation*". Memory answers "what is true about *this user*, always" — "I prefer
concise answers", "I'm vegetarian". Different lifetime (survives thread deletion), different scope
(cross-thread), different retrieval (semantic, not chronological). Conflating them would either bloat
every thread read or lose the preference the moment the thread ends.

**Decision 1 — explicit, cue-gated extraction, NOT auto-extract-everything, and NOT piggy-backed on
the M2 tool-decision.** Three options considered:
- *(rejected) Auto-extract on every turn* — a second LLM pass on all traffic. Cost on every web
  query, and it saves noise ("the user asked about France" is not a durable fact).
- *(rejected, documented as the simpler-alternative) Fold the save decision into the M2 `decideNext`
  prompt* — one fewer call, but it pollutes the graded (20 pts) tool-decision prompt with a second
  job and risks regressing search/fetch quality. Kept the two concerns separate.
- *(chosen) A cheap regex **cue gate** → a dedicated lightweight extraction call only when the message
  plausibly states something durable* ("remember", "I prefer", "I'm a", "from now on", "my name is",
  …). The model then judges durability and returns `{"save":true,"text":"…"}` or `{"save":false}`.
  Ordinary web queries cost **nothing extra** (verified: zero LLM calls without a cue); the extra
  call fires only on the rare preference turn — and even then it runs **concurrently with the seed
  search**, so its latency is hidden behind the seconds of search+fetch.

**Decision 2 — recall is FAIL-SOFT; the HTTP routes are FAIL-LOUD.** This is the M2 fail-loud/
fail-soft split applied precisely: a *search* failure fails loud (502) because you cannot ground an
answer without it; a *memory recall* failure must **not**, because the answer never depended on it —
memory is best-effort personalisation. So `recallMemories` catches everything (Atlas down, embed
error, missing index) and returns `[]`; the answer proceeds un-personalised. The routes are the
opposite: a `GET /memory` that silently returned `[]` on a DB error would be lying to the user about
their data, so route errors propagate to a 502.

**Decision 3 — recalled memories shape the answer, they are NOT citable sources.** They are injected
into the synthesis prompt under a "User memory (do NOT cite as sources)" block, and the system prompt
is told to honor them in tone/format but never emit `[n]` for them or state a remembered fact as if
it were grounded. Rule 1 (grounded-or-nothing) still holds: every `[n]` resolves to a page fetched
*this request*; memory only changes *how* the grounded answer is written, never *what* is cited.

**Decision 4 — `userId` filter lives INSIDE `$vectorSearch`, not after.** The `memories_vector`
index declares `userId` as a `filter` field, so the vector stage itself restricts candidates to the
caller. This is both correctness (one user can never see another's memory — the isolation rule in
miniature) and efficiency (no "fetch 100, discard 99" post-filter). Cap `limit: 8` bounds the tokens
injected into synthesis. `deleteMemory` is likewise `{_id, userId}`-scoped, and "not yours" and "not
found" collapse to the same **404** — we never confirm another user's row exists (same 404-not-403
reasoning as M4).

**Decision 5 — DELETE returns 204.** The provided UI's `request` helper treats `204` as an empty
success (`if (res.status === 204) return undefined`), so `204 No Content` is the honest, body-less
response; a not-found/not-yours delete is `404`.

**Honest accounting:** the extraction call's tokens are added to `ctx.usage` (so cost/run-log stay
truthful even for a save turn); `save_memory`/`recall_memory` each emit a `trace` step, and a failed
save emits `ok:false` **with** an error string (contract rule A1) rather than throwing.

**Verified locally (12/12, `m5check.ts`, since deleted):** no cue → **0** LLM calls + null result;
cue + `save:true` → text extracted, one call, usage counted; cue + `save:false` → null (negative
parse path); recall with Mongo down → `[]` and **no throw** (embed still attempted). Typecheck green.
Boot check: agent starts with the router mounted, `GET /memory` and `DELETE /memory/:id` return
**401** without `X-User-Id` (route is live, not the 501 fallback). The live `$vectorSearch` + insert
defer to the M12 deploy — Atlas is TLS-blocked locally (see §Gotchas), the same class as M2's
transport shell and M4's ownership check.

## M6 — Run log

**What M6 is:** one `runs/<requestId>.json` per answer, in the contract's `RunLog` shape, so the
loop's behaviour is observable and *gradeable* after the fact. `quality/check.mjs` reads this folder;
it is not optional decoration — several error-severity rules derive their verdict from it.

**Decisions / why:**
- **Observability is written by the loop, not bolted on.** `writeRunLog(run)` is called on **both**
  paths: the success path (from the `done` event) and the fail-loud catch (from `ctx` alone, which
  has no `DoneEvent` — a provider error mid-loop still spent tool calls and tokens worth logging).
  Both go through `writeRunLogSafe`, which swallows a *disk* error: failing to write a log must not
  turn a good answer into a 502 (the log is a side effect, not the product).
- **`done` → `runs/`, everything else → `runs/failing/`.** A run that terminated `cap` or `error` is
  filed separately so a human (P1) and the eval can find the deliberate failing trajectory without it
  polluting the healthy set. Crucially the loop **never relabels** a capped/errored run as `done`
  (rule A2) — the run log records the true `terminated` value.
- **`tokens` is a single total number**, `wallClockSec`/`costUsd`/`ttftMs`/`latencyMs`/`searchCached`
  mirror the `done` event, and `toolCalls` is `{name, ok, error?}[]` — exactly the fields the checker
  reads, so log shape and grader stay in lockstep (the compiler enforces the shape at the write site).

**How the grader reads it (and why our shape passes):** A1 = every `ok:false` tool call carries a
non-empty `error`; A2 = `terminated === "done"`; A3 = no tool called >N times consecutively; B1/B2/B3
= `tokens`/`wallClockSec`/`costUsd` under the declared budget. `expectations.json` sets the **deep**
envelope (180k tokens, 24 calls, 240s, $0.35) as the single budget `check.mjs` applies to every run,
because it cannot say "only quick"; the tighter quick envelope is enforced per-run by `bench.mjs` off
the run's `depth`. `maxConsecutiveSameTool` is **4** (not 3) so a deep search may legitimately fetch
several pages in a row for one sub-question.

**Verified (`node quality/check.mjs .`, real M2 run logs):** **0 errors** — A1 ✓ (a failed
`fetch_page` carries `"fetch failed"`), A2 ✓ (both `done`), A3 ✓ (fetch streak 3 ≤ 4), B1/B2/B3 ✓
(3388 tok / 22s / $0.005 all well under budget), C1 ✓, E1 ✓ (gold set, 39 items). The one warning
(P2, "rules lack a real precedent") is a property of the provided `quality/rules.json` — a
**DO-NOT-EDIT** scaffold file — not our code; `E2`/`E3`/`P1` are the M13 eval + manual steps.

## M7 — Spaces + jobs worker

**What M7 is:** a Space is a folder of the user's own documents that a Space search (M8) retrieves
over. M7 is the ingest half: upload a PDF/markdown/text file, and asynchronously turn it into
searchable, citable chunks. Three files: `ingest.ts` (pure parse+chunk), `spaces.ts` (CRUD + the
upload route), `worker.ts` (the async job runner). Pipeline: **upload → GridFS → parse → chunk →
embed → upsert → read-your-write probe → `indexed`**.

**Decisions / why:**
- **Async 202 + a worker, NOT inline ingest.** A 60-page PDF is hundreds of embed calls and many
  seconds of work; doing it in the request would blow the accept-latency SLA (bench `accept202`,
  p95 ≤ 300 ms), pin an HTTP connection open for the whole ingest, and lose all progress if the
  socket dropped. So the route does the *cheap* durable part only — write raw bytes to GridFS,
  insert a `pending` `DocumentDoc`, enqueue an `index_document` `JobDoc` — and returns
  `{docId, status:"pending"}` (**202**). A separate process (`npm run worker`, deliberately NOT
  started by `npm run dev`) does the heavy compute. The bench proves the decoupling by measuring
  **search p95 *during* an ingest** (`runIngestDecoupling`): a blocking implementation shows up as a
  failed search SLA, not a mystery. The client watches progress by polling
  `GET /spaces/:id/documents` as status walks pending → parsing(10%) → embedding(50%) → indexed(100%).
- **The claim is atomic.** `jobs.findOneAndUpdate({status:'pending'}, {$set:{status:'running',
  claimedAt, workerId}, $inc:{attempts:1}}, {sort:{createdAt:1}, returnDocument:'after'})` flips
  exactly one row and hands it back, so two workers can never grab the same job. Oldest-first
  (`sort createdAt:1`) is FIFO fairness.
- **Crash-safe via a stale-claim sweeper.** A worker killed mid-job leaves its row `running` with a
  `claimedAt` that stops advancing. Each loop the sweeper returns `running` rows older than
  `STALE_MS` (2 min) to `pending` for retry — until `MAX_ATTEMPTS` (3), after which the job *and* its
  document are marked `failed` so the client's poll terminates instead of spinning forever. Transient
  errors (a free-tier embed 429) go back to `pending`; a permanent one (unparseable file) fails after
  the retries. The worker's whole loop is `try/catch` + backoff, so a Mongo blip **backs off**, it
  does not crash (verified: the worker survives the local Atlas TLS block instead of exiting).
- **Read-your-write probe earns the `indexed` status.** "Upserted" is not "searchable": Atlas Search
  indexes are eventually consistent. After inserting the chunks we query the *vector index* for one
  we just wrote, using its **own embedding** as the query (its nearest neighbour is itself,
  cosine ≈ 1), filtered by `spaceId`+`userId`, and only flip the doc to `indexed` once it comes back
  (retry with backoff, ~up to 50 s). Without the probe, the bench's "poll until indexed, then a doc
  search finds it" contract would be racy — a doc could read `indexed` a beat before it is queryable.
- **Chunking is page-aware and locator-bearing.** A `doc` citation must say *where* in the document
  the claim is (SPEC 7 / bench `pageLocator`). So a PDF chunk carries `{page}` (one segment per page
  via `pdfjs-dist` `getTextContent`, text-only, no rendering) and a text/markdown chunk carries
  `{line}` (+ nearest `heading`). Chunks are ~1200 chars with ~150 overlap so a sentence split across
  a boundary still lands whole; a chunk **never spans a page boundary**, or its `{page}` locator would
  be a lie. `MAX_CHUNKS_PER_DOC` (800) bounds embed cost on a pathological upload. `ingest.ts` is kept
  **pure** (no Mongo/GridFS/network) precisely so these finicky boundaries are testable on a generated
  PDF without a database — which matters because Atlas is TLS-blocked locally.
- **Batched embeddings for ingest.** Added `embedBatch()` (Gemini `batchEmbedContents`, 50/req)
  alongside the memory path's one-per-call `embed()`: a doc's hundreds of chunks become a handful of
  HTTP calls, which both cuts wall-clock and, more importantly, stays under the free tier's
  requests-per-minute limit (200 single calls = 200 requests; 4 batches = 4). Order-preserving,
  fail-loud, validates 1536 dims.
- **Idempotent upsert.** The worker does `chunks.deleteMany({docId})` then `insertMany` with
  deterministic ids (`chk_${docId}_${ord}`), so a retried/swept re-run replaces rather than duplicates.
- **Ownership like threads.** Every query is scoped by `userId`; a space that isn't yours reads as
  **404, never 403**. Ownership is checked *before* the GridFS write so an unowned space leaves no
  orphan file. Upload rejects: oversize → **413** (multer `LIMIT_FILE_SIZE`, enforced before the body
  is fully buffered), missing file field → **400**, unaccepted content-type → **400** (the contract
  has no 415; a bad type is a bad request).

**Verified:** `ingest.ts` parse+chunk — **13/13** on a generated PDF + markdown (pageCount, one
segment/page, page locators 1‑2‑3, `bench-page-N` text, `ord` 0..n‑1, every chunk has a page locator,
markdown line+heading locators, over-long segment windowed ≤ 1200 chars). `embedBatch` verified live
(3 texts → 3×1536 in one call, M-prior). Typecheck green. Boot: `POST/GET /spaces` and
`POST/GET /spaces/:id/documents` mounted (no longer 501); auth gate **401** without `X-User-Id` on all
four, body validation **400** on empty/missing `name`. Worker boots cleanly and *survives* the DB
error (loop try/catch → backoff, no crash). **Deploy-deferred (M12, Atlas TLS-blocked locally):** the
GridFS round-trip, the chunk upsert, and the vector probe — i.e. the actual walk to `indexed` and the
bench's `accept202`/`indexedViaWorker`/`pageLocator` caps, which need a reachable Atlas.

**Systemic fix that fell out of M7 — Express 4 async crashes → 502.** This is **Express 4**, which
does *not* forward an async handler's rejection to the 502 error middleware; a rejection becomes an
unhandled promise rejection and **crashes the Node process** (seen locally the instant a route hit the
blocked Atlas). Every DB route shares this — `threads.ts`, `memory.ts`, `ask.ts`, `spaces.ts` are all
`async (req,res)=>{ await db()… }` — so rather than give `spaces.ts` a bespoke try/catch, the fix is
**app-wide**: `import 'express-async-errors';` as the first import in `index.ts` patches the router so
every async rejection is routed to the existing 502 handler (Express 5 does this natively; on 4 it
needs the shim). Verified Atlas-independently: `POST /spaces` with a valid body now returns
**502 `{"error":"Topology is closed"}`** and the process **stays alive** (`/health` → 503 afterward),
where before the fix the same request killed the agent. This is fail-loud done right — a DB/provider
error is a 502, never a crash and never a faked answer — and it hardens all four DB routers at once.

## M8 — Hybrid retrieval

**The task:** a `search_documents` tool + an `auto` router so a quick answer can be grounded in a
Space's *uploaded documents* (the M7-indexed chunks) instead of the web, citing them with page/line
locators. New file: `retrieval.ts`; `ask.ts` grows a router and a second retrieval arm.

**Decision 1 — vector-only vs text-only vs hybrid (RRF).** Vector search ($vectorSearch over the
1536-dim embeddings) matches *meaning* — it finds "automobile" when you ask "car" — but is weak on
rare exact tokens (a part number, an acronym, a name it never saw embeds like noise). BM25 text
search ($search) is the mirror image: superb on exact/rare terms, blind to paraphrase. Real questions
need both, so I fuse them. The trap is that cosine scores and BM25 scores live on incomparable
scales — you can't add or threshold them. **Reciprocal Rank Fusion** sidesteps that entirely by
fusing *ranks*, not scores: `score(chunk) = Σ 1/(RRF_K + rank_in_that_list)`, RRF_K=60. A chunk near
the top of *either* arm scores well; near the top of *both* wins. Rank-based fusion is why no
normalisation is needed. Each arm looks `ARM_LIMIT=20` deep (deeper than the final `k=6`) so fusion
has material; vector uses `numCandidates=100`.

**Decision 2 — filter INSIDE the search stage, never a later `$match`.** Both the `spaceId` and
`userId` filters go *inside* `$vectorSearch.filter` and inside the text arm's `compound.filter`
(equals-on-token) — not a `$match` after the stage. A limited search returns its *top N globally*,
then a later filter would hide the ones from other Spaces/users, leaving you with far fewer than N
of your own — silently wrecking recall. `scripts/indexes.json` declares the filter fields for
exactly this reason. This is also the **isolation guarantee**: the in-stage `userId` filter means a
request can never reach another user's chunks even with a stolen/guessed `spaceId`, which is why
the ask route needs *no* separate Space-ownership 404 — a foreign `spaceId` can only ever return
nothing.

**Decision 3 — asymmetric fail model.** The **vector arm is fail-loud**: an Atlas/embed error
propagates → 502, because we cannot ground a docs answer with no vector recall (faking one is the
red-line violation). The **text arm is fail-soft**: a BM25 hiccup is caught and degrades to
vector-only — hybrid is an *enhancement* over a working core, not a dependency, so a flaky text
index must never sink an answer the vector arm could still ground.

**Decision 4 — routing: `auto` | `web` | `docs`.** `docs` → the Space only (a retrieval failure is
fail-loud); `web` → the web; `auto` → documents *when a Space is attached*, with a **web fallback**
if the Space turns up nothing relevant OR the doc arm errors (fail-soft to web). `mode:'docs'`
without a `spaceId` is a 400 *before* any stream opens — it's a meaningless request, caught at the
edge like every other validation. The web sub-loop from M2 was extracted verbatim into
`runWebRetrieval()` so both arms are peers; nothing about the web path changed.

**Decision 5 — a source-agnostic `Readable`.** Web pages and doc chunks are different shapes, but
synthesis and `[n]`-grounding must be *identical* regardless of where the answer came from. So each
arm's builder (`fromWebPages` / `fromDocHits`) emits both the wire `Source[]` (web → `url`; doc →
`docId` + `locator`) and an internal `Readable[]` (`{n, label, text}`) — pre-numbered passages the
synthesiser cites. `synthesisUser` now takes `Readable[]`; the prompt is the same for both. Doc
Sources carry the `locator` (PDF → `{page}`, markdown/text → `{line, heading}`) the bench's
`pageLocator` check and the UI both need to point back at the exact place in the document.
`DOC_TOP_K=6` — enough distinct passages to answer with citations, few enough to stay in the
synthesis token budget (each chunk is already ~1200 chars from the M7 chunker).

**Verified LIVE (Atlas reachable this session — the corporate port-27017 TLS interception wasn't
active on this network).** The whole RAG path, deploy-deferred until now, ran end-to-end: upload a
markdown doc → worker indexed it (`chunks:1`, `pct:100`) → docs-mode ask streamed
`trace(search_documents, ok:true) → sources(kind:'doc', docId, locator:{line:1, heading:"…"}) →
token* → done(terminated:'done')`, with the answer grounded verbatim in the doc and cited `[1]`.
`auto`+Space correctly routed to `search_documents` (not `web_search`); `mode:'docs'` without a
`spaceId` → 400; no-user → 401. **This also live-verified all of M7's worker pipeline** (GridFS
read → parse → chunk → embed → idempotent upsert → read-your-write vector probe → `indexed`), which
had only ever been unit-verified before.

## M9 — Deep search

**The task:** a second "gear". Where the quick loop answers one question, deep search *decomposes*
a question into 3–6 sub-questions, researches each, and synthesises one grounded answer across all
of them — streaming a `plan` event first so the client sees the shape of the work before it starts.
New in `ask.ts`: `planResearch()`, `runDeepAnswer()`, `researchSubQuestion()`, `mergeDeepSources()`,
plus the daily-cap gate.

**Decision 1 — decomposition prompt, with a deterministic fallback.** `planResearch()` makes one
JSON-mode LLM call (`temperature 0.2`) asking for `deepSubQuestionsMin..Max` (3..6) sub-questions,
each with a `question` and a one-line `reason`. `parsePlan()` strips code fences, `JSON.parse`s,
keeps only non-empty questions, slices to `max`, and renumbers `i=1..`. The planner is the one place
a bad model response could sink the whole run, so it's defensive: **if fewer than 2 usable
sub-questions come back, it falls back to a generic 3-facet decomposition** (`fallbackPlan`) rather
than erroring. A weak plan still produces a real, grounded answer; only a provider *exception* is
fail-loud.

**Decision 2 — stream `plan` BEFORE retrieving.** The deep SSE order is `plan → trace* → sources →
token* → done` (quick omits `plan`). The `plan` event fires the instant the decomposition returns,
*before* any search — so a client can render "here's how I'll research this" while the (slow, free-
tier) searches run. `plan_research` is then also logged as trace `step 1`. Emitting `plan` first is
a contract requirement and the reason `plan_research` may **never** appear in a quick run (a red
line).

**Decision 3 — deterministic fan-out: only 2 LLM calls total.** The quick loop is *agentic* — the
model decides each fetch. Deep search is deliberately **not**: each sub-question runs one
deterministic `web_search` + up to `DEEP_FETCH_PER_SQ=2` new-URL `fetch_page`s, with **no
per-sub-question decision call**. So a deep run is exactly **two** LLM calls — `plan_research` +
final synthesis — regardless of sub-question count (searches/fetches are tool executions, not LLM
turns). The alternative (run the full agentic loop per sub-question) would be `~2N+` LLM calls; on a
3–10 s/call free tier that's the difference between a 30 s answer and a 3-minute one. Fan-out breadth
buys the coverage that per-question reasoning depth would, at a fraction of the latency/cost.
A shared `fetchedUrls` set dedupes across sub-questions so two facets don't fetch the same page twice.

**Decision 4 — merge into ONE citation numbering, tag provenance.** Each sub-question's pages come
back tagged with its index; `mergeDeepSources()` flattens them into a **single `[1..n]` sequence**
(dedup by URL) so the synthesiser and the reader see one numbered source list, exactly as in a quick
answer — `[3]` means the same thing everywhere. Each `Source` additionally carries `subQuestion` so
the UI can show *which* facet a source served, without ever fragmenting the citation space.
(Verified live: 7 sources, `[1..7]`, tagged 1→[1], 2→[2,3], 3→[4,5], 4→[6,7].)

**Decision 5 — two independent caps, both at the agent.** (a) **Per-run** caps are wider than quick:
`maxToolCallsDeep=24`, `maxWallClockSecDeep=240`. An `overCap()` closure checks both before each
sub-question and before each fetch batch; tripping it **breaks the loop and sets
`terminated:'cap'`** — a partial answer honestly labelled, never relabelled `done` (a red line).
(b) **Per-user daily** cap `DEEP_DAILY_CAP=5`: checked *before any work*, returning `429` with
`resetsAt` = next UTC midnight if exceeded. Per the architecture the agent is the **only** cap
enforcer (the gateway holds no state); the gate lives in the ask route, right after validation.

**Decision 6 — count the daily cap from persisted messages, not run logs.** `deepRunsToday(userId)`
counts `messages` where `role:'assistant'`, `done.depth:'deep'`, and `createdAt >= startOfUtcDay()`.
Why messages and not the run log: **run logs are written to disk only** (`runs/`), not Mongo, so
they can't be counted per-user across instances; the `messages` collection is the durable,
`userId`-scoped, deploy-surviving record. `createdAt` is a BSON `Date`, so the `$gte` compares
against a JS `Date` object (not an ISO string). The count reads the `done.depth` marker that every
deep answer persists — which is exactly why `done` carries `depth` even though the quick default is
implicit.

**Verified LIVE (Atlas reachable).** A deep run of a broad multi-facet question streamed the full
`plan(4 sub-questions, each with reason) → trace(plan_research, step 1) → per-sub-question
trace(web_search/fetch_page, each tagged subQuestion 1–4, one fetch 403 → ok:false and the run
continued) → sources([1..7], merged, each tagged) → token*(grounded, citing [1]–[7]) →
done(depth:'deep', subQuestions:4, terminated:'done')`. Run log: 13 tool calls (1 plan + 4 search +
8 fetch), 31.6 s wall (≪ 240 s cap), \$0.021. The **429 gate** was verified on a throwaway agent
started with `DEEP_DAILY_CAP=0`: a deep request returned `{error, resetsAt:"…T00:00:00Z", status:429}`
*instantly* (before any provider call), while a quick request to the same instance did **not** trip
it — confirming the cap is deep-only. The persisted assistant message carries `done.depth:'deep'`
and `done.subQuestions:4` (the durable record the daily count reads); the plan's sub-question array
is stored on the `MessageDoc` too, though the wire `ThreadMessage` contract deliberately doesn't
surface it.

## M10 — Gateway build-out

**The task:** the skeleton gateway answers `501` for every route but `/health`. Build it into the
real browser-facing edge: enforce `X-User-Id` (401), validate bodies (400), rate-limit (429), and
**proxy** everything else to the agent — including streaming SSE straight through — failing loud
(502) when the agent can't be reached. It holds **no provider key**. New files: `proxy.ts`,
`ratelimit.ts`; `index.ts` grows the wiring.

**Decision 1 — edge vs core: the gateway is a dumb pipe, the agent owns every decision.** The only
things the gateway *decides* are the four edge concerns (auth, body shape, request rate, is-the-
agent-up). Everything else — routing, retrieval, caps, grounding — is the agent's, and the gateway
just forwards. This is why no key lives here: the public edge can be scraped, rate-probed, and
fuzzed, and the worst a caller reaches is a proxy with nothing secret in it. The split also means
the two services can deploy independently (public gateway on Fly, **private** agent with the keys).

**Decision 2 — validate at the edge with the *same* contract schema.** `POST` bodies are
`safeParse`d against the shared `@lumina/contract` zod schema (`AskBody`, `CreateThreadBody`,
`CreateSpaceBody`) *before* the agent is touched — a bad body is a `400` with the zod message. One
schema, enforced at the door and re-used by the agent, so there's no drift between "what the edge
accepts" and "what the core expects." The bench proves this is edge-side: `POST /threads/thr_x/ask`
with `{}` must be `400` even though `thr_x` doesn't exist — the request must never reach the agent,
so the validation can't live there.

**Decision 3 — SSE pass-through must not buffer, or TTFT dies invisibly.** For a streaming reply the
gateway sets the SSE headers (`text/event-stream`, `Cache-Control: no-transform`, and crucially
`X-Accel-Buffering: no` so Fly's/nginx's proxy doesn't hold the stream for a bufferful) and relays
the upstream bytes **as they arrive**, flushing each chunk. It must **detect** a stream vs an error
first — the agent replies `text/event-stream` on success but plain JSON on an early `400`/`429`/`404`
— so the proxy branches on the upstream `content-type`. Buffering here would pass every functional
test and silently blow the TTFT SLA, a bug no profiler shows. The proxy also aborts the upstream
`fetch` when the browser hangs up (`res.on('close')`), so a client that leaves doesn't keep the
agent spending.

**Decision 4 — forward non-stream replies VERBATIM; never invent a status.** For everything else the
gateway forwards the agent's status **and body unchanged**. This is the whole reason the deep-cap
`429` (with its `resetsAt`), the ownership `404`, the oversize `413`, and a provider `502` survive
the hop intact — the edge is a mirror, not an interpreter. A gateway that "helpfully" remapped an
upstream `429` to a `503`, or swallowed a `404` into a generic `500`, would break the contract the
grader checks route by route.

**Decision 5 — fail loud at the edge too.** A failure to *reach* the agent (connection refused,
DNS, timeout) is a `502` — never a `2xx` over a dead upstream (rule A1, applied one layer out). The
proxy handler is `async`, and Express 4 turns an unhandled rejection into a **process crash**, so
each proxied route is wired as `proxyToAgent(req,res).catch(next)` → the `502` error middleware.
(Same Express-4 hazard fixed in the agent with `express-async-errors`; here `.catch(next)` is the
lighter, dependency-free equivalent for the handful of proxy routes.)

**Decision 6 — rate-limit placement: the expensive route, per user.** The per-minute limit sits on
`POST /threads/:id/ask` **only** — the one route that costs real money (LLM + search) and the one
worth flooding — and deliberately **not** on the cheap reads, because the UI legitimately *polls*
`GET …/documents` every second while a doc indexes and throttling that would break the product for
no gain. It's a fixed window in memory keyed by `X-User-Id` (so one user's burst can't starve
another), returning `429` + `resetsAt` — the same shape as every other cap. A tripped request is
rejected **before** the proxy, so it costs nothing. (Per-instance; a multi-machine deploy would move
the counter to a shared store — noted in DESIGN.md, out of scope for one Fly machine.) This is a
*different* 429 from the agent's per-day deep cap: per-minute request rate vs per-day deep spend.

**Decision 7 — stream the multipart upload raw.** `POST …/documents` is `multipart/form-data`; the
gateway must **not** parse it (that's the agent's job, and parsing would need the file in memory
twice). The JSON body middleware skips that route, and the proxy streams the request body straight
through (`Readable.toWeb(req)`, `duplex:'half'`) with the original `content-type` so the multipart
boundary survives untouched.

**Verified LIVE** against a gateway pointed at the running agent (`:8011`), plus a throwaway gateway
pointed at a **dead** agent port with `RATE_LIMIT_PER_MINUTE=1` to exercise 502+429 at zero LLM cost:
`GET /memory` no `X-User-Id` → **401**; `GET /evals/report.json` no header → **404** (not behind
auth, `auth:false`); `POST …/ask` `{}` → **400** `"query: Required"` (edge validation, agent never
hit); `GET /threads/thr_nope` → **404** forwarded verbatim; `POST /threads {}` → **201**
`{threadId}` (JSON proxy); a quick `ask` → SSE relayed `trace* → sources → token* → done` (sources
before the first token) with `Content-Type: text/event-stream`, `X-Accel-Buffering: no`, and
`x-request-id` set; `ask` to the dead upstream → **502** `"agent unreachable: fetch failed"`; a 2nd
`ask` from the same user (limit 1) → **429** `{error, resetsAt, status}` *before* the proxy; a 3rd
`ask` from a **different** user → **502** not 429 (per-user isolation). `/health` returned **200**
when the agent was up and **503** (degraded) when pointed at the dead agent — nesting the agent's
real status, never pretending.

## M11 — Observability + /stats

**The task:** make a single request greppable end to end (one `X-Request-Id` across the gateway and
agent logs), and stand up `GET /stats` returning the `StatsResponse` snapshot — requests/answers
counts, search-cache hit rate, TTFT p95, cost today, and the deep-search used/cap. The rubric adds
a reconciliation bar: **/stats.answers and /stats.costUsdToday must match the agent log within 1 %**.
New files: `requestlog.ts` (correlation middleware + the `requests` collection writer), `stats.ts`
(the handler); `index.ts` and `ask.ts` grow a few lines.

**Decision 1 — one correlation id, set once, read everywhere.** A `requestContext` middleware runs
*before* every router: it adopts the inbound `X-Request-Id` (the gateway forwards one) or mints one
for a direct call, puts it on `res.locals.requestId`, and echoes it on the response header. The ask
route used to derive its *own* id — which was a latent bug: on a direct call with no inbound header,
the middleware and the ask route would each mint a **different** id, so the response header, the run
log and the requests row would disagree. Now the ask route *reads* `res.locals.requestId`, so all
four artifacts (header, pino line, `runs/<id>.json`, `requests` row) carry the **same** id. That is
what "correlate a request across the gateway and agent logs" actually requires — not just logging an
id, but logging the *same* id in every place.

**Decision 2 — /stats is per-user, derived from durable records, never a live counter.** The web UI
renders `deepToday`/`deepDailyCap` as a personal quota, so the whole snapshot is scoped to the
caller. And every number is *computed from what was persisted*, not from an in-memory tally:
`requests` from the `requests` collection; `answers`/`costUsdToday`/cache-hit-rate/`ttftP95Ms`/
`deepToday` from the assistant messages' `done` events; `deepDailyCap` from config. Why not a running
counter: a counter drifts from reality on a restart or a second replica (Fly can run more than one),
and then `/stats` would *disagree with the log* — the exact thing the reconciliation bar tests.
Deriving from records means the number is *defined* to match the log.

**Decision 3 — sum the `done` events, not `runs/`, for the money numbers.** The disk run logs are the
canonical per-answer record, but they're files keyed by requestId — not per-user queryable. Each
`done` event carries the **same** `costUsd`/`ttftMs`, copied verbatim from the run it logged, and is
stored on the owning (user-scoped) message. So `Σ done.costUsd for {this user, today}` reconciles
with `runs/` *by construction* — the two can't drift, which is how we clear the 1 % bar with room to
spare (measured: **0 % diff**, the numbers were byte-identical).

**Decision 4 — the `requests` collection is the HTTP-layer log, and stays that way.** On `res.finish`
the middleware writes one `RequestDoc {requestId, userId, route, status, ms}`. Deliberately *not* the
answer economics (cost/tokens/terminated/depth) even though `RequestDoc` has optional slots for them:
those live on the `done` event / run log, and duplicating them here would create two numbers that can
disagree. One row per request, HTTP-level facts only. This row is both the `requests` count and a
durable, requestId-keyed audit ("who called what, how did it end") — the *log* side of the
correlation story, complementing the pino line (which is ephemeral) with something queryable.

**Decision 5 — the log is fail-SOFT; the API is fail-LOUD.** The `requests` write runs on `finish`,
*after* the response is already sent, so a DB hiccup there is swallowed with one `warn` — a broken
observability sink must never turn a good answer into an error. That is the mirror image of the
handler itself: `/stats` is `async`, so a DB error on the *read* path propagates to the 502 handler
(via `express-async-errors`) — it never reports a comforting zero over a broken query. Two different
correct behaviours for two different layers: the side-effect log tolerates failure, the API surfaces
it. And the row is only written when there's an `X-User-Id` to attribute it to, so `/health` and
rejected-401 calls are logged (pino) but stay out of the per-user `requests` count.

**Decision 6 — nearest-rank p95, matching the bench.** `ttftP95Ms` is the smallest sample at or above
the 95th percentile of today's `done.ttftMs` values (computed in JS after a single aggregation pass),
which is how the bench computes its own percentiles — so `/stats` agrees with the tool that grades
it, rather than using a different interpolation and reading "wrong" by a few ms.

**Verified LIVE** (Atlas reachable; agent on `:8011`, hot-reloaded via `tsx watch`): `GET /stats`
with no `X-User-Id` → **401**; a fresh user → **200** `{requests:0, answers:0,
searchCacheHitRatePct:0, ttftP95Ms:0, costUsdToday:0, deepToday:0, deepDailyCap:5}` (exact
`StatsResponse` shape). Then a quick `ask` carrying a **known** `X-Request-Id: req_m11test001` →
response header echoed `req_m11test001`, streamed `trace*→sources→token*→done`
(`terminated:done, depth:quick, costUsd:0.0052049, ttftMs:5264`). `/stats` then read
`{requests:3, answers:1, searchCacheHitRatePct:0, ttftP95Ms:5264, costUsdToday:0.0052049,
deepToday:0, deepDailyCap:5}` — `costUsdToday` and `ttftP95Ms` **byte-identical** to the run log
`runs/req_m11test001.json` (0 % diff, ≤1 % bar cleared). The persisted `requests` row for
`req_m11test001` carried `{userId:u_stats1, route:"/threads/:threadId/ask", status:200, ms:8522}`
— i.e. the **same id** appears in the response header, the run-log filename, and the requests row
(full correlation); the other rows (`/stats`, `/threads`) each **minted** their own id, proving both
the adopt and mint paths. A **repeat** identical query hit the M3 search cache → `searchCached:true`
(cost fell to `$0.0002`), and `/stats` then read `{answers:2, searchCacheHitRatePct:50,
costUsdToday:0.0054066}` — the cache-hit ratio (1 of 2) and the **cumulative** cost
(`0.0052049 + 0.0002017`) both exactly right. Typecheck green; quality gate **0 errors** (the lone P2
warning is the pre-existing one in the DO-NOT-EDIT `quality/rules.json`).

## M12 — Deploy

**What M12 is:** put the whole system on the public internet — both backend services + the UI — so
`/evals` and the grader hit a live URL, with the four rules still holding (agent private, no secret in
the browser). It's the one module whose result *can't* be faked locally: it's the first place Atlas, the
full HTTP+SSE path, and CORS are all real at once.

**The pivot — Fly → Render (why earlier notes say "Fly").** M0–M11 were written against the *planned*
target: two Fly.io apps — a public `lumina-gateway` and a **private** `lumina-agent` on Fly's 6PN network
(`lumina-agent.internal:8000`, no public IP). Fly requires a credit card even on small plans; this is a
personal, isolated project, so I pivoted to **Render's free tier** ($0, no card). That's why "Fly",
"`.internal`", and "one Fly machine" survive in the M2/M10/M11 notes and the two `backend/*/Dockerfile`s —
they describe the original target. The *deployed* system is Render, described here; the Fly config stays
in-repo as a valid (untested) future target (`DEPLOY.md` appendix), not deleted.

**Decision 1 — R1 topology: one container, three processes (NOT two services).** Render's free tier has
no private service, no standalone worker, and exposes exactly **one** public port per web service — Fly's
"separately-deployed private agent" model doesn't map onto it. So all three processes run in **one**
container via a launcher (`render-start.mjs`): the **gateway** binds `0.0.0.0:$PORT` (the only thing Render
routes the internet to), the **agent** binds `127.0.0.1:8000` (loopback — reachable only by the co-located
gateway), the **worker** listens on no port. This preserves the "agent not public" red line exactly: Render
routes nothing but `$PORT`, so a loopback bind is as private as Fly's 6PN, achieved with an env var instead
of a network. Added `bindHost` to `agent/src/env.ts` (`AGENT_BIND_HOST`, default `0.0.0.0` for local dev,
set to `127.0.0.1` by the launcher) and `app.listen(env.port, env.bindHost, …)` in `agent/src/index.ts`.
If any child exits, the launcher tears the container down and exits non-zero so Render restarts it whole.
Trade-off vs the Fly split: the three processes lose crash-isolation and independent deploys — accepted for
$0. (Alternatives: R2 two Render services needs a paid private service; R3 agent-as-Render-worker isn't free.)

**Decision 2 — secrets are Render env vars, never in the repo or the image.** `render.yaml` (a Blueprint)
declares non-secret config inline (`NODE_ENV`, `LLM_PROVIDER=google`, `LLM_MODEL=gemini-3.5-flash-lite`,
`EMBEDDING_MODEL=gemini-embedding-001`, `SEARCH_PROVIDER=tavily`, `VECTOR_BACKEND=atlas-vector-search`,
`MONGODB_DB=lumina`, `DEEP_DAILY_CAP=5`) and lists the four secrets as `sync:false` — Render does **not**
create or store them; a human sets them once in the dashboard (`MONGODB_URI`, `GOOGLE_API_KEY`,
`TAVILY_API_KEY`, and later `CORS_ORIGINS`). The gateway holds none (only the agent process reads keys);
`.env` is `.dockerignore`d so no key enters the image. Those explicit `LLM_*`/`EMBEDDING_*` values are also
what override the scaffold's Anthropic/OpenAI defaults (see §M0) so `/health` names the Gemini model served.

**Decision 3 — Render builds from GitHub, so the code goes to a personal repo.** Render deploys from a Git
branch (no local push). Pushed to a **personal** repo (`prateekdhawan/FDE`) via the OS credential manager as
the personal account — deliberately *not* the work-managed `gh` login (isolation). `autoDeploy:true` → every
push to `main` rebuilds. `region: singapore` = closest free Render region to the Atlas M0 (AWS ap-south-1,
Mumbai), to keep the DB hop short.

**Decision 4 — the UI deploys from the repo ROOT on Vercel, not from `web/`.** `web/` imports
`@lumina/contract` and extends the root `tsconfig.base.json`, so a `web/`-only deploy can't build. A root
`vercel.json` runs `npm install`, builds `@lumina/contract` → `@lumina/web`, and serves `web/dist` with a SPA
rewrite. `VITE_API_URL=https://lumina-8cqp.onrender.com` is passed at build time (`--build-env`) and baked
into the bundle — a **public** value (the gateway URL), never a key. Why Vercel and not let the gateway serve
the UI: the gateway's SPA fallback regex *excludes* `/evals`, so a hard-refresh on `/evals` would 404 if the
gateway hosted the UI; Vercel's rewrite handles every route.

**Trade-offs accepted:**
- **Free-tier cold start.** The service sleeps after ~15 min idle and takes ~50 s to wake. With the M2
  free-tier Gemini latency, a cold first query runs ~27 s TTFT — far over the 2500 ms SLA. Deliberate cost of
  staying free + isolated; warm quick-searches are the fast path, and the timing gate is provider/tier-bound,
  not architectural (see §M2).
- **One instance.** The in-process LRU cache (M3) and in-memory rate-limit window (M10) are per-instance; on
  one free container that's correct, and both are flagged in DESIGN.md as needing a shared store if scaled >1.

**Gotchas we actually hit:**
- **Docker build failed: `TS5083 Cannot read file '/app/tsconfig.base.json'` (+ a downstream `TS2802`
  downlevelIteration in `sse.ts`).** Root cause: `Dockerfile.render` copied each workspace but not the shared
  `tsconfig.base.json` that *every* workspace tsconfig `extends`; without it `tsc` can't read the compiler
  options and falls back to a pre-ES2015 target (hence the iterator error). Fix: `COPY tsconfig.base.json ./`
  before the build. **The two Fly Dockerfiles have the identical latent bug and were never build-tested** —
  flagged in `DEPLOY.md` for anyone reviving that path.
- **Atlas is reachable from the Render cloud (`/health → db:"ok"`).** The corporate port-27017 TLS-inspection
  block that made Atlas unreachable on the *work laptop* (see §M2 Gotchas) does not exist in Render's cloud —
  so every "deploy-deferred (Atlas TLS-blocked locally)" item from M2/M3/M5/M7 is finally real against the
  public gateway (M8/M11 had already caught an at-home Atlas window).
- **`CORS_ORIGINS` didn't appear in the Render dashboard.** Because it's `sync:false`, Render doesn't
  pre-create it — it must be *added* manually (key + the Vercel origin, no trailing slash). Verified from the
  CLI that the preflight for `/health` **and** `/ask` carrying the real UI header `x-user-id` returns `204` +
  `access-control-allow-origin: <Vercel origin>` + `access-control-allow-headers: x-user-id` (the `cors`
  package reflects the requested headers).
- **UI badge stuck at "gateway unreachable" after a cold start.** The UI health check is a one-shot
  `useEffect([], …)` in `web/src/App.tsx` with no retry/poll; on a cold start the first `/health` times out and
  the badge sticks until a manual page reload. `web/` is DO-NOT-EDIT, so this is documented, not patched —
  reload once the service is warm.
- **Browser automation is blocked on the work laptop.** Playwright/Chrome refuses to launch: *"DevTools remote
  debugging is disallowed by the system admin"* (corporate machine policy). Not routed around (isolation); all
  browser verification is done manually.

**Verified LIVE (2026-09-14, against the public gateway + Vercel UI):** `/health → 200` naming
`gemini-3.5-flash-lite · tavily · atlas-vector-search · db ok`; `/stats` → 401 without a user, 200 with. A
browser query ("What is retrieval-augmented generation?") rendered a grounded answer with inline `[1]` + a
real `cloud.google.com` **Sources** link, a `TRACE` of `web_search → fetch_page`, and
`done{terminated:"done", cost $0.0051}`. **URLs:** UI `https://lumina-web-two-orpin.vercel.app`, API
`https://lumina-8cqp.onrender.com`. Agent has no public URL by construction; no secret is in the browser
bundle. `DEPLOY.md` is the full runbook.

## M13 — Eval + submit
