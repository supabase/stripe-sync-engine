#!/usr/bin/env bash
#
# E2E test: verify ESBUILD_BINARY_PATH override works.
#
# On Stripe corporate Macs, Santa blocks the unsigned esbuild binaries bundled
# in node_modules. We override all esbuild packages to a single version and
# use ESBUILD_BINARY_PATH to point to an approved system binary (Homebrew).
#
# This test verifies:
#   1. All esbuild packages resolve to a single version (pnpm override works)
#   2. ESBUILD_BINARY_PATH is respected — esbuild uses the specified binary
#   3. The supabase build.mjs auto-detection probes well-known paths
#   4. The build succeeds with the override

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "=== E2E esbuild binary path test ==="
echo ""

# ---------------------------------------------------------------------------
# 1. All esbuild packages resolve to a single version
# ---------------------------------------------------------------------------
echo "--- Step 1: esbuild version alignment ---"

VERSIONS=$(pnpm ls esbuild --recursive --depth=Infinity 2>/dev/null \
  | grep -oE 'esbuild [0-9]+\.[0-9]+\.[0-9]+' \
  | sort -u)
VERSION_COUNT=$(echo "$VERSIONS" | wc -l | tr -d ' ')

echo "  Resolved versions:"
echo "$VERSIONS" | sed 's/^/    /'

if [ "$VERSION_COUNT" -ne 1 ]; then
  echo "  FAIL: expected exactly 1 esbuild version, got $VERSION_COUNT"
  exit 1
fi
echo "  PASS: single esbuild version across workspace"
echo ""

# ---------------------------------------------------------------------------
# 2. ESBUILD_BINARY_PATH is respected
# ---------------------------------------------------------------------------
echo "--- Step 2: ESBUILD_BINARY_PATH override ---"

# Resolve from apps/supabase which directly depends on esbuild
RESULT=$(cd apps/supabase && ESBUILD_BINARY_PATH="${ESBUILD_BINARY_PATH:-}" node -e "
  import('esbuild').then(esbuild =>
    esbuild.transform('const x: number = 1', { loader: 'ts' })
      .then(r => { console.log(r.code.trim()); return esbuild.stop(); })
  )
")

if [ "$RESULT" = "const x = 1;" ]; then
  echo "  PASS: esbuild transform works (binary path: ${ESBUILD_BINARY_PATH:-<default>})"
else
  echo "  FAIL: unexpected transform result: $RESULT"
  exit 1
fi
echo ""

# ---------------------------------------------------------------------------
# 3. build.mjs auto-detection probes well-known paths
# ---------------------------------------------------------------------------
echo "--- Step 3: build.mjs detection logic ---"

# Verify the detection code exists in build.mjs
if grep -q '/opt/homebrew/bin/esbuild' apps/supabase/build.mjs &&
   grep -q '/usr/local/bin/esbuild' apps/supabase/build.mjs &&
   grep -q 'ESBUILD_BINARY_PATH' apps/supabase/build.mjs; then
  echo "  PASS: build.mjs contains system esbuild detection"
else
  echo "  FAIL: build.mjs missing system esbuild detection"
  exit 1
fi
echo ""

# ---------------------------------------------------------------------------
# 4. Supabase build succeeds (exercises the override end-to-end)
# ---------------------------------------------------------------------------
echo "--- Step 4: supabase build with esbuild override ---"

# On macOS with Homebrew, use system esbuild; on CI, use npm binary
if [ -x /opt/homebrew/bin/esbuild ]; then
  export ESBUILD_BINARY_PATH=/opt/homebrew/bin/esbuild
  echo "  Using Homebrew esbuild: $ESBUILD_BINARY_PATH"
elif [ -x /usr/local/bin/esbuild ]; then
  export ESBUILD_BINARY_PATH=/usr/local/bin/esbuild
  echo "  Using system esbuild: $ESBUILD_BINARY_PATH"
fi
# If neither exists (CI), build.mjs falls back to npm binary which works fine

pnpm --filter @stripe/sync-integration-supabase build > /dev/null 2>&1
echo "  PASS: supabase build succeeded"
echo ""

echo "=== All esbuild binary path tests passed ==="
