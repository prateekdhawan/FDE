# LUMINA — Deploy runbook (M12)

**Status: LIVE and verified (2026-09-14).**

| Piece | URL | Host |
| --- | --- | --- |
| UI (static) | https://lumina-web-two-orpin.vercel.app | Vercel |
| API (gateway) | https://lumina-8cqp.onrender.com | Render (free) |

Deployed topology (**R1** — the free tier has no private service and no separate worker, and exposes
only one public port, so all three processes share ONE Render container):

```
Vercel (static UI)  ──HTTPS──▶  Render web service  "lumina"  (one container)
  VITE_API_URL bakes                 ├── gateway  0.0.0.0:$PORT   PUBLIC edge, holds NO keys
  in the gateway URL                 ├── agent    127.0.0.1:8000  PRIVATE (loopback only), holds all keys
                                     └── worker   (no port)       M7 jobs worker
                                              │
                                              ▼  agent → providers
                                        Gemini · Tavily · Atlas
```

- **UI → gateway** over the public internet; the browser knows only the gateway's HTTPS URL (`VITE_API_URL`, a public build-time value — never a key).
- **gateway → agent** over **loopback** (`http://127.0.0.1:8000`). The agent is never internet-routable: Render routes traffic **only** to the process bound to `$PORT` (the gateway). This is the whole "agent not public" guarantee — see [render-start.mjs](render-start.mjs) and [backend/agent/src/env.ts](backend/agent/src/env.ts) (`AGENT_BIND_HOST=127.0.0.1`).
- **Secrets** live only as Render env vars, read at runtime by the agent process. The gateway holds none. `.env` is `.dockerignore`d, so no key is ever baked into an image.
- **Why the UI is on Vercel, not served by the gateway:** the gateway's SPA fallback regex in [backend/gateway/src/index.ts](backend/gateway/src/index.ts) excludes `/evals`, so a hard-refresh on `/evals` would 404 if the gateway served the UI. Vercel's SPA rewrite (below) handles every route.

> Render builds the image **remotely** from the GitHub repo; Vercel builds **remotely** too. No local Docker required.

---

## 0. One-time: accounts + data access

- **GitHub:** code lives on a personal repo (Render deploys from it). This project is kept isolated from any work account.
- **Render:** personal account, free tier. No card required.
- **Vercel:** personal account. `npm i -g vercel`, then `vercel login` (browser).
- **Atlas:** **Network Access → allow `0.0.0.0/0`** (Render egress IPs vary), and confirm the DB user in `MONGODB_URI` can read/write the `lumina` DB. (Also in SETUP.md.)

---

## 1. Push the code to GitHub

Render deploys from a Git branch, so the repo must be current:

```bash
git push origin main
```

The repo root carries the three deploy files Render/Vercel read:
[render.yaml](render.yaml) (Blueprint), [Dockerfile.render](Dockerfile.render) (image), [render-start.mjs](render-start.mjs) (launcher), and [vercel.json](vercel.json) (UI build).

---

## 2. Deploy the backend on Render (Blueprint)

1. Render dashboard → **New → Blueprint** → pick the GitHub repo. Render reads [render.yaml](render.yaml) and creates the `lumina` web service (Docker, `plan: free`, `region: singapore` — closest free region to the Atlas M0 in Mumbai; `autoDeploy: true`).
2. **Set the secrets** (declared `sync: false` in the Blueprint, so Render does **not** create them — a human adds them in the dashboard). Service → **Environment** → add:
   - `MONGODB_URI`
   - `GOOGLE_API_KEY`
   - `TAVILY_API_KEY`
   - (`CORS_ORIGINS` — leave for step 4, once the Vercel URL exists.)
3. Render builds [Dockerfile.render](Dockerfile.render) and starts [render-start.mjs](render-start.mjs) (agent on loopback → worker → gateway on `$PORT`).

Verify the public gateway once it's **Live**:

```bash
GW=https://lumina-8cqp.onrender.com
curl -s $GW/health                                    # 200; names model/provider/vector + "db":"ok"  (db:ok proves Atlas from Render)
curl -s -o /dev/null -w '%{http_code}\n' $GW/stats    # 401 (no X-User-Id — auth gate works)
curl -s -H 'x-user-id: u_smoke' $GW/stats             # 200 StatsResponse
```

> **`autoDeploy`:** every `git push` to `main` triggers a rebuild. To ship a fix, push — no CLI step.

---

## 3. Deploy the UI on Vercel (from the repo ROOT)

The UI imports `@lumina/contract` and extends the root `tsconfig.base.json`, so a `web/`-only deploy fails to build. Deploy from the **repo root** using [vercel.json](vercel.json) (installs the workspace, builds `contract` → `web`, outputs `web/dist`, SPA rewrite):

```bash
# From the repo root.
vercel link --yes --project lumina-web        # names the project (dir name has a capital → invalid, so set it explicitly)
vercel --prod --yes \
  --build-env VITE_API_URL=https://lumina-8cqp.onrender.com   # bake the PUBLIC gateway URL into the bundle
# → https://lumina-web-two-orpin.vercel.app
```

`VITE_API_URL` is a **public** build-time value (the gateway's URL) — never a provider key. Confirm it baked in: the deployed JS bundle should contain `https://lumina-8cqp.onrender.com` and no `localhost`.

---

## 4. Close the CORS loop, then verify end to end

The gateway allows only the browser origin(s) in `CORS_ORIGINS` (never `*`). Add it on Render:

1. Service → **Environment** → **Add Environment Variable** → key `CORS_ORIGINS`, value `https://lumina-web-two-orpin.vercel.app` (no trailing slash — must match the browser `Origin` exactly) → **Save** (auto-redeploys).

Verify CORS from the CLI — the UI sends `x-user-id` on **every** request, which forces a preflight, so test with that header:

```bash
GW=https://lumina-8cqp.onrender.com
ORIGIN=https://lumina-web-two-orpin.vercel.app
# Preflight for a GET /health (UI sends x-user-id everywhere):
curl -s -i -X OPTIONS -H "Origin: $ORIGIN" \
  -H 'Access-Control-Request-Method: GET' -H 'Access-Control-Request-Headers: x-user-id' \
  $GW/health | grep -i '^access-control-'
# → access-control-allow-origin: <ORIGIN>  and  access-control-allow-headers: x-user-id
```

Then open the Vercel URL in a browser, run a query, and confirm: the header badge is green (`… · db ok`), **Sources** populate with real links, the answer streams token-by-token, and the **Trace** shows the tool calls. `/evals` (hard refresh) loads via the SPA rewrite and pulls `/evals/report.json` from the gateway.

**Verified run (2026-09-14):** query *"What is retrieval-augmented generation?"* → `web_search` → `fetch_page`, grounded answer with a real `cloud.google.com` citation, `done{terminated:"done", cost $0.0051}`.

---

## Notes / gotchas / cost

- **Free-tier cold start (expected, not a bug):** the service sleeps after ~15 min idle and takes ~50s to wake. The UI health check is a **one-shot** `useEffect([], …)` in [web/src/App.tsx](web/src/App.tsx) with no retry, so on a cold start the first `/health` times out and the badge sticks at **"gateway unreachable"** until you reload the page. `web/` is DO-NOT-EDIT, so this is documented, not patched. **Warm the service before an eval** by hitting `/health` first.
- **Latency caveat (documented in DESIGN.md):** on the free tier, TTFT runs ~3–13s warm and ~27s on a cold + `fetch_page` request — **above the 2500ms SLA**. This is the accepted cost of staying free (Gemini free-tier + Render sleep). A warm quick-search is the fast path.
- **Cost:** one `free` web service. $0 infra; provider spend only (~$0.005 / quick ask).
- **Isolation:** personal GitHub / Render / Vercel accounts only; no work infra, no internal endpoints, no secret reachable from the browser, agent never public.
- **Multi-instance:** free tier is single-instance, so the in-memory gateway rate-limit is fine; the deep-cap is in Atlas (shared). If ever scaled >1, move the rate-limit counter to a shared store (noted in DESIGN.md).

---

## Appendix — Fly.io (alternative target, NOT deployed)

The repo also carries a two-app Fly.io config ([fly.agent.toml](fly.agent.toml), [fly.gateway.toml](fly.gateway.toml), [backend/agent/Dockerfile](backend/agent/Dockerfile), [backend/gateway/Dockerfile](backend/gateway/Dockerfile)) that maps the same "public gateway / private agent" split onto Fly's 6PN private network (agent at `lumina-agent.internal:8000`, no public IP). It is a valid future target but was **not** used for this submission (Fly requires a card; Render's free tier does not).

**Known caveat if you revive it:** the Fly Dockerfiles have the same latent bug this Render build hit — they never `COPY tsconfig.base.json` (every workspace tsconfig extends `../../tsconfig.base.json`), so `tsc` fails `TS5083`. Add that copy before the build step (see how [Dockerfile.render](Dockerfile.render) does it) before trusting the Fly path.
