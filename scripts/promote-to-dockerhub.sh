#!/usr/bin/env bash
#
# Promote Docker image from ghcr.io to Docker Hub.
#
# Required env:
#   GHCR_IMAGE — full ghcr.io image:tag to promote (e.g. ghcr.io/stripe/sync-engine:abc123)
# Optional env:
#   DOCKERHUB_TAGS — extra Docker Hub tags to publish in addition to the sha tag
#                    (space/comma/newline separated, e.g. "latest" or "v2 latest")
#
# Assumes `docker login` already done for both ghcr.io and Docker Hub.
#
# Usage:
#   bash scripts/promote-to-dockerhub.sh
#

set -euo pipefail

: "${GHCR_IMAGE:?Required (e.g. ghcr.io/stripe/sync-engine:abc123)}"

# Extract tag from image (everything after the last colon)
TAG="${GHCR_IMAGE##*:}"
DOCKERHUB_TAGS="${DOCKERHUB_TAGS:-latest}"

target_tags=("$TAG")

add_target_tag() {
  local candidate="$1"
  local existing_tag

  if [[ -z "$candidate" ]]; then
    return
  fi

  for existing_tag in "${target_tags[@]}"; do
    if [[ "$existing_tag" == "$candidate" ]]; then
      return
    fi
  done

  target_tags+=("$candidate")
}

normalized_tags="$(printf '%s' "$DOCKERHUB_TAGS" | tr ',\n' '  ')"
for extra_tag in $normalized_tags; do
  add_target_tag "$extra_tag"
done

echo "=== Promoting Docker image ==="
echo "Source: $GHCR_IMAGE"
printf 'Targets:\n'
for target_tag in "${target_tags[@]}"; do
  echo "  - stripe/sync-engine:$target_tag"
done
echo ""

# Use buildx imagetools to copy the multi-arch manifest directly
# (no need to pull/retag — works across registries without downloading layers)
create_args=()
for target_tag in "${target_tags[@]}"; do
  create_args+=(--tag "stripe/sync-engine:$target_tag")
done

docker buildx imagetools create \
  "${create_args[@]}" \
  "$GHCR_IMAGE"

echo ""
echo "=== Done ==="
