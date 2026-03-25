#!/usr/bin/env bash
# Start engine or service API server and open Scalar docs in the browser.
# Usage: ./scripts/open-docs.sh [engine|service]
set -euo pipefail

APP="${1:-engine}"

if command -v bun &> /dev/null; then
  RUN="bun"; DIR="src"; EXT="ts"
else
  RUN="node"; DIR="dist"; EXT="js"
fi

case "$APP" in
  engine)  PORT="${PORT:-3000}"; ENTRY="apps/engine/$DIR/cli/index.$EXT" ;;
  service) PORT="${PORT:-4020}"; ENTRY="apps/service/$DIR/bin/cli.$EXT" ;;
  *) echo "Usage: $0 [engine|service]" >&2; exit 1 ;;
esac

CMD="$RUN $ENTRY serve --port $PORT"

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
