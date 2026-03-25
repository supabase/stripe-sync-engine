#!/usr/bin/env bash
#
# E2E test: publish all packages to a local Verdaccio registry, then verify
# that `npx @stripe/sync-engine` works from a clean temp directory — exactly
# as an end-user would install and run the CLI.
#
# Prerequisites:
#   - npm-registry running on localhost:4873 (docker compose --profile npm-registry up -d npm-registry)
#   - All packages built (pnpm build)
#
# Usage:
#   bash tests/e2e-verdaccio-publish.sh
#

set -euo pipefail

# Ensure npm/npx don't route localhost through a proxy
export no_proxy="${no_proxy:-}${no_proxy:+,}localhost,127.0.0.1"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REGISTRY="http://localhost:4873"
TMPDIR_BASE=$(mktemp -d)

cleanup() {
  rm -rf "$TMPDIR_BASE"
}
trap cleanup EXIT

echo "=== E2E Verdaccio Publish Test ==="
echo "Registry: $REGISTRY"
echo "Temp dir: $TMPDIR_BASE"
echo ""

# ---------------------------------------------------------------------------
# Step 1: Verify Verdaccio is running
# ---------------------------------------------------------------------------
echo "--- Step 1: Checking Verdaccio ---"

if ! curl -sf "$REGISTRY/-/ping" > /dev/null 2>&1; then
  echo "FAIL: Verdaccio not reachable at $REGISTRY"
  echo "Run: docker compose --profile npm-registry up -d npm-registry"
  exit 1
fi
echo "  Verdaccio is up"
echo ""

# ---------------------------------------------------------------------------
# Step 2: Publish all workspace packages to Verdaccio
# ---------------------------------------------------------------------------
echo "--- Step 2: Publishing packages to Verdaccio ---"

publish_package() {
  local pkg_dir="$1"
  local pkg_json="$pkg_dir/package.json"

  local name version
  name=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$pkg_json')).name)")
  version=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$pkg_json')).version)")

  if [ "$version" = "undefined" ]; then
    echo "  SKIP: $name (no version)"
    return 0
  fi

  # Check if already published (idempotent reruns)
  local status_code
  status_code=$(curl -s -o /dev/null -w "%{http_code}" "$REGISTRY/$name/$version")
  if [ "$status_code" = "200" ]; then
    echo "  SKIP: $name@$version (already published)"
    return 0
  fi

  # Create a staging dir with workspace:* rewritten to real versions
  local stage_dir
  stage_dir=$(mktemp -d)
  cp -r "$pkg_dir"/* "$stage_dir/" 2>/dev/null || true
  cp "$pkg_dir"/.* "$stage_dir/" 2>/dev/null || true

  # Rewrite workspace:* → real versions in the staged package.json
  node -e "
    const fs = require('fs');
    const path = require('path');
    const pkg = JSON.parse(fs.readFileSync('$stage_dir/package.json'));
    const repoRoot = '$REPO_ROOT';

    // Build a map of workspace package name → version
    const versions = {};
    const dirs = [
      ...fs.readdirSync(path.join(repoRoot, 'packages')).map(d => path.join(repoRoot, 'packages', d)),
      ...fs.readdirSync(path.join(repoRoot, 'apps')).map(d => path.join(repoRoot, 'apps', d)),
    ];
    for (const dir of dirs) {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json')));
        if (p.name && p.version) versions[p.name] = p.version;
      } catch {}
    }

    // Rewrite workspace:* in dependencies and devDependencies
    for (const depType of ['dependencies', 'devDependencies', 'peerDependencies']) {
      if (!pkg[depType]) continue;
      for (const [dep, ver] of Object.entries(pkg[depType])) {
        if (typeof ver === 'string' && ver.startsWith('workspace:')) {
          pkg[depType][dep] = versions[dep] || '0.1.0';
        }
      }
    }

    // Apply publishConfig overrides (exports, bin, main, etc.)
    if (pkg.publishConfig) {
      for (const [key, val] of Object.entries(pkg.publishConfig)) {
        pkg[key] = val;
      }
      delete pkg.publishConfig;
    }

    fs.writeFileSync('$stage_dir/package.json', JSON.stringify(pkg, null, 2) + '\n');
  "

  # Pack from staged dir
  local tgz
  tgz=$(cd "$stage_dir" && npm pack --pack-destination "$stage_dir" 2>/dev/null | tail -1)
  local tgz_path="$stage_dir/$tgz"

  if [ ! -f "$tgz_path" ]; then
    echo "  FAIL: npm pack failed for $name"
    rm -rf "$stage_dir"
    return 1
  fi

  # Publish via Verdaccio REST API (avoids npm auth/interactive prompts)
  local result
  result=$(node -e "
    const fs = require('fs'), crypto = require('crypto'), http = require('http');
    const tarball = fs.readFileSync('$tgz_path');
    const pkg = JSON.parse(fs.readFileSync('$stage_dir/package.json'));
    const b64 = tarball.toString('base64');
    const tgzName = pkg.name.replace('@','').replace('/','-') + '-' + pkg.version + '.tgz';
    const payload = JSON.stringify({
      _id: pkg.name, name: pkg.name,
      'dist-tags': { latest: pkg.version },
      versions: { [pkg.version]: { ...pkg, dist: {
        tarball: '$REGISTRY/' + pkg.name + '/-/' + tgzName,
        shasum: crypto.createHash('sha1').update(tarball).digest('hex')
      }}},
      _attachments: { [tgzName]: {
        content_type: 'application/octet-stream', data: b64, length: tarball.length
      }}
    });
    const url = new URL('$REGISTRY/' + encodeURIComponent(pkg.name).replace('%40','@'));
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname, method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log('OK');
        } else {
          console.log('FAIL:' + res.statusCode + ':' + body);
        }
      });
    });
    req.write(payload);
    req.end();
  ")

  rm -rf "$stage_dir"

  if [ "$result" = "OK" ]; then
    echo "  OK: $name@$version"
  else
    echo "  FAIL: $name@$version → $result"
    return 1
  fi
}

# Publish in dependency order
PACKAGES=(
  # Layer 0: no internal deps
  packages/protocol
  packages/util-postgres
  packages/ts-cli
  # Layer 1: depends on protocol/util-postgres
  packages/source-stripe
  packages/destination-postgres
  packages/destination-google-sheets
  packages/store-postgres
  # Layer 2
  packages/stateless-sync
  # Layer 3
  packages/stateful-sync
  # Layer 4: apps
  apps/stateless
  apps/stateful
  apps/supabase
  apps/sync-engine
)

for pkg in "${PACKAGES[@]}"; do
  publish_package "$REPO_ROOT/$pkg"
done
echo ""

# ---------------------------------------------------------------------------
# Step 3: npx @stripe/sync-engine --help from a clean directory
# ---------------------------------------------------------------------------
echo "--- Step 3: npx @stripe/sync-engine --help ---"

cd "$TMPDIR_BASE"
mkdir test-npx && cd test-npx
npm init -y > /dev/null 2>&1

if npx --registry "$REGISTRY" @stripe/sync-engine --help > /dev/null 2>&1; then
  echo "  PASS: npx @stripe/sync-engine --help exits 0"
else
  echo "  FAIL: npx @stripe/sync-engine --help exited with $?"
  echo "  Trying again with verbose output:"
  npx --registry "$REGISTRY" @stripe/sync-engine --help 2>&1 || true
  exit 1
fi
echo ""

# ---------------------------------------------------------------------------
# Step 4: npx @stripe/sync-engine --version
# ---------------------------------------------------------------------------
echo "--- Step 4: npx @stripe/sync-engine --version ---"

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
echo "=== All Verdaccio publish tests passed ==="
