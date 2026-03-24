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
ENV NODE_OPTIONS="--max-old-space-size=4096"
RUN pnpm --filter @stripe/protocol \
    --filter @stripe/util-postgres \
    --filter @stripe/ts-cli \
    --filter @stripe/stateless-sync \
    --filter @stripe/store-postgres \
    --filter @stripe/destination-postgres \
    --filter @stripe/destination-google-sheets \
    --filter @stripe/source-stripe \
    --filter @stripe/sync-engine-stateless \
    --filter @stripe/sync-engine \
    run build

## Build step complete, copy to working image
FROM node:24-alpine
WORKDIR /app

# Copy workspace configuration
COPY --from=base /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml* ./

# Copy package.json files for required packages
COPY --from=base /app/apps/sync-engine/package.json /app/apps/sync-engine/
COPY --from=base /app/apps/stateless/package.json /app/apps/stateless/
COPY --from=base /app/packages/protocol/package.json /app/packages/protocol/
COPY --from=base /app/packages/stateless-sync/package.json /app/packages/stateless-sync/
COPY --from=base /app/packages/source-stripe/package.json /app/packages/source-stripe/
COPY --from=base /app/packages/destination-postgres/package.json /app/packages/destination-postgres/
COPY --from=base /app/packages/destination-google-sheets/package.json /app/packages/destination-google-sheets/
COPY --from=base /app/packages/store-postgres/package.json /app/packages/store-postgres/
COPY --from=base /app/packages/util-postgres/package.json /app/packages/util-postgres/
COPY --from=base /app/packages/ts-cli/package.json /app/packages/ts-cli/

# Copy production dependencies (including workspace dependencies)
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=prod-deps /app/apps/sync-engine/node_modules /app/apps/sync-engine/node_modules
COPY --from=prod-deps /app/apps/stateless/node_modules /app/apps/stateless/node_modules
COPY --from=prod-deps /app/packages/protocol/node_modules /app/packages/protocol/node_modules
COPY --from=prod-deps /app/packages/stateless-sync/node_modules /app/packages/stateless-sync/node_modules
COPY --from=prod-deps /app/packages/source-stripe/node_modules /app/packages/source-stripe/node_modules
COPY --from=prod-deps /app/packages/destination-postgres/node_modules /app/packages/destination-postgres/node_modules
COPY --from=prod-deps /app/packages/destination-google-sheets/node_modules /app/packages/destination-google-sheets/node_modules
COPY --from=prod-deps /app/packages/store-postgres/node_modules /app/packages/store-postgres/node_modules
COPY --from=prod-deps /app/packages/util-postgres/node_modules /app/packages/util-postgres/node_modules

# Copy built files
COPY --from=build /app/apps/sync-engine/dist /app/apps/sync-engine/dist
COPY --from=build /app/apps/stateless/dist /app/apps/stateless/dist
COPY --from=build /app/packages/protocol/dist /app/packages/protocol/dist
COPY --from=build /app/packages/stateless-sync/dist /app/packages/stateless-sync/dist
COPY --from=build /app/packages/source-stripe/dist /app/packages/source-stripe/dist
COPY --from=build /app/packages/destination-postgres/dist /app/packages/destination-postgres/dist
COPY --from=build /app/packages/destination-google-sheets/dist /app/packages/destination-google-sheets/dist
COPY --from=build /app/packages/store-postgres/dist /app/packages/store-postgres/dist
COPY --from=build /app/packages/util-postgres/dist /app/packages/util-postgres/dist
COPY --from=build /app/packages/ts-cli/dist /app/packages/ts-cli/dist

ENV NODE_ENV=production
ENTRYPOINT ["node", "apps/sync-engine/dist/cli.js"]
CMD ["serve"]
