#!/bin/bash
# Source this file to route Node/Bun/curl fetch traffic through mitmweb.
#
# Usage:
#   source scripts/mitmweb-forward-proxy.sh
#
# Starts a forward proxy on http://127.0.0.1:9080 with mitmweb UI on
# http://127.0.0.1:9081 and logs in tmp/mitmweb-forward-proxy-9080.log.
#
# Requires mitmproxy 12+ for store_streamed_bodies support.
# Install or upgrade with:
#   pip install --user --index-url https://pypi.org/simple --upgrade 'mitmproxy>=12,<13'
#
# mitmweb 12+ requires web auth. We use a fixed local password: sync-engine
#   pipx install --pip-args='--index-url https://pypi.org/simple' 'mitmproxy>=12,<13'

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "Usage: source scripts/mitmweb-forward-proxy.sh" >&2
  exit 1
fi

MITM_PROXY="http://127.0.0.1:9080"
MITM_WEB="http://127.0.0.1:9081"
MITM_CA="$HOME/.mitmproxy/mitmproxy-ca-cert.pem"
MITM_LOG_FILE="tmp/mitmweb-forward-proxy-9080.log"
MITM_MIN_MAJOR=12
mkdir -p tmp

_mitmweb_major_version() {
  local version_line
  version_line="$(mitmweb --version 2>/dev/null | head -n 1 || true)"
  printf '%s\n' "$version_line" | sed -n 's/^Mitmproxy: \([0-9][0-9]*\)\..*/\1/p'
}

_abort_bad_mitmweb() {
  local major version_line
  if ! command -v mitmweb &>/dev/null; then
    echo "ERROR: mitmweb not found." >&2
    echo "Install mitmproxy 12+ with: pip install --user --index-url https://pypi.org/simple --upgrade 'mitmproxy>=12,<13'" >&2
    return 1
  fi

  version_line="$(mitmweb --version | head -n 1)"
  major="$(_mitmweb_major_version)"
  if [[ -z "$major" || "$major" -lt "$MITM_MIN_MAJOR" ]]; then
    echo "ERROR: $version_line is too old. mitmweb 12+ is required." >&2
    echo "Install mitmproxy 12+ with: pip install --user --index-url https://pypi.org/simple --upgrade 'mitmproxy>=12,<13'" >&2
    return 1
  fi
}

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
      echo "ERROR: port $port is in use by a non-mitmweb process: $args" >&2
      return 1
    fi
  done
}

_abort_bad_mitmweb || return 1 2>/dev/null || exit 1

if _port_listening 9080 || _port_listening 9081; then
  _kill_mitmweb_listener 9080 || return 1 2>/dev/null || exit 1
  _kill_mitmweb_listener 9081 || return 1 2>/dev/null || exit 1
  sleep 0.5
fi

if ! _port_listening 9080; then
  UPSTREAM="${https_proxy:-${http_proxy:-}}"

  MITM_ARGS=(
    --listen-port 9080
    --web-port 9081
    --no-web-open-browser
    --ssl-insecure
    --set connection_strategy=lazy
    --set stream_large_bodies=1b
    --set store_streamed_bodies=true
    --set web_password=sync-engine
  )

  if [ -n "$UPSTREAM" ]; then
    echo "Starting mitmweb with upstream proxy: $UPSTREAM"
    MITM_ARGS+=(--mode "upstream:$UPSTREAM")
  else
    echo "Starting mitmweb in direct mode (no upstream proxy detected)."
  fi

  mitmweb "${MITM_ARGS[@]}" >>"$MITM_LOG_FILE" 2>&1 &

  for i in $(seq 1 10); do
    _port_listening 9080 && break
    sleep 0.5
  done

  if ! _port_listening 9080; then
    echo "ERROR: mitmweb failed to start (proxy port 9080)." >&2
    return 1 2>/dev/null || exit 1
  fi

  if command -v curl &>/dev/null; then
    if ! curl -s --max-time 3 "$MITM_WEB" >/dev/null 2>&1; then
      echo "WARNING: mitmweb proxy is listening but web UI ($MITM_WEB) is not responding." >&2
    fi
  fi
fi

export HTTP_PROXY="$MITM_PROXY"
export HTTPS_PROXY="$MITM_PROXY"
export http_proxy="$MITM_PROXY"
export https_proxy="$MITM_PROXY"

export NO_PROXY="localhost,127.0.0.1,::1,*.local,*.localhost"
export no_proxy="$NO_PROXY"

export NODE_EXTRA_CA_CERTS="$MITM_CA"
export NODE_TLS_REJECT_UNAUTHORIZED="0"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--use-env-proxy"

export npm_config_proxy="$MITM_PROXY"
export npm_config_https_proxy="$MITM_PROXY"
export npm_config_no_proxy="$NO_PROXY"

export CURL_CA_BUNDLE="$MITM_CA"
export SSL_CERT_FILE="$MITM_CA"
export SSL_CERT_DIR="$HOME/.mitmproxy"

export REQUESTS_CA_BUNDLE="$MITM_CA"
export GIT_SSL_CAINFO="$MITM_CA"
export GLOBAL_AGENT_HTTP_PROXY="$MITM_PROXY"
export GLOBAL_AGENT_NO_PROXY="$NO_PROXY"
export GOPROXY="$MITM_PROXY,direct"
export GOFLAGS="-insecure"

echo "----------------------------------------------"
echo "--------  MITMWEB INTERCEPT ACTIVE  ----------"
echo "----------------------------------------------"
echo "Proxy:   $MITM_PROXY"
echo "Web UI:  $MITM_WEB"
echo "Logs:    $MITM_LOG_FILE"
echo "CA Cert: $MITM_CA"
echo "Version: $(mitmweb --version | head -n 1)"
echo ""
echo "Supports: Node fetch, Bun fetch, curl, Python requests, Go net/http"
echo ""
echo "To stop: unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NODE_TLS_REJECT_UNAUTHORIZED NODE_EXTRA_CA_CERTS"
