#!/usr/bin/env bash
# Bump the monorepo-wide version, generate a changelog, commit, and tag.
#
# Usage:
#   ./scripts/bump-version.sh major|minor|patch [flags]
#
# Flags:
#   --no-changelog  Skip changelog generation
#   --no-commit     Only modify files, don't commit or tag
#   --dry-run       Print what would change, modify nothing
#
# Requires: jq, claude CLI (for changelog)

set -euo pipefail

cd "$(dirname "$0")/.."

# --- Parse arguments ---
BUMP_TYPE=""
NO_CHANGELOG=false
NO_COMMIT=false
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    major|minor|patch) BUMP_TYPE="$arg" ;;
    --no-changelog) NO_CHANGELOG=true ;;
    --no-commit) NO_COMMIT=true ;;
    --dry-run) DRY_RUN=true ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

if [ -z "$BUMP_TYPE" ]; then
  echo "Usage: bump-version.sh major|minor|patch [--no-changelog] [--no-commit] [--dry-run]" >&2
  exit 1
fi

# --- Check dependencies ---
if ! command -v jq &>/dev/null; then
  echo "Error: 'jq' not found. Install it first." >&2
  exit 1
fi

if [ "$NO_CHANGELOG" = false ] && ! command -v claude &>/dev/null; then
  echo "Error: 'claude' CLI not found. Install: npm install -g @anthropic-ai/claude-code" >&2
  echo "Or pass --no-changelog to skip changelog generation." >&2
  exit 1
fi

# --- Compute new version ---
CURRENT=$(jq -r .version apps/engine/package.json)
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

case "$BUMP_TYPE" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac

NEW="${MAJOR}.${MINOR}.${PATCH}"

echo "Bumping version: ${CURRENT} -> ${NEW} (${BUMP_TYPE})"

# --- Find all package.json files ---
PACKAGE_FILES=$(find . -name package.json \
  -not -path '*/node_modules/*' \
  -not -path '*/.worktrees/*' \
  -not -path '*/.next/*' \
  -not -path '*/docs/*' \
  -maxdepth 3 \
  | sort)

if $DRY_RUN; then
  echo ""
  echo "Would update these files:"
  for f in $PACKAGE_FILES; do
    echo "  $f"
  done
  echo ""
  echo "Would create tag: v${NEW}"
  if [ "$NO_CHANGELOG" = false ]; then
    echo "Would generate changelog entry for v${NEW}"
  fi
  exit 0
fi

# --- Check for existing tag ---
if git rev-parse "v${NEW}" &>/dev/null; then
  echo "Error: tag v${NEW} already exists." >&2
  exit 1
fi

# --- Update all package.json files ---
for f in $PACKAGE_FILES; do
  jq --arg v "$NEW" '.version = $v' "$f" > "${f}.tmp" && mv "${f}.tmp" "$f"
done

echo "Updated $(echo "$PACKAGE_FILES" | wc -l | tr -d ' ') package.json files"

# --- Sync lockfile ---
pnpm install --lockfile-only 2>/dev/null || true

# --- Generate changelog ---
if [ "$NO_CHANGELOG" = false ]; then
  ./scripts/generate-changelog.sh "$CURRENT" "$NEW"
fi

# --- Commit and tag ---
if [ "$NO_COMMIT" = false ]; then
  git add -A
  git commit -m "release: v${NEW}"
  git tag "v${NEW}"
  echo ""
  echo "Created v${NEW}. Push with: git push --follow-tags"
else
  echo ""
  echo "Files updated. Commit and tag manually when ready."
fi
