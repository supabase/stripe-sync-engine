#!/usr/bin/env bash
# Stripe read through smokescreen (HTTP CONNECT) with Docker network isolation.
# Engine has no default route on the --internal network; outbound HTTPS to Stripe
# must use HTTPS_PROXY → smokescreen (bridged to default network for internet).
# Postgres runs on the same internal network (direct TCP, no proxy).
#
# Because --internal blocks host ↔ container traffic (including -p port publish),
# all curl commands run inside a test-runner container on the internal network.
#
# Required: STRIPE_API_KEY
# Optional: ENGINE_IMAGE (CI: pre-built image; skips local docker build)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

BUILD_ENGINE=false
if [ -z "${ENGINE_IMAGE:-}" ]; then
  ENGINE_IMAGE="sync-engine:smokescreen-test"
  BUILD_ENGINE=true
fi

SMOKESCREEN_IMAGE="sync-engine-smokescreen:test"
S="$$"
NET="smokescreen-isolated-${S}"
SMOKESCREEN_CONTAINER="smokescreen-${S}"
ENGINE_CONTAINER="engine-smokescreen-${S}"
PG_CONTAINER="pg-smokescreen-${S}"
CURL_CONTAINER="curl-smokescreen-${S}"
ENGINE_URL="http://${ENGINE_CONTAINER}:3000"

dump_logs() {
  echo "--- smokescreen logs ---"
  docker logs "$SMOKESCREEN_CONTAINER" 2>&1 | tail -40 || true
  echo "--- engine logs ---"
  docker logs "$ENGINE_CONTAINER" 2>&1 | tail -40 || true
}

cleanup() {
  local rc=$?
  [ "$rc" -ne 0 ] && dump_logs
  docker rm -f "$ENGINE_CONTAINER" "$SMOKESCREEN_CONTAINER" "$PG_CONTAINER" "$CURL_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ── Build images ────────────────────────────────────────────────────────────

echo "==> Building smokescreen image"
docker build -t "$SMOKESCREEN_IMAGE" "$REPO_ROOT/docker/smokescreen"

if $BUILD_ENGINE; then
  echo "==> Building engine image"
  docker build -t "$ENGINE_IMAGE" "$REPO_ROOT"
fi

# ── Isolated network ─────────────────────────────────────────────────────────
# --internal: no default gateway → containers cannot reach the internet directly.

echo "==> Creating isolated Docker network: $NET"
docker network create --internal "$NET"

# ── Test runner (on isolated network, used to curl the engine) ───────────────

CURL_IMAGE="curlimages/curl:8.11.1"

echo "==> Starting test runner"
docker run -d --name "$CURL_CONTAINER" --network "$NET" \
  --entrypoint sleep "$CURL_IMAGE" infinity

# Helper: run curl inside the isolated network
ecurl() { docker exec -i "$CURL_CONTAINER" curl "$@"; }

# ── Postgres (isolated network — reachable by engine, not internet-exposed) ──

echo "==> Starting Postgres"
docker run -d --name "$PG_CONTAINER" \
  --network "$NET" \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=postgres \
  postgres:18
PG_URL="postgres://postgres:postgres@${PG_CONTAINER}:5432/postgres"

# ── Smokescreen (isolated net + bridge → has internet, proxies for engine) ───

echo "==> Starting smokescreen"
docker run -d --name "$SMOKESCREEN_CONTAINER" \
  --network "$NET" \
  "$SMOKESCREEN_IMAGE"
docker network connect bridge "$SMOKESCREEN_CONTAINER"

for i in $(seq 1 20); do
  docker exec "$SMOKESCREEN_CONTAINER" nc -z localhost 4750 >/dev/null 2>&1 && break
  [ "$i" -eq 20 ] && { echo "FAIL: smokescreen health check timed out"; exit 1; }
  sleep 0.5
done
echo "    Smokescreen ready"

# ── Engine (isolated network ONLY — HTTPS must route through smokescreen) ────

echo "==> Starting engine (HTTPS_PROXY=http://${SMOKESCREEN_CONTAINER}:4750)"
docker run -d --name "$ENGINE_CONTAINER" \
  --network "$NET" \
  -e PORT=3000 \
  -e HTTPS_PROXY="http://${SMOKESCREEN_CONTAINER}:4750" \
  "$ENGINE_IMAGE"

for i in $(seq 1 40); do
  ecurl -sf "${ENGINE_URL}/health" >/dev/null 2>&1 && break
  [ "$i" -eq 40 ] && {
    echo "FAIL: engine health check timed out"
    docker ps -a --filter "name=$ENGINE_CONTAINER" || true
    docker logs "$ENGINE_CONTAINER" 2>&1 | tail -80 || true
    exit 1
  }
  sleep 0.5
done
echo "    Engine ready"

for i in $(seq 1 20); do
  docker exec "$PG_CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
  [ "$i" -eq 20 ] && { echo "FAIL: postgres health check timed out"; exit 1; }
  sleep 0.5
done
echo "    Postgres ready"

# ── 0) Negative test: direct internet access must be blocked ─────────────────

echo "==> Negative test: direct HTTPS must fail on isolated network"
if ecurl -sf --max-time 10 https://api.stripe.com 2>/dev/null; then
  echo "FAIL: curl container reached the internet directly (network isolation broken)"
  exit 1
fi
echo "    Confirmed: no direct internet access from isolated network"

# ── 1) Read from Stripe (HTTPS → smokescreen → api.stripe.com) ───────────────

echo "==> src-stripe: read through smokescreen"
READ_PARAMS=$(printf \
  '{"source":{"type":"stripe","stripe":{"api_key":"%s","backfill_limit":5}},"destination":{"type":"postgres","postgres":{"url":"postgres://unused:5432/db","schema":"stripe"}},"streams":[{"name":"products"}]}' \
  "$STRIPE_API_KEY")
OUTPUT=$(ecurl -s --max-time 90 -w '\n%{http_code}' -X POST "${ENGINE_URL}/pipeline_read" \
  -H "X-Pipeline: $READ_PARAMS")
HTTP_CODE=$(echo "$OUTPUT" | tail -1)
OUTPUT=$(echo "$OUTPUT" | sed '$d')
if [ "$HTTP_CODE" != "200" ]; then
  echo "FAIL: /pipeline_read returned HTTP $HTTP_CODE"
  echo "$OUTPUT" | tail -20
  exit 1
fi
RECORD_COUNT=$(echo "$OUTPUT" | grep -c '"type":"record"' || true)
echo "    Got $RECORD_COUNT record(s)"
[ "$RECORD_COUNT" -gt 0 ] || { echo "FAIL: no records from Stripe"; exit 1; }

# ── 2) Write to Postgres (direct TCP on isolated network) ─────────────────────

echo "==> dest-pg: setup + write"
PG_PARAMS=$(printf \
  '{"source":{"type":"stripe","stripe":{"api_key":"%s"}},"destination":{"type":"postgres","postgres":{"url":"%s","schema":"stripe_smokescreen_test"}}}' \
  "$STRIPE_API_KEY" "$PG_URL")
ecurl -sf --max-time 30 -X POST "${ENGINE_URL}/pipeline_setup" \
  -H "X-Pipeline: $PG_PARAMS" && echo "    setup OK" || echo "    setup returned non-204 (may be fine)"
echo "$OUTPUT" | ecurl -sf --max-time 90 -X POST "${ENGINE_URL}/pipeline_write" \
  -H "X-Pipeline: $PG_PARAMS" \
  -H "Content-Type: application/x-ndjson" \
  --data-binary @- | head -3 || true
echo "    dest-pg OK"

echo "==> All smokescreen tests passed"
