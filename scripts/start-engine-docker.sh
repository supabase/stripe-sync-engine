#!/usr/bin/env bash
set -euo pipefail

# Build and start the sync-engine Docker container with host networking.
# The engine listens on PORT (default 4242) and is accessible at http://localhost:$PORT.
#
# Usage:
#   ./scripts/start-engine-docker.sh          # build + run on port 4242
#   PORT=8080 ./scripts/start-engine-docker.sh  # custom port
#   ./scripts/start-engine-docker.sh --no-build # skip docker build, just run

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-4242}"
IMAGE_NAME="sync-engine:local"
CONTAINER_NAME="sync-engine-local"
SKIP_BUILD=false

for arg in "$@"; do
  case "$arg" in
    --no-build) SKIP_BUILD=true ;;
  esac
done

# Build
if [[ "$SKIP_BUILD" == "false" ]]; then
  echo "Building sync-engine Docker image..."

  # Resolve proxy (check both uppercase and lowercase variants)
  _http_proxy="${HTTP_PROXY:-${http_proxy:-}}"
  _https_proxy="${HTTPS_PROXY:-${https_proxy:-}}"
  _no_proxy="${NO_PROXY:-${no_proxy:-}}"

  BUILD_ARGS=(
    --target engine
    --build-arg "GIT_COMMIT=$(git rev-parse --short HEAD)"
    --build-arg "BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    --network host
    -t "$IMAGE_NAME"
  )
  # Forward proxy env vars so corepack/pnpm can reach the registry
  [[ -n "$_http_proxy" ]] && BUILD_ARGS+=(--build-arg "http_proxy=$_http_proxy" --build-arg "HTTP_PROXY=$_http_proxy")
  [[ -n "$_https_proxy" ]] && BUILD_ARGS+=(--build-arg "https_proxy=$_https_proxy" --build-arg "HTTPS_PROXY=$_https_proxy")
  [[ -n "$_no_proxy" ]] && BUILD_ARGS+=(--build-arg "no_proxy=$_no_proxy" --build-arg "NO_PROXY=$_no_proxy")
  docker build "${BUILD_ARGS[@]}" .
fi

# Stop any existing container
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

# Resolve proxy for run (in case we skipped build)
_http_proxy="${_http_proxy:-${HTTP_PROXY:-${http_proxy:-}}}"
_https_proxy="${_https_proxy:-${HTTPS_PROXY:-${https_proxy:-}}}"
_no_proxy="${_no_proxy:-${NO_PROXY:-${no_proxy:-}}}"

echo "Starting sync-engine on port $PORT (host networking)..."
exec docker run \
  --name "$CONTAINER_NAME" \
  --network host \
  -e PORT="$PORT" \
  -e NODE_ENV=production \
  -e LOG_LEVEL="${LOG_LEVEL:-info}" \
  -e LOG_PRETTY="${LOG_PRETTY:-true}" \
  -e http_proxy="$_http_proxy" \
  -e https_proxy="$_https_proxy" \
  -e no_proxy="$_no_proxy" \
  -e HTTP_PROXY="$_http_proxy" \
  -e HTTPS_PROXY="$_https_proxy" \
  -e NO_PROXY="$_no_proxy" \
  --rm \
  "$IMAGE_NAME"
