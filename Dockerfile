# Install deps and create standalone deployment
# Expects pre-built dist/ directories in the build context (from `pnpm build`)
FROM node:24-alpine AS build

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

WORKDIR /app
COPY . ./

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm --filter @stripe/sync-engine deploy --prod /deploy

# Final image — just the bundle + external node_modules
FROM node:24-alpine
WORKDIR /app

COPY --from=build /deploy/package.json ./
COPY --from=build /deploy/dist ./dist
COPY --from=build /deploy/node_modules ./node_modules

ARG GIT_COMMIT=unknown
ARG BUILD_DATE=unknown
ARG COMMIT_URL=unknown
ENV NODE_ENV=production
ENV GIT_COMMIT=$GIT_COMMIT
ENV BUILD_DATE=$BUILD_DATE
ENV COMMIT_URL=$COMMIT_URL
ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["serve"]
