# Build step
FROM mhart/alpine-node:14
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci 

## Build step complete, copy to working image
FROM mhart/alpine-node:14
WORKDIR /app
COPY --from=0 /app .
COPY . .
RUN npm run build 
CMD ["npm", "start"]