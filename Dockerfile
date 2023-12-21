# Build step
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci 
COPY . /app
RUN npm run build 
RUN npm prune --production

## Build step complete, copy to working image
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=0 /app .
CMD ["npm", "start"]