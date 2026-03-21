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
COPY --from=base /app/apps/stateless/package.json /app/apps/stateless/
COPY --from=base /app/packages/protocol/package.json /app/packages/protocol/
COPY --from=base /app/packages/stateless-sync/package.json /app/packages/stateless-sync/
COPY --from=base /app/packages/source-stripe/package.json /app/packages/source-stripe/
COPY --from=base /app/packages/destination-postgres/package.json /app/packages/destination-postgres/

# Copy production dependencies (including workspace dependencies)
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=prod-deps /app/apps/stateless/node_modules /app/apps/stateless/node_modules
COPY --from=prod-deps /app/packages/protocol/node_modules /app/packages/protocol/node_modules
COPY --from=prod-deps /app/packages/stateless-sync/node_modules /app/packages/stateless-sync/node_modules
COPY --from=prod-deps /app/packages/source-stripe/node_modules /app/packages/source-stripe/node_modules
COPY --from=prod-deps /app/packages/destination-postgres/node_modules /app/packages/destination-postgres/node_modules

# Copy built files
COPY --from=build /app/apps/stateless/dist /app/apps/stateless/dist
COPY --from=build /app/packages/protocol/dist /app/packages/protocol/dist
COPY --from=build /app/packages/stateless-sync/dist /app/packages/stateless-sync/dist
COPY --from=build /app/packages/source-stripe/dist /app/packages/source-stripe/dist
COPY --from=build /app/packages/destination-postgres/dist /app/packages/destination-postgres/dist

ENV NODE_ENV=production
ENTRYPOINT ["node", "apps/stateless/dist/cli/index.js"]
