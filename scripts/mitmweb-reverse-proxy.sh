#!/bin/bash
# Start a mitmweb reverse proxy to an explicitly provided target URL.
#
# Usage:
#   scripts/mitmweb-reverse-proxy.sh http://localhost:3000
#
# Starts a reverse proxy on http://127.0.0.1:9090 with mitmweb UI on
# http://127.0.0.1:9091 and logs in tmp/mitmweb-reverse-proxy-9090.log.
#
# Requires mitmproxy 12+ for store_streamed_bodies support.
# Install or upgrade with:
#   pip install --user --index-url https://pypi.org/simple --upgrade 'mitmproxy>=12,<13'
#
# mitmweb 12+ requires web auth. We use a fixed local password: sync-engine

set -euo pipefail

MITM_MIN_MAJOR=12

_die() {
  echo "$1" >&2
  return 1 2>/dev/null || exit 1
}

_mitmweb_major_version() {
  local version_line
  version_line="$(mitmweb --version 2>/dev/null | head -n 1 || true)"
  printf '%s\n' "$version_line" | sed -n 's/^Mitmproxy: \([0-9][0-9]*\)\..*/\1/p'
}

_abort_bad_mitmweb() {
  local major version_line
  if ! command -v mitmweb &>/dev/null; then
    _die "ERROR: mitmweb not found. Install mitmproxy 12+ with: pip install --user --index-url https://pypi.org/simple --upgrade 'mitmproxy>=12,<13'"
  fi

  version_line="$(mitmweb --version | head -n 1)"
  major="$(_mitmweb_major_version)"
  if [[ -z "$major" || "$major" -lt "$MITM_MIN_MAJOR" ]]; then
    _die "ERROR: $version_line is too old. mitmweb 12+ is required. Install with: pip install --user --index-url https://pypi.org/simple --upgrade 'mitmproxy>=12,<13'"
  fi
}

if [ "$#" -ne 1 ]; then
  _die "Usage: scripts/mitmweb-reverse-proxy.sh <target-url>"
fi

MITM_PROXY="http://127.0.0.1:9090"
MITM_WEB="http://127.0.0.1:9091"
MITM_TARGET="$1"
MITM_LOG_FILE="tmp/mitmweb-reverse-proxy-9090.log"
mkdir -p tmp

_abort_bad_mitmweb

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

mitmweb \
  --mode "reverse:$MITM_TARGET" \
  --listen-port 9090 \
  --web-port 9091 \
  --no-web-open-browser \
  --set stream_large_bodies=1b \
  --set store_streamed_bodies=true \
  --set web_password=sync-engine \
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
echo "Version: $(mitmweb --version | head -n 1)"
