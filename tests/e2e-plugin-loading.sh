#!/usr/bin/env bash
#
# E2E test: verify the CLI can load connectors from real npm packages
# (outside the monorepo workspace graph).
#
# Steps:
#   1. pnpm pack all publishable packages
#   2. Install tarballs into a fresh temp directory
#   3. Verify: sync-engine --help exits 0
#   4. Verify: check command with valid connectors loads them (fails on credentials, not loading)
#   5. Verify: check command with unknown connector gives clear "not found" error
#   6. Cleanup

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMPDIR_BASE=$(mktemp -d)

cleanup() {
  rm -rf "$TMPDIR_BASE"
  # Clean up tarballs created by pnpm pack (they go to repo root)
  rm -f "$REPO_ROOT"/stripe-protocol-*.tgz
  rm -f "$REPO_ROOT"/stripe-stateless-sync-*.tgz
  rm -f "$REPO_ROOT"/stripe-source-stripe-*.tgz
  rm -f "$REPO_ROOT"/stripe-destination-postgres-*.tgz
  rm -f "$REPO_ROOT"/stripe-sync-engine-stateless-cli-*.tgz
}
trap cleanup EXIT

echo "=== E2E Plugin Loading Test ==="
echo "Temp dir: $TMPDIR_BASE"
echo ""

# ---------------------------------------------------------------------------
# Step 1: Pack all publishable packages
# ---------------------------------------------------------------------------
echo "--- Step 1: Packing packages ---"

# pnpm pack outputs the absolute tarball path as the last line
PROTOCOL_TGZ=$(cd "$REPO_ROOT" && pnpm --filter @stripe/protocol pack 2>/dev/null | tail -1)
ENGINE_TGZ=$(cd "$REPO_ROOT" && pnpm --filter @stripe/stateless-sync pack 2>/dev/null | tail -1)
SOURCE_TGZ=$(cd "$REPO_ROOT" && pnpm --filter @stripe/source-stripe pack 2>/dev/null | tail -1)
DEST_TGZ=$(cd "$REPO_ROOT" && pnpm --filter @stripe/destination-postgres pack 2>/dev/null | tail -1)
CLI_TGZ=$(cd "$REPO_ROOT" && pnpm --filter @stripe/sync-engine-stateless-cli pack 2>/dev/null | tail -1)

for tgz in "$PROTOCOL_TGZ" "$ENGINE_TGZ" "$SOURCE_TGZ" "$DEST_TGZ" "$CLI_TGZ"; do
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

# Override @stripe/protocol resolution to use the local tarball.
# Without this, pnpm tries to resolve the rewritten "0.1.0" from the npm registry.
cat > package.json <<EOF
{
  "name": "e2e-plugin-test",
  "version": "1.0.0",
  "pnpm": {
    "overrides": {
      "@stripe/protocol": "$PROTOCOL_TGZ",
      "@stripe/stateless-sync": "$ENGINE_TGZ"
    }
  }
}
EOF

pnpm add "$PROTOCOL_TGZ" "$ENGINE_TGZ" "$SOURCE_TGZ" "$DEST_TGZ" "$CLI_TGZ" 2>&1 | tail -5
echo ""

# ---------------------------------------------------------------------------
# Step 3: sync-engine --help
# ---------------------------------------------------------------------------
echo "--- Step 3: sync-engine --help ---"

if npx sync-engine --help > /dev/null 2>&1; then
  echo "  PASS: --help exits 0"
else
  echo "  FAIL: --help exited with $?"
  exit 1
fi
echo ""

# ---------------------------------------------------------------------------
# Step 4: check command loads connectors (fails on credentials, not loading)
# ---------------------------------------------------------------------------
echo "--- Step 4: check command with valid connectors ---"

PARAMS='{"source":"stripe","destination":"postgres","source_config":{"api_key":"sk_test_fake"},"destination_config":{"connection_string":"postgresql://fake:fake@localhost:5432/fake"}}'

# check will fail (bad credentials) but should NOT fail on "not found" or "conformance check"
CHECK_OUTPUT=$(npx sync-engine check --params "$PARAMS" 2>&1 || true)

if echo "$CHECK_OUTPUT" | grep -qi "not found"; then
  echo "  FAIL: check output contains 'not found' — connector loading failed"
  echo "  Output: $CHECK_OUTPUT"
  exit 1
fi

if echo "$CHECK_OUTPUT" | grep -qi "conformance check"; then
  echo "  FAIL: check output contains 'conformance check' — validation failed"
  echo "  Output: $CHECK_OUTPUT"
  exit 1
fi

echo "  PASS: connectors loaded successfully (check failed on credentials as expected)"
echo ""

# ---------------------------------------------------------------------------
# Step 5: unknown connector gives clear error
# ---------------------------------------------------------------------------
echo "--- Step 5: unknown connector gives clear error ---"

PARAMS_BAD='{"source":"stripe","destination":"nonexistent","source_config":{"api_key":"sk_test_fake"},"destination_config":{}}'

BAD_OUTPUT=$(npx sync-engine check --params "$PARAMS_BAD" 2>&1 || true)

if echo "$BAD_OUTPUT" | grep -qi "not found"; then
  echo "  PASS: unknown connector correctly reports 'not found'"
else
  echo "  FAIL: unknown connector did not report 'not found'"
  echo "  Output: $BAD_OUTPUT"
  exit 1
fi
echo ""

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo "=== All E2E plugin loading tests passed ==="
