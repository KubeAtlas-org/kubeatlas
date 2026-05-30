#!/usr/bin/env bash
# Provisions kubeatlas-test-large-incident: a small kwok cluster deliberately
# broken in one clearly-named way per failure mode. Every bad state is pinned
# by a kwok Stage (see kwok/incident-stages.yaml) keyed off a label, so it is
# deterministic and will NOT self-heal mid-demo — point at the red, it stays
# red. ~6 nodes (1 NotReady), ~28 pods. The diagnostic-story demo driver.
# Idempotent.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLUSTER_NAME="kubeatlas-test-large-incident"
KWOK_CONTEXT="kwok-${CLUSTER_NAME}"

command -v kwokctl >/dev/null 2>&1 || {
  echo "💥 kwokctl not installed. Run: GOBIN=\$HOME/.local/bin go install sigs.k8s.io/kwok/cmd/{kwokctl,kwok}@latest"
  exit 1
}

if kwokctl get clusters 2>/dev/null | grep -qx "${CLUSTER_NAME}"; then
  echo "✅ ${CLUSTER_NAME} already exists"
else
  echo "🏗  Creating kwok cluster ${CLUSTER_NAME}..."
  # Stages + usage + metric all passed as startup config (-c). Supplying Pod
  # AND Node stages here means kwok uses ONLY ours (defaults replaced) — that
  # is what lets a node stay NotReady and pods stay broken deterministically.
  # --kube-admission=false: kwok creates per-namespace default ServiceAccounts
  # asynchronously, so the ServiceAccount admission plugin would reject pods
  # applied in the same batch as their namespace. This is a fake cluster, so
  # turning admission off is both safe and deterministic.
  kwokctl create cluster --name "${CLUSTER_NAME}" \
    --kube-admission=false \
    --enable metrics-server \
    -c "${SCRIPT_DIR}/kwok/metrics-resource.yaml" \
    -c "${SCRIPT_DIR}/kwok/incident-usage.yaml" \
    -c "${SCRIPT_DIR}/kwok/incident-stages.yaml"
fi

if kubectl config get-contexts -o name 2>/dev/null | grep -qx "${KWOK_CONTEXT}"; then
  kubectl config delete-context "${CLUSTER_NAME}" >/dev/null 2>&1 || true
  kubectl config rename-context "${KWOK_CONTEXT}" "${CLUSTER_NAME}" >/dev/null
fi
kubectl config use-context "${CLUSTER_NAME}" >/dev/null

# ----------------------------------------------------------------------------
# Nodes: 5 healthy + 1 pinned NotReady. The bad node carries
# incident.kubeatlas/node so the node-healthy stage skips it and its pre-baked
# NotReady condition is never overwritten.
# ----------------------------------------------------------------------------
echo "🌳 Creating 6 nodes (1 NotReady)..."
{
  for i in 1 2 3 4 5; do
    cat <<YAML
apiVersion: v1
kind: Node
metadata:
  name: node-$(printf '%02d' "$i")
  annotations:
    node.alpha.kubernetes.io/ttl: "0"
    kwok.x-k8s.io/node: fake
    metrics.k8s.io/resource-metrics-path: "/metrics/nodes/node-$(printf '%02d' "$i")/metrics/resource"
  labels:
    type: kwok
    kubernetes.io/hostname: node-$(printf '%02d' "$i")
    node.kubernetes.io/instance-type: m5.xlarge
spec:
  taints: [{ effect: NoSchedule, key: kwok.x-k8s.io/node, value: fake }]
status:
  allocatable: { cpu: "4", memory: 16Gi, pods: "110" }
  capacity:    { cpu: "4", memory: 16Gi, pods: "110" }
  nodeInfo: { kubeletVersion: fake-1.33.0 }
---
YAML
  done
  # The down node — labelled so node-healthy skips it; NotReady pre-baked.
  cat <<YAML
apiVersion: v1
kind: Node
metadata:
  name: node-bad-01
  annotations:
    node.alpha.kubernetes.io/ttl: "0"
    kwok.x-k8s.io/node: fake
  labels:
    type: kwok
    kubernetes.io/hostname: node-bad-01
    node.kubernetes.io/instance-type: m5.xlarge
    incident.kubeatlas/node: down
spec:
  taints:
    - { effect: NoSchedule, key: kwok.x-k8s.io/node, value: fake }
    - { effect: NoExecute, key: node.kubernetes.io/not-ready }
status:
  allocatable: { cpu: "4", memory: 16Gi, pods: "110" }
  capacity:    { cpu: "4", memory: 16Gi, pods: "110" }
  conditions:
    - type: Ready
      status: "Unknown"
      reason: NodeStatusUnknown
      message: "Kubelet stopped posting node status."
  nodeInfo: { kubeletVersion: fake-1.33.0 }
---
YAML
} | kubectl apply -f - >/dev/null

# ----------------------------------------------------------------------------
# Workloads. The incident.kubeatlas/state pod label selects the matching kwok
# Stage. No label = healthy (green baseline, for contrast).
# ----------------------------------------------------------------------------
FAKE_TOL='{ effect: NoSchedule, key: kwok.x-k8s.io/node, value: fake }'

# $1 ns  $2 name  $3 replicas  $4 state-label("" = healthy)  $5 nodeSelector-yaml("")
emit_deploy() {
  local ns="$1" name="$2" rep="$3" state="${4:-}" nsel="${5:-}"
  cat <<YAML
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  namespace: ${ns}
  labels: { app: ${name} }
spec:
  replicas: ${rep}
  selector: { matchLabels: { app: ${name} } }
  template:
    metadata:
      labels:
        app: ${name}
$( [ -n "${state}" ] && echo "        incident.kubeatlas/state: ${state}" )
    spec:
      tolerations: [ ${FAKE_TOL} ]
$( [ -n "${nsel}" ] && echo "      nodeSelector: { ${nsel} }" )
      containers:
        - name: ${name}
          image: ghcr.io/acme/${name}:2.3.1
          resources: { requests: { cpu: 100m, memory: 128Mi }, limits: { cpu: 500m, memory: 256Mi } }
---
apiVersion: v1
kind: Service
metadata: { name: ${name}, namespace: ${ns} }
spec:
  selector: { app: ${name} }
  ports: [{ port: 80, targetPort: 8080 }]
YAML
}

echo "🚀 Creating namespaces + workloads (healthy baseline + 1 of each failure)..."
{
  for NS in shop data batch; do
    echo "---"; echo "apiVersion: v1"; echo "kind: Namespace"; echo "metadata: { name: ${NS} }"
  done

  # Healthy baseline (green) — the contrast that makes the red obvious.
  emit_deploy shop web 6
  emit_deploy shop catalog 3
  emit_deploy data api-gateway 4

  # One workload per failure mode.
  emit_deploy shop checkout-api 4 crashloop
  emit_deploy shop recommendations 3 oom
  emit_deploy data cache 2 imagepull
  emit_deploy data report-builder 3 pending "disktype: nvme-nonexistent"

  # Failed Job + healthy CronJob (Completed runs) for batch contrast.
  cat <<YAML
---
apiVersion: batch/v1
kind: Job
metadata: { name: nightly-export, namespace: batch }
spec:
  # backoffLimit 0 → exactly one failed pod, Job marked Failed and stays put.
  # (A higher limit makes the controller spawn fresh failures on a timer,
  # which slowly accumulates Error pods mid-demo.)
  backoffLimit: 0
  template:
    metadata: { labels: { app: nightly-export, incident.kubeatlas/state: failedjob } }
    spec:
      restartPolicy: Never
      tolerations: [ ${FAKE_TOL} ]
      containers:
        - name: export
          image: ghcr.io/acme/exporter:1.2.0
          command: ["sh","-c","exit 1"]
          resources: { requests: { cpu: 100m, memory: 128Mi } }
---
apiVersion: batch/v1
kind: Job
metadata: { name: metrics-rollup, namespace: batch }
spec:
  template:
    metadata: { labels: { app: metrics-rollup, incident.kubeatlas/state: completed } }
    spec:
      restartPolicy: Never
      tolerations: [ ${FAKE_TOL} ]
      containers:
        - name: rollup
          image: ghcr.io/acme/rollup:1.0.0
          command: ["sh","-c","echo done"]
          resources: { requests: { cpu: 100m, memory: 128Mi } }
---
# Standalone pod pinned in Terminating (finalizer + delete below).
apiVersion: v1
kind: Pod
metadata:
  name: legacy-batch-runner
  namespace: shop
  labels: { app: legacy-batch-runner, incident.kubeatlas/state: terminating }
  finalizers: [kubeatlas.io/demo-stuck]
spec:
  tolerations: [ ${FAKE_TOL} ]
  containers:
    - name: runner
      image: ghcr.io/acme/legacy:0.9.0
      resources: { requests: { cpu: 100m, memory: 128Mi } }
YAML
} | kubectl apply -f - >/dev/null

echo "⏳ Letting kwok settle the states..."
sleep 6

# Trip the stuck-Terminating pod: it's Running via pod-terminating-pre; delete
# it (no --wait) — the finalizer keeps it visible in Terminating forever, with
# no delete stage to ever remove it.
kubectl delete pod legacy-batch-runner -n shop --wait=false >/dev/null 2>&1 || true

sleep 3
echo "✅ ${CLUSTER_NAME} ready — state breakdown:"
kubectl get pods -A --no-headers 2>/dev/null \
  | awk '{print $4}' | sort | uniq -c | sort -rn | sed 's/^/   /'
echo "   1 NotReady node (node-bad-01) — kubectl get nodes"
echo "   kubectl config use-context ${CLUSTER_NAME} && make run"
