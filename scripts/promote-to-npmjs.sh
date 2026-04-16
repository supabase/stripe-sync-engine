#!/usr/bin/env bash
#
# Promote @stripe/* packages from GitHub Packages to npmjs.org.
#
# No checkout needed — discovers packages via GitHub API, packs from
# GitHub Packages, and publishes tarballs to npmjs.org.
#
# Required env:
#   GITHUB_TOKEN       — for reading from GitHub Packages + API
#   NPM_TOKEN          — for publishing to npmjs.org
#   GITHUB_REPO_OWNER  — GitHub org (e.g. "stripe")
#   GITHUB_REPO_NAME   — repo name (e.g. "sync-engine")
# Optional env:
#   RELEASE_VERSION    — exact version to promote instead of the latest package
#
# Usage:
#   bash scripts/promote-to-npmjs.sh
#

set -euo pipefail

: "${GITHUB_TOKEN:?Required}"
: "${NPM_TOKEN:?Required}"
: "${GITHUB_REPO_OWNER:?Required}"
: "${GITHUB_REPO_NAME:?Required}"
RELEASE_VERSION="${RELEASE_VERSION:-}"

WORKDIR=$(mktemp -d)
cd "$WORKDIR"
trap 'rm -rf "$WORKDIR"' EXIT

# Auth for reading from GitHub Packages
echo "@stripe:registry=https://npm.pkg.github.com" > .npmrc
echo "//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}" >> .npmrc

# Discover @stripe/* packages from GitHub Packages API
echo "=== Discovering packages ==="
PACKAGES=$(curl -sf \
  -H "Authorization: Bearer ${GITHUB_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/orgs/${GITHUB_REPO_OWNER}/packages?package_type=npm&per_page=100" \
  | jq -r --arg repo "$GITHUB_REPO_NAME" --arg owner "$GITHUB_REPO_OWNER" \
    '.[] | select(.repository.name == $repo) | "@\($owner)/\(.name)"')

if [ -z "$PACKAGES" ]; then
  echo "FAIL: no packages found for ${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}"
  exit 1
fi

echo "$PACKAGES"
echo ""

# Pack each package from GitHub Packages
echo "=== Packing from GitHub Packages ==="
PACK_FAILURES=0
for pkg in $PACKAGES; do
  echo "--- $pkg ---"
  package_spec="$pkg"
  if [ -n "$RELEASE_VERSION" ]; then
    package_spec="${pkg}@${RELEASE_VERSION}"
  fi
  if ! npm pack "$package_spec" --registry https://npm.pkg.github.com 2>&1; then
    echo "WARNING: failed to pack $package_spec — skipping (stale or missing version)"
    PACK_FAILURES=$((PACK_FAILURES + 1))
  fi
done

# Switch .npmrc from GitHub Packages to npmjs.org for publishing.
# npm's scoped registry config (@stripe:registry) takes precedence over
# --registry, so we must point the scope at npmjs.org before publishing.
echo "@stripe:registry=https://registry.npmjs.org" > .npmrc
echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" >> .npmrc

# Publish all tarballs to npmjs.org
echo ""
echo "=== Publishing to npmjs.org ==="
ALREADY_PUBLISHED=0
TGZ_FILES=$(ls *.tgz 2>/dev/null || true)
if [ -z "$TGZ_FILES" ]; then
  echo "FAIL: no tarballs to publish (all packs failed)"
  exit 1
fi
PUBLISH_FAILURES=0
for tgz in $TGZ_FILES; do
  echo "Publishing $tgz"
  if PUBLISH_OUTPUT=$(npm publish "$tgz" \
    --registry https://registry.npmjs.org \
    --access public 2>&1); then
    echo "$PUBLISH_OUTPUT"
  else
    echo "$PUBLISH_OUTPUT"
    if echo "$PUBLISH_OUTPUT" | grep -Eqi 'Cannot publish over existing version|previously published versions|EPUBLISHCONFLICT'; then
      echo "WARNING: $tgz already exists on npmjs.org, skipping"
      ALREADY_PUBLISHED=$((ALREADY_PUBLISHED + 1))
    elif echo "$PUBLISH_OUTPUT" | grep -Eqi 'E404|Not Found|not have permission'; then
      echo "WARNING: $tgz not found or no permission on npmjs.org, skipping"
      PUBLISH_FAILURES=$((PUBLISH_FAILURES + 1))
    else
      echo "FAIL: npm publish failed for $tgz"
      PUBLISH_FAILURES=$((PUBLISH_FAILURES + 1))
    fi
  fi
done

if [ "$PUBLISH_FAILURES" -gt 0 ] && [ "$PUBLISH_FAILURES" -eq "$(echo "$TGZ_FILES" | wc -w)" ]; then
  echo "FAIL: all $PUBLISH_FAILURES publishes failed"
  exit 1
fi

echo ""
TOTAL_WARNINGS=$((ALREADY_PUBLISHED + PACK_FAILURES + PUBLISH_FAILURES))
if [ "$TOTAL_WARNINGS" -gt 0 ]; then
  echo "=== Done: $PACK_FAILURES pack-skips, $ALREADY_PUBLISHED already-published, $PUBLISH_FAILURES publish-failures ==="
else
  echo "=== Done ==="
fi
