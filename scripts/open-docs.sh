#!/usr/bin/env bash
# Start engine or service API server and open Scalar docs in the browser.
# Usage: ./scripts/open-docs.sh [engine|service]
set -euo pipefail

APP="${1:-engine}"

if command -v bun &> /dev/null; then
  case "$APP" in
    engine)  PORT="${PORT:-3000}"; CMD="bun apps/engine/src/cli/index.ts serve --port $PORT" ;;
    service) PORT="${PORT:-4020}"; CMD="bun apps/service/src/bin/cli.ts serve --port $PORT" ;;
    *) echo "Usage: $0 [engine|service]" >&2; exit 1 ;;
  esac
else
  case "$APP" in
    engine)  PORT="${PORT:-3000}"; CMD="node apps/engine/dist/cli/index.js serve --port $PORT" ;;
    service) PORT="${PORT:-4020}"; CMD="node apps/service/dist/bin/cli.js serve --port $PORT" ;;
    *) echo "Usage: $0 [engine|service]" >&2; exit 1 ;;
  esac
fi

cd "$(dirname "$0")/.."

URL="http://localhost:$PORT/docs"
echo "Starting $APP on port $PORT..."
echo "Opening $URL"

# Start server in background, wait for it to be ready, then open browser
$CMD &
SERVER_PID=$!

# Wait for server to start accepting connections
for i in $(seq 1 30); do
  if curl -sf "http://localhost:$PORT/health" > /dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

open "$URL" 2>/dev/null || xdg-open "$URL" 2>/dev/null || echo "Open $URL in your browser"

echo "Server running (PID $SERVER_PID). Press Ctrl+C to stop."
wait $SERVER_PID
