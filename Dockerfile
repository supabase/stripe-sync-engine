# Build step
FROM node:18-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci 

## Build step complete, copy to working image
FROM node:18-alpine
WORKDIR /app
COPY --from=0 /app .
COPY . .
RUN npm run build 
CMD ["npm", "start"]