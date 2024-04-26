# Build step
FROM node:20-alpine
WORKDIR /app
COPY . .
RUN npm ci
RUN npm run build 
RUN npm prune --production

## Build step complete, copy to working image
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=0 /app/apps/node-fastify .
COPY --from=0 /app/node_modules ./node_modules
COPY --from=0 /app/packages/stripe-sync-engine-lib ./node_modules/stripe-sync-engine-lib
CMD ["npm", "start"]
