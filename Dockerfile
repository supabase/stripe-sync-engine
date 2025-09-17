# Build step
FROM node:24-alpine AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

WORKDIR /app
COPY . ./

FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

FROM base AS build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm run -r build

## Build step complete, copy to working image
FROM node:24-alpine
WORKDIR /app

# Copy workspace configuration
COPY --from=base /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml* ./

# Copy package.json files for both packages
COPY --from=base /app/packages/fastify-app/package.json /app/packages/fastify-app/
COPY --from=base /app/packages/sync-engine/package.json /app/packages/sync-engine/

# Copy production dependencies (including workspace dependencies)
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=prod-deps /app/packages/fastify-app/node_modules /app/packages/fastify-app/node_modules
COPY --from=prod-deps /app/packages/sync-engine/node_modules /app/packages/sync-engine/node_modules

# Copy built files
COPY --from=build /app/packages/fastify-app/dist /app/packages/fastify-app/dist
COPY --from=build /app/packages/sync-engine/dist /app/packages/sync-engine/dist

ENV NODE_ENV=production
CMD ["node", "packages/fastify-app/dist/src/server.js"]