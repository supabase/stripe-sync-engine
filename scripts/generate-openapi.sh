#!/usr/bin/env bash
# Generate OpenAPI specs and TypeScript types from engine and service apps.
# Output: apps/{engine,service}/src/__generated__/{openapi.json,openapi.d.ts}
#
# Runs from TypeScript source via bun — no build required.
# Two-phase approach for speed:
#   Phase 1: Generate JSON specs (~1.4s). If nothing changed, exit early.
#   Phase 2: Run openapi-typescript to regenerate .d.ts files (only if specs changed).
set -euo pipefail

cd "$(dirname "$0")/.."

engine_json=apps/engine/src/__generated__/openapi.json
service_json=apps/service/src/__generated__/openapi.json
engine_dts=apps/engine/src/__generated__/openapi.d.ts
service_dts=apps/service/src/__generated__/openapi.d.ts

check_mode=false
if [[ "${1:-}" == "--check" ]]; then
  check_mode=true
fi

# ── Phase 1: Generate JSON specs to temp files ──────────────────

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

echo "Generating OpenAPI specs..."
if command -v bun &>/dev/null; then
  bun scripts/generate-openapi-specs.ts "$tmpdir/engine.json" "$tmpdir/service.json"
else
  npx tsx scripts/generate-openapi-specs.ts "$tmpdir/engine.json" "$tmpdir/service.json"
fi

# ── Early exit if nothing changed ───────────────────────────────

engine_changed=false
service_changed=false
diff -q "$tmpdir/engine.json" "$engine_json" > /dev/null 2>&1 || engine_changed=true
diff -q "$tmpdir/service.json" "$service_json" > /dev/null 2>&1 || service_changed=true

if ! $engine_changed && ! $service_changed; then
  echo "Specs are up to date — nothing to do."
  exit 0
fi

if $check_mode; then
  drift=false
  if $engine_changed; then
    echo "DRIFT: $engine_json is out of date"
    diff --unified "$tmpdir/engine.json" "$engine_json" | head -40 || true
    drift=true
  fi
  if $service_changed; then
    echo "DRIFT: $service_json is out of date"
    diff --unified "$tmpdir/service.json" "$service_json" | head -40 || true
    drift=true
  fi
  echo ""
  echo "Generated OpenAPI files are out of date. Run: ./scripts/generate-openapi.sh"
  exit 1
fi

# ── Phase 2: Copy specs + generate TypeScript types ─────────────

cp "$tmpdir/engine.json" "$engine_json"
cp "$tmpdir/service.json" "$service_json"

echo "Generating TypeScript types..."
abs_engine_json="$(cd "$(dirname "$engine_json")" && pwd)/$(basename "$engine_json")"
abs_engine_dts="$(cd "$(dirname "$engine_dts")" && pwd)/$(basename "$engine_dts")"
abs_service_json="$(cd "$(dirname "$service_json")" && pwd)/$(basename "$service_json")"
abs_service_dts="$(cd "$(dirname "$service_dts")" && pwd)/$(basename "$service_dts")"
pnpm --filter @stripe/sync-engine exec openapi-typescript "$abs_engine_json" -o "$abs_engine_dts" &
pnpm --filter @stripe/sync-service exec openapi-typescript "$abs_service_json" -o "$abs_service_dts" &
wait

# Copy to docs/openapi/ for publishing (CDN/static site)
mkdir -p docs/openapi
cp "$engine_json" docs/openapi/engine.json
cp "$service_json" docs/openapi/service.json

echo "Done:"
echo "  $engine_json  ($(wc -l < "$engine_json") lines)"
echo "  $service_json ($(wc -l < "$service_json") lines)"
echo "  $engine_dts"
echo "  $service_dts"
echo "  docs/openapi/ (publishing copy)"
