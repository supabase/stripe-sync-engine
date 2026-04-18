#!/usr/bin/env bash
# Start engine, service, or webhook server and open Scalar docs in the browser.
# Usage: ./scripts/open-docs.sh [engine|service|webhook]
set -euo pipefail

APP="${1:-engine}"
RUN="$(dirname "$0")/ts-run"

case "$APP" in
  engine)  PORT="${PORT:-3000}"; ENTRY="apps/engine/src/cli/index.ts";  CMD_ARGS="serve --port $PORT" ;;
  service) PORT="${PORT:-4020}"; ENTRY="apps/service/src/bin/cli.ts";   CMD_ARGS="serve --port $PORT" ;;
  webhook) PORT="${PORT:-4030}"; ENTRY="apps/service/src/bin/cli.ts";   CMD_ARGS="webhook --port $PORT --temporal-address localhost:7233" ;;
  *) echo "Usage: $0 [engine|service|webhook]" >&2; exit 1 ;;
esac

CMD="$RUN $ENTRY $CMD_ARGS"

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
