#!/usr/bin/env bash
# Generate OpenAPI specs and TypeScript types from engine and service apps.
# Output: apps/{engine,service}/src/__generated__/{openapi.json,openapi.d.ts}
set -euo pipefail

cd "$(dirname "$0")/.."

engine_out=apps/engine/src/__generated__/openapi.json
service_out=apps/service/src/__generated__/openapi.json
engine_dts=apps/engine/src/__generated__/openapi.d.ts
service_dts=apps/service/src/__generated__/openapi.d.ts

check_mode=false
if [[ "${1:-}" == "--check" ]]; then
  check_mode=true
  tmpdir=$(mktemp -d)
  trap 'rm -rf "$tmpdir"' EXIT
  engine_out="$tmpdir/engine.json"
  service_out="$tmpdir/service.json"
  engine_dts="$tmpdir/engine.d.ts"
  service_dts="$tmpdir/service.d.ts"
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
curl -sf "http://localhost:$engine_port/openapi.json" | pnpm prettier --stdin-filepath openapi.json > "$engine_out"
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
  const resolver = await createConnectorResolver({
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
" | pnpm prettier --stdin-filepath openapi.json > "$service_out"

echo "Generating TypeScript types..."
# Resolve to absolute paths (needed because pnpm --filter changes cwd)
abs_engine_out="$(cd "$(dirname "$engine_out")" && pwd)/$(basename "$engine_out")"
abs_engine_dts="$(cd "$(dirname "$engine_dts")" && pwd)/$(basename "$engine_dts")"
abs_service_out="$(cd "$(dirname "$service_out")" && pwd)/$(basename "$service_out")"
abs_service_dts="$(cd "$(dirname "$service_dts")" && pwd)/$(basename "$service_dts")"
pnpm --filter @stripe/sync-engine exec openapi-typescript "$abs_engine_out" -o "$abs_engine_dts"
pnpm --filter @stripe/sync-service exec openapi-typescript "$abs_service_out" -o "$abs_service_dts"

if $check_mode; then
  drift=false
  for pair in \
    "engine.json:apps/engine/src/__generated__/openapi.json" \
    "service.json:apps/service/src/__generated__/openapi.json" \
    "engine.d.ts:apps/engine/src/__generated__/openapi.d.ts" \
    "service.d.ts:apps/service/src/__generated__/openapi.d.ts"; do
    file="${pair%%:*}"
    checked_in="${pair#*:}"
    generated="$tmpdir/$file"
    if ! diff -q "$generated" "$checked_in" > /dev/null 2>&1; then
      echo "DRIFT: $checked_in is out of date"
      diff --unified "$generated" "$checked_in" | head -40 || true
      drift=true
    fi
  done
  if $drift; then
    echo ""
    echo "Generated OpenAPI files are out of date. Run: ./scripts/generate-openapi.sh"
    exit 1
  fi
  echo "Generated OpenAPI files are up to date."
else
  # Copy to docs/openapi/ for publishing (CDN/static site)
  mkdir -p docs/openapi
  cp "$engine_out" docs/openapi/engine.json
  cp "$service_out" docs/openapi/service.json

  echo "Done:"
  echo "  $engine_out  ($(wc -l < "$engine_out") lines)"
  echo "  $service_out ($(wc -l < "$service_out") lines)"
  echo "  $engine_dts"
  echo "  $service_dts"
  echo "  docs/openapi/ (publishing copy)"
fi
