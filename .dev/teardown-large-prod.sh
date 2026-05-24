#!/usr/bin/env bash
set -euo pipefail
CLUSTER_NAME="kubeatlas-test-large-prod"
if kwokctl get clusters 2>/dev/null | grep -qx "${CLUSTER_NAME}"; then
  echo "🧹 Deleting kwok cluster ${CLUSTER_NAME}..."
  kwokctl delete cluster --name "${CLUSTER_NAME}"
else
  echo "✅ Cluster ${CLUSTER_NAME} not found — nothing to do"
fi
