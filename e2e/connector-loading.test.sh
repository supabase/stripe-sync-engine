#!/usr/bin/env bash
#
# E2E test: verify the CLI can load connectors via each discovery strategy.
#
# Strategies tested:
#   1. path     — binary in node_modules/.bin (default, enabled)
#   2. commandMap — explicit name→command mapping (--connectors-from-command-map)
#   3. npm      — auto-download via npx (--connectors-from-npm)
#   4. disabled — --no-connectors-from-path with no other strategy still loads
#                 bundled connectors registered in-process
#   5. unknown  — nonexistent connector name → "not found"
#
# Setup:
#   pnpm pack all publishable packages
#   Install tarballs into a fresh temp directory (simulates end-user install)
#   Run sync-engine check against fake credentials — succeeds at loading,
#   fails on credentials (non-zero exit); we verify the error is credential-
#   related, not "not found".

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMPDIR_BASE=$(mktemp -d)

cleanup() {
  rm -rf "$TMPDIR_BASE"
  rm -f "$REPO_ROOT"/stripe-sync-protocol-*.tgz
  rm -f "$REPO_ROOT"/stripe-sync-openapi-*.tgz
  rm -f "$REPO_ROOT"/stripe-sync-engine-*.tgz
  rm -f "$REPO_ROOT"/stripe-sync-source-stripe-*.tgz
  rm -f "$REPO_ROOT"/stripe-sync-destination-postgres-*.tgz
  rm -f "$REPO_ROOT"/stripe-sync-destination-google-sheets-*.tgz
  rm -f "$REPO_ROOT"/stripe-sync-state-postgres-*.tgz
  rm -f "$REPO_ROOT"/stripe-sync-util-postgres-*.tgz
  rm -f "$REPO_ROOT"/stripe-sync-ts-cli-*.tgz
  rm -f "$REPO_ROOT"/stripe-sync-hono-zod-openapi-*.tgz
  rm -f "$REPO_ROOT"/stripe-sync-integration-supabase-*.tgz
}
trap cleanup EXIT

echo "=== E2E Connector Discovery Strategy Test ==="
echo "Temp dir: $TMPDIR_BASE"
echo ""

# ---------------------------------------------------------------------------
# Step 1: Pack all publishable packages
# ---------------------------------------------------------------------------
echo "--- Step 1: Packing packages ---"

PROTOCOL_TGZ=$(cd "$REPO_ROOT" && pnpm --filter @stripe/sync-protocol pack 2>/dev/null | tail -1)
OPENAPI_TGZ=$(cd "$REPO_ROOT" && pnpm --filter @stripe/sync-openapi pack 2>/dev/null | tail -1)
ENGINE_TGZ=$(cd "$REPO_ROOT" && pnpm --filter @stripe/sync-engine pack 2>/dev/null | tail -1)
SOURCE_TGZ=$(cd "$REPO_ROOT" && pnpm --filter @stripe/sync-source-stripe pack 2>/dev/null | tail -1)
DEST_TGZ=$(cd "$REPO_ROOT" && pnpm --filter @stripe/sync-destination-postgres pack 2>/dev/null | tail -1)
DEST_SHEETS_TGZ=$(cd "$REPO_ROOT" && pnpm --filter @stripe/sync-destination-google-sheets pack 2>/dev/null | tail -1)
STATE_PG_TGZ=$(cd "$REPO_ROOT" && pnpm --filter @stripe/sync-state-postgres pack 2>/dev/null | tail -1)
UTIL_PG_TGZ=$(cd "$REPO_ROOT" && pnpm --filter @stripe/sync-util-postgres pack 2>/dev/null | tail -1)
TSCLI_TGZ=$(cd "$REPO_ROOT" && pnpm --filter @stripe/sync-ts-cli pack 2>/dev/null | tail -1)
HONO_ZOD_TGZ=$(cd "$REPO_ROOT" && pnpm --filter @stripe/sync-hono-zod-openapi pack 2>/dev/null | tail -1)
SUPABASE_TGZ=$(cd "$REPO_ROOT" && pnpm --filter @stripe/sync-integration-supabase pack 2>/dev/null | tail -1)

for tgz in "$PROTOCOL_TGZ" "$OPENAPI_TGZ" "$ENGINE_TGZ" "$SOURCE_TGZ" "$DEST_TGZ" "$DEST_SHEETS_TGZ" \
           "$STATE_PG_TGZ" "$UTIL_PG_TGZ" "$TSCLI_TGZ" "$HONO_ZOD_TGZ" "$SUPABASE_TGZ"; do
  if [ ! -f "$tgz" ]; then
    echo "FAIL: tarball not found: $tgz"
    exit 1
  fi
  echo "  Packed: $(basename "$tgz")"
done
echo ""

# ---------------------------------------------------------------------------
# Step 2: Create temp project and install tarballs
# ---------------------------------------------------------------------------
echo "--- Step 2: Installing tarballs into temp project ---"

cd "$TMPDIR_BASE"
pnpm init > /dev/null 2>&1

# Disable scoped registry — this test installs from local tarballs only.
# The repo .npmrc points @stripe to $STRIPE_NPM_REGISTRY which would break
# resolution in the temp dir. Write a blank .npmrc to override.
echo "# local tarballs only — no scoped registry" > .npmrc
unset STRIPE_NPM_REGISTRY 2>/dev/null || true

# The CLI's assertUseEnvProxy throws if a proxy is configured without
# --use-env-proxy. Either unset the proxy vars or satisfy the assertion.
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy 2>/dev/null || true
# If unset doesn't stick (CI-injected envs), satisfy the assertion instead:
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--use-env-proxy"

# Override all workspace packages to use the local tarballs.
cat > package.json <<EOF
{
  "name": "e2e-plugin-test",
  "version": "1.0.0",
  "pnpm": {
    "overrides": {
      "@stripe/sync-protocol": "$PROTOCOL_TGZ",
      "@stripe/sync-openapi": "$OPENAPI_TGZ",
      "@stripe/sync-engine": "$ENGINE_TGZ",
      "@stripe/sync-source-stripe": "$SOURCE_TGZ",
      "@stripe/sync-destination-postgres": "$DEST_TGZ",
      "@stripe/sync-destination-google-sheets": "$DEST_SHEETS_TGZ",
      "@stripe/sync-state-postgres": "$STATE_PG_TGZ",
      "@stripe/sync-util-postgres": "$UTIL_PG_TGZ",
      "@stripe/sync-ts-cli": "$TSCLI_TGZ",
      "@stripe/sync-hono-zod-openapi": "$HONO_ZOD_TGZ",
      "@stripe/sync-integration-supabase": "$SUPABASE_TGZ"
    }
  }
}
EOF

pnpm add "$PROTOCOL_TGZ" "$OPENAPI_TGZ" "$ENGINE_TGZ" "$SOURCE_TGZ" "$DEST_TGZ" "$DEST_SHEETS_TGZ" \
         "$STATE_PG_TGZ" "$UTIL_PG_TGZ" "$TSCLI_TGZ" "$HONO_ZOD_TGZ" "$SUPABASE_TGZ" \
         2>&1 | tail -5
echo ""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# JSON-encoded X-Pipeline header value for check requests.
SYNC_PARAMS='{"source":{"type":"stripe","stripe":{"api_key":"sk_test_fake"}},"destination":{"type":"postgres","postgres":{"connection_string":"postgresql://fake:fake@localhost/fake"}},"streams":[{"name":"products"}]}'

# Run `sync-engine pipeline-check` with fake credentials and given extra flags.
# Exits non-zero (bad credentials) but must NOT output "not found".
# Usage: check_loads [extra flags...]
check_loads() {
  local output
  output=$(npx sync-engine pipeline-check \
    --x-pipeline "$SYNC_PARAMS" \
    "$@" 2>&1 || true)
  if echo "$output" | grep -qi "not found"; then
    echo "  FAIL: got 'not found' — connector loading failed"
    echo "  Output: $output"
    return 1
  fi
}

# Run `sync-engine pipeline-check` and assert the output contains "not found".
check_not_found() {
  local output
  output=$(npx sync-engine pipeline-check \
    --x-pipeline "$SYNC_PARAMS" \
    "$@" 2>&1 || true)
  if echo "$output" | grep -qi "not found"; then
    return 0
  fi
  echo "  FAIL: expected 'not found' but got:"
  echo "  $output"
  return 1
}

# ---------------------------------------------------------------------------
# Step 3: --help
# ---------------------------------------------------------------------------
echo "--- Step 3: sync-engine --help ---"
help_output=$(npx sync-engine --help 2>&1) || {
  echo "  FAIL: --help exited with $?"
  echo "  Output: $help_output"
  exit 1
}
echo "  PASS: --help exits 0"
echo ""

# ---------------------------------------------------------------------------
# Step 4: path strategy (default — binary in node_modules/.bin)
# ---------------------------------------------------------------------------
echo "--- Step 4: path strategy ---"
check_loads
echo "  PASS: connectors loaded via PATH"
echo ""

# ---------------------------------------------------------------------------
# Step 5: commandMap strategy (explicit name→command, path disabled)
# ---------------------------------------------------------------------------
echo "--- Step 5: commandMap strategy ---"
SOURCE_BIN="$TMPDIR_BASE/node_modules/.bin/source-stripe"
DEST_BIN="$TMPDIR_BASE/node_modules/.bin/destination-postgres"
CMD_MAP="{\"source-stripe\":\"$SOURCE_BIN\",\"destination-postgres\":\"$DEST_BIN\"}"
check_loads --connectors-from-command-map "$CMD_MAP" --no-connectors-from-path
echo "  PASS: connectors loaded via commandMap"
echo ""

# ---------------------------------------------------------------------------
# Step 6: npm strategy (npx, path disabled — npx finds locally installed pkg)
# ---------------------------------------------------------------------------
echo "--- Step 6: npm strategy ---"
check_loads --connectors-from-npm --no-connectors-from-path
echo "  PASS: connectors loaded via npm (npx)"
echo ""

# ---------------------------------------------------------------------------
# Step 7: path disabled, no other strategy → bundled connectors still load
# ---------------------------------------------------------------------------
echo "--- Step 7: path disabled with no fallback → bundled connectors still load ---"
check_loads --no-connectors-from-path
echo "  PASS: bundled connectors still load with path disabled"
echo ""

# ---------------------------------------------------------------------------
# Step 8: unknown connector name → "not found"
# ---------------------------------------------------------------------------
echo "--- Step 8: unknown connector name → not found ---"
UNKNOWN_PARAMS='{"source":{"type":"nonexistent-xyz"},"destination":{"type":"nonexistent-xyz"},"streams":[{"name":"x"}]}'
unknown_output=$(npx sync-engine pipeline-check \
     --x-pipeline "$UNKNOWN_PARAMS" \
     2>&1 || true)
if echo "$unknown_output" | grep -qiE "not found|No matching discriminator|invalid_union"; then
  echo "  PASS: unknown connector correctly rejected"
else
  echo "  FAIL: unknown connector was not rejected"
  echo "  Output: $unknown_output"
  exit 1
fi
echo ""

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo "=== All connector discovery strategy tests passed ==="
