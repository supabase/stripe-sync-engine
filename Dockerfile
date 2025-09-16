# Build step
FROM node:24-alpine

RUN npm install -g pnpm@10.16.1

WORKDIR /app
COPY . ./
RUN pnpm install --frozen-lockfile
RUN pnpm build
# Allow removal of prod dependencies with pnpm
ENV CI=true
RUN pnpm prune --prod

## Build step complete, copy to working image
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=0 /app .
CMD ["node", "packages/fastify-app/dist/src/server.js"]