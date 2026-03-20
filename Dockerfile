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

# Copy package.json files for required packages
COPY --from=base /app/apps/stateless-cli/package.json /app/apps/stateless-cli/
COPY --from=base /app/packages/sync-protocol/package.json /app/packages/sync-protocol/
COPY --from=base /app/packages/source-stripe/package.json /app/packages/source-stripe/
COPY --from=base /app/packages/destination-postgres/package.json /app/packages/destination-postgres/

# Copy production dependencies (including workspace dependencies)
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=prod-deps /app/apps/stateless-cli/node_modules /app/apps/stateless-cli/node_modules
COPY --from=prod-deps /app/packages/sync-protocol/node_modules /app/packages/sync-protocol/node_modules
COPY --from=prod-deps /app/packages/source-stripe/node_modules /app/packages/source-stripe/node_modules
COPY --from=prod-deps /app/packages/destination-postgres/node_modules /app/packages/destination-postgres/node_modules

# Copy built files
COPY --from=build /app/apps/stateless-cli/dist /app/apps/stateless-cli/dist
COPY --from=build /app/packages/sync-protocol/dist /app/packages/sync-protocol/dist
COPY --from=build /app/packages/source-stripe/dist /app/packages/source-stripe/dist
COPY --from=build /app/packages/destination-postgres/dist /app/packages/destination-postgres/dist

ENV NODE_ENV=production
ENTRYPOINT ["node", "apps/stateless-cli/dist/cli/index.js"]
