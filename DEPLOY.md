# LUMINA — Deploy runbook (M12)

Target topology (from PLAN.md, fixed):

```
Vercel (static UI)  ──HTTPS──▶  Fly: lumina-gateway (PUBLIC edge, no keys)
                                      │  Fly 6PN private network
                                      ▼
                                Fly: lumina-agent (PRIVATE, holds all keys) ──▶ Gemini · Tavily · Atlas
```

- **UI → gateway** over the public internet (the browser knows only the gateway's HTTPS URL, via `VITE_API_URL`).
- **Gateway → agent** over Fly's private 6PN network at `lumina-agent.internal:8000`. The agent has **no public IP**.
- **Secrets** live only as Fly secrets on the agent. The gateway holds none. `.env` is `.dockerignore`d, never baked into an image.

> `fly deploy` and `vercel` both build **remotely**, so local Docker is not required.

---

## 0. One-time: install CLIs + authenticate

```bash
# flyctl (Windows PowerShell):
#   pwsh -c "iwr https://fly.io/install.ps1 | iex"   then add %USERPROFILE%\.fly\bin to PATH
# vercel:
npm i -g vercel

fly auth login       # opens a browser — personal Fly account
vercel login         # opens a browser — personal Vercel account
```

Atlas: **Network Access → allow `0.0.0.0/0`** (Fly egress IPs vary), and confirm the DB user in `MONGODB_URI` can read/write the `lumina` DB. (Already noted in SETUP.md.)

---

## 1. Deploy the agent FIRST (private) — the gateway needs a target

```bash
# From the repo root.
fly apps create lumina-agent

# Secrets (values come from .env — never printed). These three are all the agent needs:
fly secrets set -a lumina-agent \
  MONGODB_URI='...'      \
  GOOGLE_API_KEY='...'   \
  TAVILY_API_KEY='...'

fly deploy -c fly.agent.toml         # builds backend/agent/Dockerfile, starts app + worker processes

# Make it truly private: release any public IP fly may have allocated.
fly ips list -a lumina-agent
fly ips release <each-public-ip> -a lumina-agent     # the .internal address always remains

# Sanity: exec into the machine and hit its own /health (no public route exists, by design).
fly ssh console -a lumina-agent -C "curl -s localhost:8000/health"
# → {"status":"ok","model":"gemini-3.5-flash-lite",...,"db":"ok"}   (db:ok proves Atlas from Fly)
```

The agent runs two Fly processes from one image: `app` (HTTP) and `worker` (the M7 jobs worker). Both share the secrets.

---

## 2. Deploy the gateway (public)

```bash
fly apps create lumina-gateway
fly deploy -c fly.gateway.toml       # builds backend/gateway/Dockerfile
# → public URL, e.g. https://lumina-gateway.fly.dev

# Verify the private hop works (gateway → agent.internal):
curl -s https://lumina-gateway.fly.dev/health
# → 200 {"status":"ok",...} when the agent is up (the gateway nests the agent's health)
```

`AGENT_URL=http://lumina-agent.internal:8000` is already in `fly.gateway.toml` — no secret needed.

---

## 3. Deploy the UI (Vercel), pointed at the gateway

```bash
cd web
vercel link                                    # link/create the Vercel project
vercel env add VITE_API_URL production         # paste: https://lumina-gateway.fly.dev
vercel --prod                                   # build + deploy; uses web/vercel.json (SPA rewrite)
# → https://<project>.vercel.app
```

`VITE_API_URL` is a **public** build-time value (the gateway's URL) — it is NOT a secret and must never be a provider key.

---

## 4. Close the CORS loop, then verify end to end

```bash
# Tell the gateway which browser origin may call it (not "*"): the Vercel URL from step 3.
fly secrets set -a lumina-gateway CORS_ORIGINS='https://<project>.vercel.app'   # restarts the gateway

# Before grading, keep the gateway warm so the eval's first request isn't a cold start:
fly scale count 1 -a lumina-gateway
# (fly.gateway.toml ships min_machines_running=0 for cost; bump to 1 for the eval window.)
```

End-to-end checks against the **public gateway** (what the grader hits):

```bash
GW=https://lumina-gateway.fly.dev
curl -s $GW/health                                             # 200, names model/provider/vector/db
curl -s -o /dev/null -w '%{http_code}\n' $GW/stats             # 401 (no X-User-Id)
curl -s -H 'x-user-id: u_smoke' $GW/stats                      # 200 StatsResponse
# Full ask (SSE) — trace* → sources → token* → done, sources before first token:
TID=$(curl -s -H 'x-user-id: u_smoke' -H 'content-type: application/json' -d '{}' $GW/threads | ... )
curl -sN -H 'x-user-id: u_smoke' -H 'content-type: application/json' \
  -d '{"query":"latest on ..."}' "$GW/threads/$TID/ask"
```

Then open the Vercel URL in a browser, run a query, and confirm streaming + citations render. `/evals` on the Vercel URL should load (SPA rewrite) and pull `/evals/report.json` from the gateway.

---

## Notes / cost / scaling

- **Cost:** agent = 2 always-on machines (app + worker); gateway = 1 (scale-to-zero unless warmed). All `shared-cpu-1x`. Trim later with a multi-stage Dockerfile (`npm ci --omit=dev` runner) if image size matters.
- **Multi-instance:** the gateway rate-limit is in-memory (per instance); the deep-cap is in Atlas (shared). If the gateway scales >1, move the rate-limit counter to a shared store (noted in DESIGN.md).
- **`.internal` vs `.flycast`:** single agent instance uses `.internal` (per-instance 6PN DNS). To scale the agent >1, allocate a private IP (`fly ips allocate-v6 --private -a lumina-agent`) and switch `AGENT_URL` to `http://lumina-agent.flycast:8000` (load-balanced).
