#!/usr/bin/env bash
# Generate OpenAPI specs from both engine and service apps.
# Output: docs/openapi/engine.json, docs/openapi/service.json
set -euo pipefail

cd "$(dirname "$0")/.."

check_mode=false
if [[ "${1:-}" == "--check" ]]; then
  check_mode=true
fi

if $check_mode; then
  outdir=$(mktemp -d)
  trap 'rm -rf "$outdir"' EXIT
else
  outdir=docs/openapi
  mkdir -p "$outdir"
fi

echo "Generating engine OpenAPI spec..."
node -e "
  import { createApp, createConnectorResolver } from './apps/engine/dist/index.js';
  const app = createApp(createConnectorResolver({}));
  const res = await app.request('/openapi.json');
  const spec = await res.json();
  process.stdout.write(JSON.stringify(spec, null, 2) + '\n');
" > "$outdir/engine.json"

echo "Generating service OpenAPI spec..."
node -e "
  import { createApp } from './apps/service/dist/api/app.js';
  const app = createApp({ dataDir: '/tmp/sync-openapi-gen' });
  const res = await app.request('/openapi.json');
  const spec = await res.json();
  process.stdout.write(JSON.stringify(spec, null, 2) + '\n');
" > "$outdir/service.json"

if ! $check_mode; then
  pnpm prettier --write "$outdir/engine.json" "$outdir/service.json" --log-level warn
fi

if $check_mode; then
  drift=false
  for spec in engine.json service.json; do
    if ! diff -q "$outdir/$spec" "docs/openapi/$spec" > /dev/null 2>&1; then
      echo "DRIFT: docs/openapi/$spec is out of date"
      diff --unified "$outdir/$spec" "docs/openapi/$spec" || true
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
  echo "Done:"
  echo "  docs/openapi/engine.json  ($(wc -l < docs/openapi/engine.json) lines)"
  echo "  docs/openapi/service.json ($(wc -l < docs/openapi/service.json) lines)"
fi
