#!/usr/bin/env bash
# Generate OpenAPI specs from both engine and service apps.
# Output: docs/openapi/engine.json, docs/openapi/service.json
set -euo pipefail

cd "$(dirname "$0")/.."

mkdir -p docs/openapi

echo "Generating engine OpenAPI spec..."
node -e "
  import { createApp, createConnectorResolver } from './apps/engine/dist/index.js';
  const app = createApp(createConnectorResolver({}));
  const res = await app.request('/openapi.json');
  const spec = await res.json();
  process.stdout.write(JSON.stringify(spec, null, 2) + '\n');
" > docs/openapi/engine.json

echo "Generating service OpenAPI spec..."
node -e "
  import { createApp } from './apps/service/dist/api/app.js';
  const app = createApp({ dataDir: '/tmp/sync-openapi-gen' });
  const res = await app.request('/openapi.json');
  const spec = await res.json();
  process.stdout.write(JSON.stringify(spec, null, 2) + '\n');
" > docs/openapi/service.json

echo "Done:"
echo "  docs/openapi/engine.json  ($(wc -l < docs/openapi/engine.json) lines)"
echo "  docs/openapi/service.json ($(wc -l < docs/openapi/service.json) lines)"
