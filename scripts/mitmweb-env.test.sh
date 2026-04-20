#!/bin/bash
# Test that mitmweb-forward-proxy.sh correctly routes traffic through mitmweb.
# Requires mitmweb to already be running, or the env script will start it.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/mitmweb-forward-proxy.sh"

PASS=0
FAIL=0
FETCH_TARGET="https://httpbin.org/get"
WSS_TARGET="wss://ws.postman-echo.com/raw"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Run all tests in parallel
curl -sk --max-time 15 "$FETCH_TARGET" > "$TMP/curl.out" 2>&1 &
PID_CURL=$!

timeout 15 node -e "
  fetch('$FETCH_TARGET').then(r=>r.json()).then(j=>console.log(JSON.stringify(j))).catch(e=>console.error(e.message))
" > "$TMP/node.out" 2>&1 &
PID_NODE=$!

timeout 15 bun -e "
  const r = await fetch('$FETCH_TARGET');
  const j = await r.json();
  console.log(JSON.stringify(j));
" > "$TMP/bun.out" 2>&1 &
PID_BUN=$!

# ws does not respect HTTP_PROXY or --use-env-proxy; must use HttpsProxyAgent explicitly.
# Run from source-stripe package dir so ws and https-proxy-agent can be resolved.
timeout 15 node --input-type=module \
  --loader "data:text/javascript,import{createRequire}from'module';const r=createRequire('$SCRIPT_DIR/../packages/source-stripe/package.json');import.meta.resolve=s=>r.resolve(s);" \
  <<EOF > "$TMP/ws.out" 2>&1 &
import { createRequire } from 'module';
const require = createRequire('$SCRIPT_DIR/../packages/source-stripe/package.json');
const { WebSocket } = require('ws');
const { HttpsProxyAgent } = require('https-proxy-agent');
const agent = new HttpsProxyAgent('$MITM_PROXY');
const ws = new WebSocket('$WSS_TARGET', { agent });
ws.on('open', () => ws.send('probe'));
ws.on('message', (d) => { console.log(JSON.stringify({ echo: d.toString() })); ws.close(); process.exit(0); });
ws.on('error', (e) => { console.error(e.message); process.exit(1); });
setTimeout(() => { console.error('timeout'); process.exit(1); }, 12000);
EOF
PID_WS=$!

wait $PID_CURL $PID_NODE $PID_BUN $PID_WS 2>/dev/null

echo ""
for runtime in curl node bun; do
  file="$TMP/$runtime.out"
  origin=$(grep -o '"origin":\s*"[^"]*"' "$file" 2>/dev/null | head -1 | cut -d'"' -f4)
  if [ -z "$origin" ]; then
    origin=$(grep -o '"origin": "[^"]*"' "$file" 2>/dev/null | head -1 | cut -d'"' -f4)
  fi
  if [ -n "$origin" ]; then
    echo "PASS: $runtime fetch (origin=$origin)"
    ((PASS++))
  else
    echo "FAIL: $runtime fetch"
    echo "  output: $(head -5 "$file" 2>/dev/null)"
    ((FAIL++))
  fi
done

# ws test: check the echoed message came back
ws_echo=$(grep -o '"echo":\s*"[^"]*"' "$TMP/ws.out" 2>/dev/null | head -1 | cut -d'"' -f4)
if [ "$ws_echo" = "probe" ]; then
  echo "PASS: ws WebSocket (echo=$ws_echo)"
  ((PASS++))
else
  echo "FAIL: ws WebSocket"
  echo "  output: $(head -5 "$TMP/ws.out" 2>/dev/null)"
  ((FAIL++))
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
[ "$FAIL" -eq 0 ]
