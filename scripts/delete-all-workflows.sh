#!/usr/bin/env bash
# Delete all Temporal workflow executions and their event history.
# Running workflows are terminated first, then deleted.
#
# Usage:
#   ./scripts/delete-all-workflows.sh [--address localhost:7233] [--namespace default] [--reason "..."]
#
# Defaults: address=localhost:7233, namespace=default

set -euo pipefail

ADDRESS="localhost:7233"
NAMESPACE="default"
REASON="bulk delete via delete-all-workflows.sh"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --address)   ADDRESS="$2";   shift 2 ;;
    --namespace) NAMESPACE="$2"; shift 2 ;;
    --reason)    REASON="$2";    shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

echo "Deleting all workflows on $ADDRESS (namespace: $NAMESPACE)..."

temporal workflow delete \
  --address "$ADDRESS" \
  --namespace "$NAMESPACE" \
  --query 'WorkflowType!=""' \
  --reason "$REASON" \
  --yes
