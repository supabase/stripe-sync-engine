# Monorepo Dockerfile — build individual images with --target:
#   docker build --target engine .   → @stripe/sync-engine (stateless HTTP API)
#   docker build --target service .  → @stripe/sync-service (serve + worker CLI)

# ---- Manifests stage (shared) ----
# Extracts all package.json / lockfile / workspace config files via find so no
# per-package COPY line needs updating when a new workspace package is added.
FROM node:24-alpine AS manifests
WORKDIR /app
COPY . .
RUN find . \
      \( -name 'package.json' -o -name 'pnpm-workspace.yaml' -o -name 'pnpm-lock.yaml' \) \
      -not -path '*/node_modules/*' -not -path '*/.git/*' \
      -exec sh -c 'dst="/m/$1"; mkdir -p "$(dirname "$dst")"; cp "$1" "$dst"' _ {} \;

# ===========================================================================
# Engine
# ===========================================================================

FROM node:24-alpine AS engine-build

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

WORKDIR /app

# ---- Install layer (cached by BuildKit registry cache) ----
# Seeded from the manifests stage — cache survives source-only changes.
COPY --from=manifests /m/ ./
RUN pnpm install --frozen-lockfile

# ---- Build layer ----
COPY . ./
RUN pnpm --filter @stripe/sync-engine deploy --prod /deploy

FROM node:24-alpine AS engine
WORKDIR /app

COPY --from=engine-build /deploy/package.json ./
COPY --from=engine-build /deploy/dist ./dist
COPY --from=engine-build /deploy/node_modules ./node_modules

ARG GIT_COMMIT=unknown
ARG BUILD_DATE=unknown
ARG COMMIT_URL=unknown
ENV NODE_ENV=production
ENV GIT_COMMIT=$GIT_COMMIT
ENV BUILD_DATE=$BUILD_DATE
ENV COMMIT_URL=$COMMIT_URL
ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["serve"]

# ===========================================================================
# Service (also used for the worker container — same image, different CMD)
# ===========================================================================

FROM node:24 AS service-build

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

WORKDIR /app

# ---- Install layer (cached by BuildKit registry cache) ----
# Seeded from the manifests stage — cache survives source-only changes.
COPY --from=manifests /m/ ./
RUN pnpm install --frozen-lockfile

# ---- Build layer ----
COPY . ./
RUN pnpm --filter @stripe/sync-service deploy --prod /deploy

FROM node:24 AS service
WORKDIR /app

COPY --from=service-build /deploy/package.json ./
COPY --from=service-build /deploy/dist ./dist
COPY --from=service-build /deploy/node_modules ./node_modules

ARG GIT_COMMIT=unknown
ARG BUILD_DATE=unknown
ARG COMMIT_URL=unknown
ENV NODE_ENV=production
ENV GIT_COMMIT=$GIT_COMMIT
ENV BUILD_DATE=$BUILD_DATE
ENV COMMIT_URL=$COMMIT_URL
ENTRYPOINT ["node", "dist/bin/sync-service.js"]
CMD ["serve", "--temporal-address", "temporal:7233", "--temporal-task-queue", "sync-engine"]
