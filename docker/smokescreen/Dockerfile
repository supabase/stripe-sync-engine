# Pinned release: v0.0.4 — https://github.com/stripe/smokescreen/releases/tag/v0.0.4
ARG SMOKESCREEN_SHA=e196cd61a007e1cdbde5579fe2dac95e7154190c

FROM golang:1.23 AS builder
ARG SMOKESCREEN_SHA
WORKDIR /app
RUN set -eu; \
  git init; \
  git remote add origin https://github.com/stripe/smokescreen.git; \
  git fetch --depth 1 origin "${SMOKESCREEN_SHA}"; \
  git checkout FETCH_HEAD; \
  test "$(git rev-parse HEAD)" = "${SMOKESCREEN_SHA}"
RUN CGO_ENABLED=0 GOOS=linux go build -o smokescreen -ldflags="-s -w" .

FROM alpine:3.19
RUN apk add --no-cache netcat-openbsd
COPY --from=builder /app/smokescreen /usr/local/bin/smokescreen
ENTRYPOINT ["smokescreen"]
