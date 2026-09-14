# LUMINA — Setup & Keys

Everything you need before the app can *run* (you can *build* without keys). This is a
personal course project — keep it isolated from any work account or infrastructure.

## Where the `.env` lives
- **Repo root:** `C:\Users\pdhawan\Pictures\FDE_Course\Assignment_1_Lumina\.env`
- Both the gateway and the agent service read this one file from the repo root.
- It is **git-ignored** (`.gitignore` ignores `.env`), so real keys never get committed.
- It was created from `.env.example`. Fill in the four blanks below; the other values
  (ports, model names, caps) already have correct defaults.

## The four things to fill in

| `.env` key | Where to get it | Cost | Notes |
|---|---|---|---|
| `MONGODB_URI` | Atlas dashboard → **Connect → Drivers → Node.js** (see below) | Free (M0) | Personal email account |
| `ANTHROPIC_API_KEY` | https://console.anthropic.com → **API Keys** | ~$5 prepaid is plenty | LLM that writes the answers |
| `OPENAI_API_KEY` | https://platform.openai.com → **API keys** | ~$5 prepaid is plenty | **Embeddings only** — needed even though the LLM is Claude |
| `TAVILY_API_KEY` | https://app.tavily.com → sign up → **API Key** | Free tier (~1000/mo) covers it | Web search + page fetch |

Model defaults already set for you: `LLM_MODEL=claude-sonnet-5`,
`EMBEDDING_MODEL=text-embedding-3-small` (1536 dims — this must match the DB schema),
`SEARCH_PROVIDER=tavily`.

## MongoDB Atlas — getting `MONGODB_URI` step by step
1. **Create the cluster:** in your project, **Create → M0 (Free)** → nearby region → Create.
2. **Database user:** left sidebar → **Security → Database Access → Add New Database User**.
   Pick a username + password (save them). Role: *Read and write to any database*.
3. **Network access:** **Security → Network Access → Add IP Address → Allow access from
   anywhere** (`0.0.0.0/0`). Fine for a short-lived course project; you'd tighten this in prod.
   (When you deploy to Fly.io later, `0.0.0.0/0` also lets Fly reach Atlas.)
4. **Copy the string:** on the cluster, **Connect → Drivers → Node.js**. Copy:
   `mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`
   Replace `<user>` / `<password>` with the user from step 2. If the password has special
   characters (`@ : / ?`), URL-encode them.
5. Paste it as `MONGODB_URI=...` in `.env`. Leave `MONGODB_DB=lumina`.

> **Office-laptop check:** confirm your corporate network allows the outbound Atlas
> connection (`mongodb+srv`, TLS on port 27017) and that personal cloud accounts are
> permitted on the device. If blocked, tell me and we switch to the Docker-local fallback.

## After the keys are in
```bash
node scripts/create-indexes.mjs            # creates the 2 vector + 1 text + TTL indexes
node scripts/create-indexes.mjs --status   # indexes build async — wait for "queryable"
npm run dev                                 # gateway :8787, agent :8000, UI :5173
```
`GET http://localhost:8787/health` should return `status: ok` with `db: ok` once the URI is
valid. Until keys are present, `/health` will report `degraded` — that's expected.

## What you never do
- Never paste a real key into any file other than `.env`.
- Never put a secret in a `VITE_*` variable (those reach the browser).
- Never use work/Snowflake/office infrastructure for this project.

## Troubleshooting the connection string
- **`bad auth : authentication failed`** — the username/password in the URI don't match a
  **Database Access** user. Note: your Atlas *account login* (cloud.mongodb.com) is NOT a database
  user. Create/edit one under **Security → Database Access**, give it *Read and write to any
  database*, and use those credentials in the URI. Wait ~15s after saving.
  - Two things that keep this failing even after a "reset": (a) you changed the **account**
    password, not the *Database Access* user's — they're different; (b) the user was created in a
    **different Atlas project** than the cluster. Confirm the top-left project picker shows the
    project that contains `Cluster0`.
  - **Cleanest fix if it keeps failing:** create a brand-new user (e.g. `lumina` / `LuminaDb123`,
    *Read and write to any database*), wait ~30–60s, and put *both* the new username and password
    in the URI. A fresh user removes all doubt about whether an old auto-generated user's password
    actually changed.
- **Special characters in the password** (`@ : / ? # [ ] %`) must be percent-encoded in the URI
  (`@` → `%40`, etc.). Easiest fix: set a password with **letters + numbers only**.
- **Connection times out (no response at all)** — likely the office network blocks the outbound
  Atlas connection, or your IP isn't allow-listed (**Security → Network Access**).
