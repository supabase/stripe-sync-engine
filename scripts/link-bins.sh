#!/usr/bin/env bash
# Link (or unlink) connector CLI bins globally so they work as commands and via npx.
#
# Usage:
#   pnpm run link       # symlink bins (requires pnpm build first)
#   pnpm run unlink     # remove symlinks
#
# This avoids `npm link` which chokes on pnpm's workspace:* protocol.
set -euo pipefail

BIN_DIR="$(npm config get prefix 2>/dev/null)/bin"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

# Map of bin-name → path-to-dist-entrypoint (relative to repo root)
declare -A BINS=(
  [source-stripe]="packages/source-stripe/dist/bin.js"
  [destination-postgres]="packages/destination-postgres/dist/bin.js"
  [destination-google-sheets]="packages/destination-google-sheets/dist/bin.js"
  [sync-engine]="apps/sync-engine/dist/cli.js"
  [sync-engine-stateless]="apps/stateless/dist/cli/index.js"
  [sync-engine-stateless-api]="apps/stateless/dist/api/index.js"
  [sync-engine-stateful]="apps/stateful/dist/cli/index.js"
  [sync-engine-stateful-api]="apps/stateful/dist/api/index.js"
)

if [ "${1:-}" = "--unlink" ]; then
  for name in "${!BINS[@]}"; do
    target="$BIN_DIR/$name"
    if [ -L "$target" ]; then
      rm "$target"
      echo "unlinked $name"
    fi
  done
else
  for name in "${!BINS[@]}"; do
    src="$REPO/${BINS[$name]}"
    if [ ! -f "$src" ]; then
      echo "skip $name (not built: ${BINS[$name]})" >&2
      continue
    fi
    chmod +x "$src"
    ln -sf "$src" "$BIN_DIR/$name"
    echo "linked $name → ${BINS[$name]}"
  done
fi
