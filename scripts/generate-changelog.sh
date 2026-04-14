#!/usr/bin/env bash
# Generate a changelog entry for a new version using Claude Code CLI.
#
# Usage:
#   ./scripts/generate-changelog.sh <prev-version> <new-version>
#
# Requires: claude CLI (npm install -g @anthropic-ai/claude-code)
# Requires: ANTHROPIC_API_KEY environment variable

set -euo pipefail

PREV_VERSION="${1:?Usage: generate-changelog.sh <prev-version> <new-version>}"
NEW_VERSION="${2:?Usage: generate-changelog.sh <prev-version> <new-version>}"
CHANGELOG="$(dirname "$0")/../CHANGELOG.md"
DATE=$(date +%Y-%m-%d)

if ! command -v claude &>/dev/null; then
  echo "Error: 'claude' CLI not found. Install: npm install -g @anthropic-ai/claude-code" >&2
  exit 1
fi

# Gather commits since last version tag
if git rev-parse "v${PREV_VERSION}" &>/dev/null; then
  GIT_LOG=$(git log "v${PREV_VERSION}..HEAD" --oneline --no-merges)
else
  echo "Warning: tag v${PREV_VERSION} not found, using last 50 commits" >&2
  GIT_LOG=$(git log --oneline --no-merges -50)
fi

if [ -z "$GIT_LOG" ]; then
  echo "No commits found since v${PREV_VERSION}. Skipping changelog." >&2
  exit 0
fi

PROMPT="You are generating a changelog entry for sync-engine v${NEW_VERSION} (released ${DATE}).

Here are the commits since v${PREV_VERSION}:

${GIT_LOG}

Generate a concise changelog entry in this exact markdown format:

## v${NEW_VERSION} (${DATE})

### Features
- ...

### Bug Fixes
- ...

### Breaking Changes
- ...

Rules:
- Only include sections that have entries (omit empty sections entirely)
- Each bullet should be one line summarizing the change for an end user
- Reference PR numbers from commit messages when available (e.g. #123)
- Do not include CI-only changes, merge commits, or trivial refactors
- Be concise — one sentence per change
- Output ONLY the markdown, no preamble or explanation"

ENTRY=$(claude -p "$PROMPT")

# Prepend entry to CHANGELOG.md
if [ -f "$CHANGELOG" ]; then
  # Insert after the first line (header)
  HEADER=$(head -n 2 "$CHANGELOG")
  BODY=$(tail -n +3 "$CHANGELOG")
  printf '%s\n\n%s\n%s\n' "$HEADER" "$ENTRY" "$BODY" > "$CHANGELOG"
else
  printf '# Changelog\n\n%s\n' "$ENTRY" > "$CHANGELOG"
fi

echo "Changelog entry for v${NEW_VERSION} written to CHANGELOG.md"
