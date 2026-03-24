# Build step — install all deps and bundle with tsup
FROM node:24-alpine AS build

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

WORKDIR /app
COPY . ./

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
ENV NODE_OPTIONS="--max-old-space-size=4096"
RUN pnpm --filter @stripe/sync-engine run build

# Install only external npm deps (workspace @stripe/* deps are bundled by tsup)
FROM node:24-alpine AS deps
WORKDIR /app
COPY --from=build /app/apps/sync-engine/package.json ./
RUN node -e " \
  const p = JSON.parse(require('fs').readFileSync('package.json','utf8')); \
  p.dependencies = Object.fromEntries( \
    Object.entries(p.dependencies || {}).filter(([k]) => !k.startsWith('@stripe/')) \
  ); \
  delete p.devDependencies; \
  require('fs').writeFileSync('package.json', JSON.stringify(p, null, 2)); \
"
RUN npm install --omit=dev

# Final image — just the bundle + external node_modules
FROM node:24-alpine
WORKDIR /app

COPY --from=build /app/apps/sync-engine/package.json ./
COPY --from=build /app/apps/sync-engine/dist ./dist
COPY --from=deps /app/node_modules ./node_modules

ARG GIT_COMMIT=unknown
ARG BUILD_DATE=unknown
ENV NODE_ENV=production
ENV GIT_COMMIT=$GIT_COMMIT
ENV BUILD_DATE=$BUILD_DATE
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve"]
