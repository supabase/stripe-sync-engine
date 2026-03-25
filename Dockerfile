# Build step — install all deps and compile with tsc
FROM node:24-alpine AS build

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

WORKDIR /app
COPY . ./

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
ENV NODE_OPTIONS="--max-old-space-size=4096"
RUN pnpm build

# Create standalone deployment with lockfile-pinned deps
FROM build AS deploy
RUN pnpm --filter @stripe/sync-engine deploy --prod /deploy

# pnpm deploy doesn't apply publishConfig — workspace packages still point
# exports at src/. Rewrite them to use dist/ (the publishConfig values).
RUN node -e " \
  const fs = require('fs'), path = require('path'); \
  const nm = '/deploy/node_modules/@stripe'; \
  if (!fs.existsSync(nm)) process.exit(0); \
  for (const dir of fs.readdirSync(nm)) { \
    const pj = path.join(nm, dir, 'package.json'); \
    if (!fs.existsSync(pj)) continue; \
    const pkg = JSON.parse(fs.readFileSync(pj, 'utf8')); \
    if (!pkg.publishConfig) continue; \
    for (const [k, v] of Object.entries(pkg.publishConfig)) pkg[k] = v; \
    delete pkg.publishConfig; \
    fs.writeFileSync(pj, JSON.stringify(pkg, null, 2) + '\n'); \
  } \
"

# Final image — just the bundle + external node_modules
FROM node:24-alpine
WORKDIR /app

COPY --from=deploy /deploy/package.json ./
COPY --from=deploy /deploy/dist ./dist
COPY --from=deploy /deploy/node_modules ./node_modules

ARG GIT_COMMIT=unknown
ARG BUILD_DATE=unknown
ARG COMMIT_URL=unknown
ENV NODE_ENV=production
ENV GIT_COMMIT=$GIT_COMMIT
ENV BUILD_DATE=$BUILD_DATE
ENV COMMIT_URL=$COMMIT_URL
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve"]
