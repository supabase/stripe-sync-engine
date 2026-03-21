# esbuild (used by Vite/Slidev) has a native binary that won't run in some
# locked-down environments (e.g. corp machines with restricted exec policies).
# We work around this by doing a full static build inside Docker where esbuild
# can run freely, then serving the output with a plain HTTP server.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json .
RUN npm install --legacy-peer-deps
COPY slides.md style.css .
RUN ./node_modules/.bin/slidev build --base / slides.md

FROM node:20-alpine
WORKDIR /app
RUN npm install -g serve
COPY --from=build /app/dist .
EXPOSE 3030
CMD ["serve", "-l", "3030", "."]
