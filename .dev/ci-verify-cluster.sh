#!/usr/bin/env bash
# CI helper: wait until a seeded kwok cluster has at least <min-pods> pod
# objects, then assert it. Polls (controllers create pods asynchronously, and
# that warmup is slower on CI runners than locally) and fails the job on a
# zero/under-count cluster — unlike a bare `grep && echo`, whose failure is
# swallowed by `set -e` in an && list.
#
# Usage: ci-verify-cluster.sh <kube-context> <min-pods>
set -euo pipefail

ctx="$1"
min="$2"
n=0

for _ in $(seq 1 30); do
  n=$(kubectl --context "$ctx" get pods -A --no-headers 2>/dev/null | wc -l | tr -d ' ')
  [ "${n:-0}" -ge "$min" ] && break
  sleep 2
done

if [ "${n:-0}" -lt "$min" ]; then
  echo "✗ ${ctx}: expected >= ${min} pods, got ${n}"
  kubectl --context "$ctx" get pods -A || true
  exit 1
fi

echo "✓ ${ctx} has ${n} pods"
