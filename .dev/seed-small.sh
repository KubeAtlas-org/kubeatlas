#!/usr/bin/env bash
# Provisions kubeatlas-test-small: a minimal kwok cluster — just enough real
# resources to exercise the UI without the weight of the prod/incident seeds.
# Stable (kwok's default stage pins pods Running), safe to drive live.
#
# This is the lightweight driver. For a realistic mid-size cluster use
# seed-large-prod.sh; for the broken-cluster diagnostic story use
# seed-large-incident.sh.
#
# ~2 nodes, ~7 pods (2 Deployments + 1 DaemonSet), 1 namespace. Idempotent.
set -euo pipefail

CLUSTER_NAME="kubeatlas-test-small"
KWOK_CONTEXT="kwok-${CLUSTER_NAME}"

command -v kwokctl >/dev/null 2>&1 || {
  echo "💥 kwokctl not installed. Run: GOBIN=\$HOME/.local/bin go install sigs.k8s.io/kwok/cmd/{kwokctl,kwok}@latest"
  exit 1
}

if kwokctl get clusters 2>/dev/null | grep -qx "${CLUSTER_NAME}"; then
  echo "✅ ${CLUSTER_NAME} already exists"
else
  echo "🏗  Creating kwok cluster ${CLUSTER_NAME}..."
  # --extra-args advertise-address: kube-apiserver normally auto-detects its
  # advertise address by reading /proc/net/route. In restricted environments
  # (e.g. a PRoot/Android sandbox) that read is denied and the apiserver exits
  # on startup. Pinning it to loopback is harmless everywhere else — a local
  # kwok cluster is only ever reached at 127.0.0.1 via its kubeconfig.
  kwokctl create cluster --name "${CLUSTER_NAME}" --runtime binary \
    --extra-args kube-apiserver=advertise-address=127.0.0.1
fi

if kubectl config get-contexts -o name 2>/dev/null | grep -qx "${KWOK_CONTEXT}"; then
  kubectl config delete-context "${CLUSTER_NAME}" >/dev/null 2>&1 || true
  kubectl config rename-context "${KWOK_CONTEXT}" "${CLUSTER_NAME}" >/dev/null
fi
kubectl config use-context "${CLUSTER_NAME}" >/dev/null

# Blanket toleration so the real scheduler binds pods onto kwok fake nodes.
FAKE_TOL='{ effect: NoSchedule, key: kwok.x-k8s.io/node, value: fake }'
ALL_TOL='{ operator: Exists }'  # DaemonSet tolerates everything

emit_node() {
  # $1 name  $2 cpu  $3 memGi  $4 zone
  cat <<YAML
apiVersion: v1
kind: Node
metadata:
  name: $1
  annotations: { node.alpha.kubernetes.io/ttl: "0", kwok.x-k8s.io/node: fake }
  labels:
    type: kwok
    kubernetes.io/hostname: $1
    kubernetes.io/os: linux
    kubernetes.io/arch: arm64
    node.kubernetes.io/instance-type: kwok.small
    topology.kubernetes.io/zone: $4
    node.kubernetes.io/role: worker
spec:
  taints:
    - { effect: NoSchedule, key: kwok.x-k8s.io/node, value: fake }
status:
  # No conditions/addresses — kwok's node-initialize stage only fires on nodes
  # that are not yet Ready, and it wires the InternalIP for us.
  allocatable: { cpu: "$2", memory: $3Gi, pods: "110" }
  capacity:    { cpu: "$2", memory: $3Gi, pods: "110" }
  nodeInfo:
    kubeletVersion: fake-1.33.0
    osImage: "Flatcar Container Linux 3975.2.0"
    containerRuntimeVersion: "containerd://1.7.20"
---
YAML
}

# A stateless app: ConfigMap + Deployment + Service.
emit_app() {
  # $1 ns  $2 name  $3 replicas
  cat <<YAML
---
apiVersion: v1
kind: ConfigMap
metadata: { name: $2-config, namespace: $1, labels: { app: $2 } }
data: { LOG_LEVEL: info }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: $2, namespace: $1, labels: { app: $2 } }
spec:
  replicas: $3
  selector: { matchLabels: { app: $2 } }
  template:
    metadata: { labels: { app: $2 } }
    spec:
      tolerations: [ ${FAKE_TOL} ]
      containers:
        - name: $2
          image: ghcr.io/acme/$2:1.0.0
          ports: [{ containerPort: 8080 }]
          envFrom: [{ configMapRef: { name: $2-config } }]
          resources:
            requests: { cpu: 100m, memory: 128Mi }
            limits:   { cpu: 500m, memory: 256Mi }
---
apiVersion: v1
kind: Service
metadata: { name: $2, namespace: $1, labels: { app: $2 } }
spec:
  selector: { app: $2 }
  ports: [{ port: 80, targetPort: 8080 }]
YAML
}

echo "🌳 Creating 2 nodes + demo workloads..."
{
  emit_node small-0 4 16 zone-a
  emit_node small-1 4 16 zone-b

  echo "---"; echo "apiVersion: v1"; echo "kind: Namespace"; echo "metadata: { name: demo }"

  emit_app demo api 3
  emit_app demo web 2

  # A DaemonSet — one pod per schedulable node.
  cat <<YAML
---
apiVersion: apps/v1
kind: DaemonSet
metadata: { name: agent, namespace: demo, labels: { app: agent } }
spec:
  selector: { matchLabels: { app: agent } }
  template:
    metadata: { labels: { app: agent } }
    spec:
      tolerations: [ ${ALL_TOL} ]
      containers:
        - name: agent
          image: ghcr.io/acme/agent:2.0.0
          resources: { requests: { cpu: 20m, memory: 32Mi }, limits: { cpu: 100m, memory: 128Mi } }
YAML
} | kubectl apply -f - >/dev/null

echo "⏳ Waiting for kwok to schedule + mark pods Running..."
# Poll instead of a fixed sleep: kube-controller-manager needs a moment to
# create the pods, and that warmup is slower on CI runners than locally.
RUNNING=0
for _ in $(seq 1 30); do
  RUNNING=$(kubectl get pods -A --no-headers --field-selector=status.phase=Running 2>/dev/null | wc -l | tr -d ' ')
  [ "${RUNNING:-0}" -gt 0 ] && break
  sleep 1
done
TOTAL=$(kubectl get pods -A --no-headers 2>/dev/null | wc -l | tr -d ' ')
NODES=$(kubectl get nodes --no-headers 2>/dev/null | wc -l | tr -d ' ')
echo "✅ ${CLUSTER_NAME} ready — ${NODES} nodes, ${RUNNING}/${TOTAL} pods Running"
echo "   kubectl config use-context ${CLUSTER_NAME} && make run"
