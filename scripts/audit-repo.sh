#!/usr/bin/env bash
# Audit the repo for stale docs, tech debt, and architecture violations.
# Uses Claude Code CLI (`claude -p`) to analyze the codebase.
#
# Usage:
#   ./scripts/audit-repo.sh              # print report to stdout
#   ./scripts/audit-repo.sh --pr         # create a PR with fixes (if any)
set -euo pipefail

cd "$(dirname "$0")/.."

create_pr=false
if [[ "${1:-}" == "--pr" ]]; then
  create_pr=true
fi

# Check claude is available
if ! command -v claude &>/dev/null; then
  echo "Error: 'claude' CLI not found. Install: npm install -g @anthropic-ai/claude-code" >&2
  exit 1
fi

PROMPT='You are auditing the sync-engine repo. Read AGENTS.md first, then perform these checks:

## 1. Documentation accuracy
For each .md file in docs/, verify claims against actual code:
- Do referenced file paths still exist?
- Do described APIs/interfaces match current code signatures?
- Are package dependency descriptions in docs/architecture/packages.md accurate?
- Are the "Key Rules" in AGENTS.md still enforced?
Flag any stale or inaccurate docs with the file path and what is wrong.

## 2. Architecture violations
Run e2e/layers.test.ts mentally (or check the patterns it tests):
- Any source importing from a destination?
- Any destination importing from a source?
- Protocol importing workspace packages?
- Connectors depending on engine/service/state-postgres?

## 3. Dead code & unused exports
Check for:
- Exported functions/types with zero imports across the monorepo
- Files that are not imported by anything
- Packages listed in dependencies but never imported

## 4. Quality gaps
Check docs/architecture/quality.md scorecard:
- Are there packages that now have tests but the scorecard says "-"?
- Are there packages missing tests that should have them?

## 5. Convention drift
- Any Zod schemas using camelCase field names? (should be snake_case)
- Any new .ts files missing from tsconfig include patterns?
- OpenAPI specs in apps/{engine,service}/src/__generated__/openapi.json up to date?

## Output format
Output a markdown report with sections for each check.
For each finding, include:
- File path
- What is wrong
- Suggested fix (one line)

If there are fixable issues, fix them directly. If you made changes, end with a summary of files modified.
If everything looks good, say "No issues found." for that section.'

if $create_pr; then
  base_branch="$(git rev-parse --abbrev-ref HEAD)"
  branch="chore/audit-$(date +%Y%m%d)"
  git checkout -b "$branch" 2>/dev/null || git checkout "$branch"

  claude -p "$PROMPT

After making any fixes, stage and commit them with message 'chore: automated repo audit fixes'.
Do NOT push or create a PR — the calling script handles that."

  # Check if there are committed changes
  if git diff --quiet HEAD~1 HEAD 2>/dev/null; then
    echo "No fixes needed. Cleaning up branch."
    git checkout -
    git branch -D "$branch"
  else
    git push -u origin "$branch"
    gh pr create \
      --title "chore: automated repo audit $(date +%Y-%m-%d)" \
      --body "Automated audit found and fixed issues. See commit messages for details." \
      --base "$base_branch"
    echo "PR created."
  fi
else
  claude -p "$PROMPT

Do NOT make any changes. Only report findings."
fi
