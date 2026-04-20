#!/bin/bash
# Source this file to route Node/Bun/curl fetch traffic through mitmweb.
#
# Usage:
#   source scripts/mitmweb-forward-proxy.sh
#
# Starts a forward proxy on http://127.0.0.1:8080 with mitmweb UI on
# http://127.0.0.1:8081 and logs in tmp/mitmweb-forward-proxy-8080.log.
#
# mitmweb is started automatically if not already running.
# If an upstream proxy is configured in http_proxy/https_proxy, mitmweb will
# chain through it (e.g. on Stripe dev boxes). In clean environments (CI,
# local without a corp proxy) mitmweb runs in direct mode.
#
# Install mitmproxy if needed:
#   pip install mitmproxy          # any platform
#   brew install mitmproxy         # macOS
#   pipx install mitmproxy         # isolated install

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "Usage: source scripts/mitmweb-forward-proxy.sh" >&2
  exit 1
fi

MITM_PROXY="http://127.0.0.1:8080"
MITM_WEB="http://127.0.0.1:8081"
MITM_CA="$HOME/.mitmproxy/mitmproxy-ca-cert.pem"
MITM_LOG_FILE="tmp/mitmweb-forward-proxy-8080.log"

# ---------------------------------------------------------------------------
# 1. Ensure mitmweb is installed
# ---------------------------------------------------------------------------
if ! command -v mitmweb &>/dev/null; then
  echo "mitmweb not found. Install it with one of:"
  echo "  pip install mitmproxy"
  echo "  brew install mitmproxy     # macOS"
  echo "  pipx install mitmproxy"
  echo ""
  echo "Attempting auto-install via pip..."
  if command -v pip3 &>/dev/null; then
    pip3 install --quiet mitmproxy
  elif command -v pip &>/dev/null; then
    pip install --quiet mitmproxy
  else
    echo "ERROR: pip not found — install mitmproxy manually then re-run."
    return 1 2>/dev/null || exit 1
  fi
  if ! command -v mitmweb &>/dev/null; then
    echo "ERROR: mitmweb still not found after install (check PATH)."
    return 1 2>/dev/null || exit 1
  fi
  echo "mitmproxy installed."
fi

# ---------------------------------------------------------------------------
# 2. Start mitmweb if not already listening on 8080
# ---------------------------------------------------------------------------
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
      echo "ERROR: port $port is in use by a non-mitmweb process: $args"
      return 1
    fi
  done
}

if _port_listening 8080 || _port_listening 8081; then
  _kill_mitmweb_listener 8080 || return 1 2>/dev/null || exit 1
  _kill_mitmweb_listener 8081 || return 1 2>/dev/null || exit 1
  sleep 0.5
fi

if ! _port_listening 8080; then
  # Detect upstream proxy from the environment (set on Stripe dev boxes, absent in CI)
  UPSTREAM="${https_proxy:-${http_proxy:-}}"

  MITM_ARGS=(
    --listen-port 8080
    --web-port 8081
    --no-web-open-browser
    --ssl-insecure
    --set connection_strategy=lazy
  )

  if [ -n "$UPSTREAM" ]; then
    echo "Starting mitmweb with upstream proxy: $UPSTREAM"
    MITM_ARGS+=(--mode "upstream:$UPSTREAM")
  else
    echo "Starting mitmweb in direct mode (no upstream proxy detected)."
  fi
  mitmweb "${MITM_ARGS[@]}" >>"$MITM_LOG_FILE" 2>&1 &

  # Wait up to 5 s for the port to open
  for i in $(seq 1 10); do
    _port_listening 8080 && break
    sleep 0.5
  done

  if ! _port_listening 8080; then
    echo "ERROR: mitmweb failed to start (proxy port 8080)."
    return 1 2>/dev/null || exit 1
  fi

  # Verify the web UI is responding
  if command -v curl &>/dev/null; then
    if ! curl -s --max-time 3 "$MITM_WEB" >/dev/null 2>&1; then
      echo "WARNING: mitmweb proxy is listening but web UI ($MITM_WEB) is not responding."
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 3. Export proxy environment for all supported runtimes
# ---------------------------------------------------------------------------

# -- Proxy settings --
export HTTP_PROXY="$MITM_PROXY"
export HTTPS_PROXY="$MITM_PROXY"
export http_proxy="$MITM_PROXY"
export https_proxy="$MITM_PROXY"

# Clear no_proxy so localhost proxy address is never excluded as a destination
export NO_PROXY="localhost,127.0.0.1,::1,*.local,*.localhost"
export no_proxy="$NO_PROXY"

# -- Node.js (--use-env-proxy makes undici/fetch respect HTTP_PROXY) --
export NODE_EXTRA_CA_CERTS="$MITM_CA"
export NODE_TLS_REJECT_UNAUTHORIZED="0"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--use-env-proxy"

# -- npm/pnpm --
export npm_config_proxy="$MITM_PROXY"
export npm_config_https_proxy="$MITM_PROXY"
export npm_config_no_proxy="$NO_PROXY"

# -- curl / system TLS --
export CURL_CA_BUNDLE="$MITM_CA"
export SSL_CERT_FILE="$MITM_CA"
export SSL_CERT_DIR="$HOME/.mitmproxy"

# -- Python --
export REQUESTS_CA_BUNDLE="$MITM_CA"

# -- Git --
export GIT_SSL_CAINFO="$MITM_CA"

# -- global-agent (used by some Node libs) --
export GLOBAL_AGENT_HTTP_PROXY="$MITM_PROXY"
export GLOBAL_AGENT_NO_PROXY="$NO_PROXY"

# -- Go --
export GOPROXY="$MITM_PROXY,direct"
export GOFLAGS="-insecure"

echo "----------------------------------------------"
echo "--------  MITMWEB INTERCEPT ACTIVE  ----------"
echo "----------------------------------------------"
echo "Proxy:   $MITM_PROXY"
echo "Web UI:  $MITM_WEB"
echo "Logs:    $MITM_LOG_FILE"
echo "CA Cert: $MITM_CA"
echo ""
echo "Supports: Node fetch, Bun fetch, curl, Python requests, Go net/http"
echo ""
echo "To stop: unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NODE_TLS_REJECT_UNAUTHORIZED NODE_EXTRA_CA_CERTS"
