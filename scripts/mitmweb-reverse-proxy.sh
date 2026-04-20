#!/bin/bash
# Start a mitmweb reverse proxy to an explicitly provided target URL.
#
# Usage:
#   scripts/mitmweb-reverse-proxy.sh http://localhost:3000
#
# Starts a reverse proxy on http://127.0.0.1:9090 with mitmweb UI on
# http://127.0.0.1:9091 and logs in tmp/mitmweb-reverse-proxy-9090.log.

set -euo pipefail

_die() {
  echo "$1" >&2
  return 1 2>/dev/null || exit 1
}

if [ "$#" -ne 1 ]; then
  _die "Usage: scripts/mitmweb-reverse-proxy.sh <target-url>"
fi

MITM_PROXY="http://127.0.0.1:9090"
MITM_WEB="http://127.0.0.1:9091"
MITM_TARGET="$1"
MITM_LOG_FILE="tmp/mitmweb-reverse-proxy-9090.log"
mkdir -p tmp

if ! command -v mitmweb &>/dev/null; then
  echo "mitmweb not found. Install it with one of:" >&2
  echo "  pip install mitmproxy" >&2
  echo "  brew install mitmproxy     # macOS" >&2
  echo "  pipx install mitmproxy" >&2
  return 1 2>/dev/null || exit 1
fi

_port_listening() {
  if command -v ss &>/dev/null; then
    ss -tlnp 2>/dev/null | grep -q ":$1 "
  elif command -v lsof &>/dev/null; then
    lsof -iTCP:"$1" -sTCP:LISTEN -P -n &>/dev/null
  else
    nc -z 127.0.0.1 "$1" 2>/dev/null
  fi
}

_kill_mitmweb_listener() {
  local port="$1"
  if ! command -v lsof &>/dev/null; then
    return 0
  fi

  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN -P -n 2>/dev/null || true)"
  [ -z "$pids" ] && return 0

  for pid in $pids; do
    local args
    args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
    if [[ "$args" == *mitmweb* ]]; then
      kill "$pid"
    else
      _die "ERROR: port $port is in use by a non-mitmweb process: $args"
    fi
  done
}

if _port_listening 9090 || _port_listening 9091; then
  _kill_mitmweb_listener 9090
  _kill_mitmweb_listener 9091
  sleep 0.5
fi

mkdir -p tmp

mitmweb \
  --mode "reverse:$MITM_TARGET" \
  --listen-port 9090 \
  --web-port 9091 \
  --no-web-open-browser \
  >>"$MITM_LOG_FILE" 2>&1 &

for _ in $(seq 1 10); do
  _port_listening 9090 && break
  sleep 0.5
done

if ! _port_listening 9090; then
  _die "ERROR: mitmweb reverse proxy failed to start on 9090."
fi

echo "----------------------------------------------"
echo "------  MITMWEB REVERSE PROXY ACTIVE  --------"
echo "----------------------------------------------"
echo "Proxy:   $MITM_PROXY"
echo "Target:  $MITM_TARGET"
echo "Web UI:  $MITM_WEB"
echo "Logs:    $MITM_LOG_FILE"
