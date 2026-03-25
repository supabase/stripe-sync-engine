#!/usr/bin/env bash
#
# Promote Docker image from ghcr.io to Docker Hub.
#
# Required env:
#   GHCR_IMAGE — full ghcr.io image:tag to promote (e.g. ghcr.io/stripe/sync-engine:abc123)
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

echo "=== Promoting Docker image ==="
echo "Source: $GHCR_IMAGE"
echo "Target: stripe/sync-engine:$TAG + stripe/sync-engine:latest"
echo ""

docker pull "$GHCR_IMAGE"
docker tag "$GHCR_IMAGE" "stripe/sync-engine:$TAG"
docker tag "$GHCR_IMAGE" "stripe/sync-engine:latest"
docker push "stripe/sync-engine:$TAG"
docker push "stripe/sync-engine:latest"

echo ""
echo "=== Done ==="
