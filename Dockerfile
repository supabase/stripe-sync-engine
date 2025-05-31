# Build step
FROM node:22-alpine
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"

RUN npm install -g pnpm@10.10.0

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile 
COPY . /app
RUN pnpm build 
RUN pnpm prune --production

## Build step complete, copy to working image
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=0 /app .
CMD ["pnpm", "start"]