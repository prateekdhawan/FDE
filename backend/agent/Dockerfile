# LUMINA agent — the PRIVATE service. Holds every provider key (as Fly secrets, never baked in)
# and is the only enforcer of the deep-search cap. On Fly it has NO public IP: it is reachable only
# from the gateway over the 6PN private network at lumina-agent.internal:8000.
#
# Build context is the repo ROOT (Fly does this automatically via `-c fly.agent.toml`), because this
# is an npm-workspaces monorepo and the agent imports the built @lumina/contract package.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production

# 1) Install the whole workspace. Copy only the manifests first so this (slow) layer stays cached
#    until a package.json actually changes. npm ci needs every workspace's manifest present to
#    validate the shared lockfile, so all four are copied even though we only build two here.
COPY package.json package-lock.json ./
COPY packages/contract/package.json packages/contract/
COPY backend/agent/package.json backend/agent/
COPY backend/gateway/package.json backend/gateway/
COPY web/package.json web/
RUN npm ci

# 2) Copy the sources this service needs and build them (contract first — the agent imports it).
COPY packages/contract packages/contract
COPY backend/agent backend/agent
RUN npm run build -w @lumina/contract && npm run build -w @lumina/agent

# 3) Run from the agent workspace so its dist/ and node_modules resolution are the working dir.
#    fly.toml [processes] runs TWO processes off this one image: `app` (this default CMD, the HTTP
#    agent) and `worker` (overrides CMD → node dist/worker.js, the jobs worker).
WORKDIR /app/backend/agent
EXPOSE 8000
CMD ["node", "dist/index.js"]
