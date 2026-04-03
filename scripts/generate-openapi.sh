#!/usr/bin/env bash
# Generate OpenAPI specs from engine and service apps.
# Output: apps/{engine,service}/src/__generated__/openapi.json
set -euo pipefail

cd "$(dirname "$0")/.."

engine_out=apps/engine/src/__generated__/openapi.json
service_out=apps/service/src/__generated__/openapi.json

check_mode=false
if [[ "${1:-}" == "--check" ]]; then
  check_mode=true
  tmpdir=$(mktemp -d)
  trap 'rm -rf "$tmpdir"' EXIT
  engine_out="$tmpdir/engine.json"
  service_out="$tmpdir/service.json"
fi

echo "Generating engine OpenAPI spec..."
engine_port=14444
node apps/engine/dist/cli/index.js serve --port $engine_port &
ENGINE_PID=$!
trap 'kill $ENGINE_PID 2>/dev/null || true' EXIT
for i in $(seq 1 20); do
  curl -sf "http://localhost:$engine_port/health" > /dev/null 2>&1 && break
  sleep 0.3
done
curl -sf "http://localhost:$engine_port/openapi.json" > "$engine_out"
kill $ENGINE_PID
wait $ENGINE_PID 2>/dev/null || true
trap - EXIT

echo "Generating service OpenAPI spec..."
node -e "
  import { createApp } from './apps/service/dist/api/app.js';
  import { createConnectorResolver } from './apps/engine/dist/index.js';
  import sourceStripe from './packages/source-stripe/dist/index.js';
  import destinationPostgres from './packages/destination-postgres/dist/index.js';
  import destinationGoogleSheets from './packages/destination-google-sheets/dist/index.js';
  const resolver = createConnectorResolver({
    sources: { stripe: sourceStripe.default ?? sourceStripe },
    destinations: { postgres: destinationPostgres.default ?? destinationPostgres, 'google-sheets': destinationGoogleSheets.default ?? destinationGoogleSheets },
  });
  const mockClient = {
    start: async () => {},
    getHandle: () => ({ signal: async () => {}, query: async () => ({}), terminate: async () => {} }),
    list: async function* () {},
  };
  const app = createApp({ temporal: { client: mockClient, taskQueue: 'gen' }, resolver });
  const res = await app.request('/openapi.json');
  const spec = await res.json();
  process.stdout.write(JSON.stringify(spec, null, 2) + '\n');
" > "$service_out"

pnpm exec prettier --config .prettierrc --log-level warn --write \
  "$engine_out" \
  "$service_out"

if $check_mode; then
  drift=false
  for pair in "engine:apps/engine/src/__generated__/openapi.json" "service:apps/service/src/__generated__/openapi.json"; do
    name="${pair%%:*}"
    checked_in="${pair#*:}"
    generated="$tmpdir/$name.json"
    if ! diff -q "$generated" "$checked_in" > /dev/null 2>&1; then
      echo "DRIFT: $checked_in is out of date"
      diff --unified "$generated" "$checked_in" || true
      drift=true
    fi
  done
  if $drift; then
    echo ""
    echo "OpenAPI specs are out of date. Run: ./scripts/generate-openapi.sh"
    exit 1
  fi
  echo "OpenAPI specs are up to date."
else
  # Copy to docs/openapi/ for publishing (CDN/static site)
  mkdir -p docs/openapi
  cp "$engine_out" docs/openapi/engine.json
  cp "$service_out" docs/openapi/service.json

  echo "Done:"
  echo "  $engine_out  ($(wc -l < "$engine_out") lines)"
  echo "  $service_out ($(wc -l < "$service_out") lines)"
  echo "  docs/openapi/ (publishing copy)"
fi
