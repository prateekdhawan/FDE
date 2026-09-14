# LUMINA gateway — the PUBLIC edge, and the ONLY internet-facing service. Holds NO provider key by
# design: even if this image or host is compromised, there is no secret here to leak. It proxies to
# the private agent at lumina-agent.internal:8000.
#
# Build context is the repo ROOT (Fly does this via `-c fly.gateway.toml`): npm workspaces + the
# built @lumina/contract package (shared zod schemas the gateway validates bodies against).
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production

# 1) Install the whole workspace (manifests first for layer caching; all four needed for `npm ci`).
COPY package.json package-lock.json ./
COPY packages/contract/package.json packages/contract/
COPY backend/agent/package.json backend/agent/
COPY backend/gateway/package.json backend/gateway/
COPY web/package.json web/
RUN npm ci

# 2) Copy the sources this service needs and build them (contract first — the gateway imports it).
COPY packages/contract packages/contract
COPY backend/gateway backend/gateway
RUN npm run build -w @lumina/contract && npm run build -w @lumina/gateway

# 3) Run from the gateway workspace. The UI is served by Vercel, so no web/dist is copied here — the
#    gateway is a pure API edge (its static-hosting block simply no-ops when web/dist is absent).
WORKDIR /app/backend/gateway
EXPOSE 8787
CMD ["node", "dist/index.js"]
