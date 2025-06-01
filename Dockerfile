# Build step
FROM node:22-alpine

RUN npm install -g pnpm@10.10.0

WORKDIR /app
COPY . ./
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm prune --production

## Build step complete, copy to working image
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=0 /app .
CMD ["node", "packages/fastify-app/dist/src/server.js"]