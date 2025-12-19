#!/bin/bash

# Release script for creating GitHub releases with the built package tarball
# Usage: ./scripts/release-package.sh
# Creates a release tagged with v0.0.0-<commit-hash>

set -e

PACKAGE_DIR="packages/sync-engine"
TARBALL="$PACKAGE_DIR/supabase-stripe-sync-engine-0.0.0.tgz"

# Get short commit hash
COMMIT_HASH=$(git rev-parse --short HEAD)
VERSION="v0.0.0-$COMMIT_HASH"

echo "Creating release $VERSION..."

# Check if tarball exists
if [ ! -f "$TARBALL" ]; then
  echo "Error: Tarball not found at $TARBALL"
  echo "Run 'cd $PACKAGE_DIR && pnpm run build && pnpm pack' first"
  exit 1
fi

# Create GitHub release and upload tarball
gh release create "$VERSION" \
  "$TARBALL" \
  --title "$VERSION" \
  --notes "Release $VERSION with StripeSync support"

echo "✓ Release $VERSION created successfully"
echo ""
echo "To use in your project, add to package.json:"
echo "  \"@supabase/stripe-sync-engine\": \"https://github.com/stripe-experiments/sync-engine/releases/download/$VERSION/supabase-stripe-sync-engine-0.0.0.tgz\""
