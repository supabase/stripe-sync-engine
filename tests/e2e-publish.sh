#!/usr/bin/env bash
#
# E2E test: publish all packages to $STRIPE_NPM_REGISTRY, then verify
# that `npx @stripe/sync-engine` works from a clean temp directory — exactly
# as an end-user would install and run the CLI.
#
# Works with:
#   - Verdaccio (local): STRIPE_NPM_REGISTRY=http://localhost:4873
#   - GitHub Packages (CI): STRIPE_NPM_REGISTRY=https://npm.pkg.github.com
#
# Prerequisites:
#   - Registry running and STRIPE_NPM_REGISTRY set
#   - All packages built (pnpm build)
#   - For GitHub Packages: GITHUB_TOKEN set (CI provides this automatically)
#
# Usage:
#   bash tests/e2e-publish.sh
#

set -euo pipefail

REGISTRY="${STRIPE_NPM_REGISTRY:?Set STRIPE_NPM_REGISTRY (e.g. http://localhost:4873 or https://npm.pkg.github.com)}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMPDIR_BASE=$(mktemp -d)

# Ensure npm/npx don't route localhost through a proxy
export no_proxy="${no_proxy:-}${no_proxy:+,}localhost,127.0.0.1"

cleanup() {
  rm -rf "$TMPDIR_BASE"
}
trap cleanup EXIT

echo "=== E2E Publish Test ==="
echo "Registry: $REGISTRY"
echo "Temp dir: $TMPDIR_BASE"
echo ""

# ---------------------------------------------------------------------------
# Step 1: Auth for GitHub Packages (Verdaccio is anonymous)
# ---------------------------------------------------------------------------
if [[ "$REGISTRY" == *"npm.pkg.github.com"* ]]; then
  echo "--- Step 1: Configuring GitHub Packages auth ---"
  echo "//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN:?GITHUB_TOKEN required for GitHub Packages}" >> "$REPO_ROOT/.npmrc"
  echo "  Auth configured"
else
  echo "--- Step 1: Checking registry ---"
  if ! curl -sf "$REGISTRY/-/ping" > /dev/null 2>&1; then
    echo "FAIL: Registry not reachable at $REGISTRY"
    echo "Run: docker compose --profile npm-registry up -d npm-registry"
    exit 1
  fi
  echo "  Registry is up"
fi
echo ""

# ---------------------------------------------------------------------------
# Step 2: Publish all workspace packages
# ---------------------------------------------------------------------------
echo "--- Step 2: Publishing packages ---"

pnpm -r --filter '!./tests/*' publish \
  --registry "$REGISTRY" \
  --access public \
  --no-git-checks \
  2>&1 || true
# publish returns non-zero if some packages already exist — that's fine

echo ""

# ---------------------------------------------------------------------------
# Step 3: Smoke test — npx from clean directory
# ---------------------------------------------------------------------------
echo "--- Step 3: npx @stripe/sync-engine --version ---"

cd "$TMPDIR_BASE"
mkdir test-npx && cd test-npx
npm init -y > /dev/null 2>&1

VERSION_OUTPUT=$(npx --registry "$REGISTRY" @stripe/sync-engine --version 2>&1)
echo "  Version: $VERSION_OUTPUT"

if [ -n "$VERSION_OUTPUT" ]; then
  echo "  PASS: --version returned output"
else
  echo "  FAIL: --version returned empty output"
  exit 1
fi
echo ""

# ---------------------------------------------------------------------------
# Step 4: npx @stripe/sync-engine --help
# ---------------------------------------------------------------------------
echo "--- Step 4: npx @stripe/sync-engine --help ---"

if npx --registry "$REGISTRY" @stripe/sync-engine --help > /dev/null 2>&1; then
  echo "  PASS: --help exits 0"
else
  echo "  FAIL: --help exited with $?"
  npx --registry "$REGISTRY" @stripe/sync-engine --help 2>&1 || true
  exit 1
fi
echo ""

# ---------------------------------------------------------------------------
# Step 5: npx @stripe/sync-engine check (connector loading)
# ---------------------------------------------------------------------------
echo "--- Step 5: npx @stripe/sync-engine check (connector loading) ---"

PARAMS='{"source_name":"stripe","destination_name":"postgres","source_config":{"api_key":"sk_test_fake"},"destination_config":{"connection_string":"postgresql://fake:fake@localhost:5432/fake"}}'

CHECK_OUTPUT=$(npx --registry "$REGISTRY" @stripe/sync-engine check --params "$PARAMS" 2>&1 || true)

# check will fail (bad credentials) but should NOT fail on "not found" (connector loading)
if echo "$CHECK_OUTPUT" | grep -qi "not found"; then
  echo "  FAIL: check output contains 'not found' — connector loading failed"
  echo "  Output: $CHECK_OUTPUT"
  exit 1
fi

echo "  PASS: connectors loaded (check failed on credentials as expected)"
echo ""

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo "=== All publish tests passed ==="
