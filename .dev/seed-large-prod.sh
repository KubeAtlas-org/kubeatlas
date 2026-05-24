#!/usr/bin/env bash
# Provisions kubeatlas-test-large-prod: a kwok virtual cluster shaped like a
# real mid-size company's production cluster. Heterogeneous topology, mixed
# workload kinds (Deployment / StatefulSet / DaemonSet / Job / CronJob),
# realistic node pools, sidecars + init containers, PVCs, populated infra
# namespaces, and all four KubeAtlas edge types. Everything is STABLE — kwok's
# default stage pins pods Running with no flapping, safe to drive live.
#
# This is the realistic-cluster driver. For raw scale/perf use seed-large-perf.sh;
# for the broken-cluster diagnostic story use seed-large-incident.sh.
#
# ~19 nodes, ~180 pods, ~500 resources. Idempotent.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLUSTER_NAME="kubeatlas-test-large-prod"
KWOK_CONTEXT="kwok-${CLUSTER_NAME}"

command -v kwokctl >/dev/null 2>&1 || {
  echo "💥 kwokctl not installed. Run: GOBIN=\$HOME/.local/bin go install sigs.k8s.io/kwok/cmd/{kwokctl,kwok}@latest"
  exit 1
}

if kwokctl get clusters 2>/dev/null | grep -qx "${CLUSTER_NAME}"; then
  echo "✅ ${CLUSTER_NAME} already exists"
else
  echo "🏗  Creating kwok cluster ${CLUSTER_NAME} (metrics-server + ClusterResourceUsage)..."
  # ClusterResourceUsage drives kwok's /metrics/resource so metrics-server has
  # real data → live metrics columns in KubeAtlas. Stage CRD is intentionally
  # NOT enabled here: that would suppress kwok's bundled default pod/node
  # stages (we want pods pinned Running with zero config). Incident cluster
  # enables Stage and re-supplies the defaults.
  # Metrics: pass kwok's Metric definition + tiered usage as startup configs
  # (-c), the officially-supported path. This makes kwok wire each node's
  # metrics endpoint at init time; applying the same objects as in-cluster
  # CRDs afterwards leaves metrics-server scraping a 404. Stage CRD is
  # deliberately NOT enabled — that would suppress kwok's bundled default
  # pod/node stages (we want pods pinned Running with zero extra config).
  # --kube-admission=false: kwok creates per-namespace default ServiceAccounts
  # asynchronously, so the ServiceAccount admission plugin would reject pods
  # applied in the same batch as their namespace. This is a fake cluster, so
  # turning admission off is both safe and deterministic.
  kwokctl create cluster --name "${CLUSTER_NAME}" \
    --kube-admission=false \
    --enable metrics-server \
    -c "${SCRIPT_DIR}/kwok/metrics-resource.yaml" \
    -c "${SCRIPT_DIR}/kwok/usage-tiers.yaml"
fi

if kubectl config get-contexts -o name 2>/dev/null | grep -qx "${KWOK_CONTEXT}"; then
  kubectl config delete-context "${CLUSTER_NAME}" >/dev/null 2>&1 || true
  kubectl config rename-context "${KWOK_CONTEXT}" "${CLUSTER_NAME}" >/dev/null
fi
kubectl config use-context "${CLUSTER_NAME}" >/dev/null

# ============================================================================
# Node pools — realistic labels/taints/zones. Every node carries the kwok
# fake taint+annotation (proven pattern: real kube-scheduler still binds via
# tolerations, kwok marks Running). Pool-specific taints add believable
# scheduling semantics on top.
# ============================================================================
REGION="us-east-1"
ZONES=(us-east-1a us-east-1b us-east-1c)

emit_node() {
  # $1 name  $2 instance-type  $3 cpu  $4 memGi  $5 role-label  $6 zone
  # $7 extra-taint-key (optional)  $8 extra-taint-val  $9 unschedulable(true|"")
  local name="$1" itype="$2" cpu="$3" mem="$4" role="$5" zone="$6"
  local tkey="${7:-}" tval="${8:-}" unsched="${9:-}"
  cat <<YAML
apiVersion: v1
kind: Node
metadata:
  name: ${name}
  annotations:
    node.alpha.kubernetes.io/ttl: "0"
    kwok.x-k8s.io/node: fake
    # metrics-server 0.7+ reads this to find kwok's per-node metrics endpoint.
    # kwok does NOT auto-add it to hand-created nodes, so set it explicitly —
    # without it metrics-server scrapes the default path and 404s.
    metrics.k8s.io/resource-metrics-path: "/metrics/nodes/${name}/metrics/resource"
  labels:
    type: kwok
    kubernetes.io/hostname: ${name}
    kubernetes.io/os: linux
    kubernetes.io/arch: amd64
    node.kubernetes.io/instance-type: ${itype}
    topology.kubernetes.io/region: ${REGION}
    topology.kubernetes.io/zone: ${zone}
    node.kubernetes.io/role: ${role}
$( [ "${role}" = "control-plane" ] && echo '    node-role.kubernetes.io/control-plane: ""' )
$( [ "${tkey}" = "karpenter.sh/capacity-type" ] && echo '    karpenter.sh/capacity-type: spot' )
$( [ "${tkey}" = "workload" ] && echo '    workload: memory' )
spec:
  unschedulable: $( [ -n "${unsched}" ] && echo true || echo false )
  taints:
    - { effect: NoSchedule, key: kwok.x-k8s.io/node, value: fake }
$( [ "${role}" = "control-plane" ] && echo '    - { effect: NoSchedule, key: node-role.kubernetes.io/control-plane, value: "" }' )
$( [ -n "${tkey}" ] && echo "    - { effect: NoSchedule, key: ${tkey}, value: ${tval} }" )
status:
  # NOTE: deliberately no conditions/addresses here. kwok's default
  # node-initialize stage only fires on nodes that are NOT yet Ready; if we
  # pre-bake Ready=True it never runs, so the node never gets an InternalIP
  # or the metrics endpoint wiring (breaks metrics-server). Let kwok do it.
  allocatable: { cpu: "${cpu}", memory: ${mem}Gi, pods: "110" }
  capacity:    { cpu: "${cpu}", memory: ${mem}Gi, pods: "110" }
  nodeInfo:
    kubeletVersion: fake-1.33.0
    osImage: "Flatcar Container Linux 3975.2.0"
    containerRuntimeVersion: "containerd://1.7.20"
---
YAML
}

echo "🌳 Creating node pools (3 control-plane, 10 general, 3 memory, 2 spot, 1 cordoned)..."
{
  for i in 0 1 2; do
    emit_node "cp-${i}" "m5.large" 2 8 control-plane "${ZONES[$((i%3))]}"
  done
  for i in $(seq 0 9); do
    emit_node "gen-$(printf '%02d' "$i")" "m5.2xlarge" 8 32 worker "${ZONES[$((i%3))]}"
  done
  for i in 0 1 2; do
    emit_node "mem-${i}" "r5.4xlarge" 16 128 worker "${ZONES[$((i%3))]}" workload memory
  done
  for i in 0 1; do
    emit_node "spot-${i}" "m5.2xlarge" 8 32 worker "${ZONES[$((i%3))]}" karpenter.sh/capacity-type spot
  done
  # One node cordoned mid-drain (Ready but SchedulingDisabled) — always-there
  # realism, harmless for the demo.
  emit_node "gen-cordon-0" "m5.2xlarge" 8 32 worker "${ZONES[0]}" "" "" true
} | kubectl apply -f - >/dev/null

# Blanket toleration applied to every pod template so the real scheduler can
# bind onto kwok fake nodes. Pool taints (control-plane / memory / spot) are
# tolerated selectively where it makes sense.
FAKE_TOL='{ effect: NoSchedule, key: kwok.x-k8s.io/node, value: fake }'
MEM_TOL='{ effect: NoSchedule, key: workload, value: memory }'
ALL_TOL="{ operator: Exists }"  # DaemonSets tolerate everything (incl. control-plane)

# ============================================================================
# Reusable emitters. Heterogeneity comes from varied arguments, not from a
# uniform grid — that is the whole point vs. seed-large-perf.
# ============================================================================

# A standard stateless app: SA + ConfigMap + Secret + Deployment + Service.
# $1 ns  $2 name  $3 replicas  $4 part-of  $5 sidecar(true|"")  $6 svc-type
emit_app() {
  local ns="$1" name="$2" rep="$3" pof="$4" side="${5:-}" svct="${6:-ClusterIP}"
  cat <<YAML
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: ${name}, namespace: ${ns} }
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: ${name}-config
  namespace: ${ns}
  labels: { app.kubernetes.io/name: ${name}, app.kubernetes.io/part-of: ${pof} }
data: { LOG_LEVEL: info, REGION: ${REGION}, FEATURE_FLAGS: "checkout-v2,recs" }
---
apiVersion: v1
kind: Secret
metadata: { name: ${name}-secret, namespace: ${ns} }
type: Opaque
stringData: { DB_PASSWORD: fake-pw, API_KEY: fake-key }
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  namespace: ${ns}
  labels:
    app.kubernetes.io/name: ${name}
    app.kubernetes.io/part-of: ${pof}
    app.kubernetes.io/managed-by: argocd
spec:
  replicas: ${rep}
  selector: { matchLabels: { app.kubernetes.io/name: ${name} } }
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ${name}
        app.kubernetes.io/part-of: ${pof}
        app.kubernetes.io/version: "1.8.${rep}"
$( [ -n "${side}" ] && echo '      annotations: { sidecar.istio.io/status: injected }' )
    spec:
      serviceAccountName: ${name}
      tolerations: [ ${FAKE_TOL} ]
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: ScheduleAnyway
          labelSelector: { matchLabels: { app.kubernetes.io/name: ${name} } }
      initContainers:
        - name: init-config
          image: busybox:1.36
          command: ["sh","-c","echo seeding config && sleep 1"]
          resources: { requests: { cpu: 10m, memory: 16Mi }, limits: { cpu: 50m, memory: 32Mi } }
      containers:
        - name: ${name}
          image: ghcr.io/acme/${name}:1.8.${rep}
          ports: [{ containerPort: 8080 }]
          envFrom: [{ configMapRef: { name: ${name}-config } }]
          env:
            - name: DB_PASSWORD
              valueFrom: { secretKeyRef: { name: ${name}-secret, key: DB_PASSWORD } }
          resources:
            requests: { cpu: 100m, memory: 128Mi }
            limits:   { cpu: 500m, memory: 512Mi }
          volumeMounts: [{ name: config, mountPath: /etc/${name} }]
$( [ -n "${side}" ] && cat <<SIDE
        - name: istio-proxy
          image: docker.io/istio/proxyv2:1.22.0
          ports: [{ containerPort: 15001 }]
          resources: { requests: { cpu: 50m, memory: 64Mi }, limits: { cpu: 200m, memory: 128Mi } }
SIDE
)
      volumes: [{ name: config, configMap: { name: ${name}-config } }]
---
apiVersion: v1
kind: Service
metadata:
  name: ${name}
  namespace: ${ns}
  labels: { app.kubernetes.io/name: ${name}, app.kubernetes.io/part-of: ${pof} }
spec:
  type: ${svct}
  selector: { app.kubernetes.io/name: ${name} }
  ports: [{ port: 80, targetPort: 8080 }]
YAML
}

# A stateful backing service: headless Service + StatefulSet + per-replica PVC.
# $1 ns  $2 name  $3 replicas  $4 part-of  $5 onMemPool(true|"")
emit_sts() {
  local ns="$1" name="$2" rep="$3" pof="$4" mem="${5:-}"
  cat <<YAML
---
apiVersion: v1
kind: Service
metadata:
  name: ${name}
  namespace: ${ns}
  labels: { app.kubernetes.io/name: ${name}, app.kubernetes.io/part-of: ${pof} }
spec:
  clusterIP: None
  selector: { app.kubernetes.io/name: ${name} }
  ports: [{ port: 5432, targetPort: 5432 }]
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: ${name}
  namespace: ${ns}
  labels: { app.kubernetes.io/name: ${name}, app.kubernetes.io/part-of: ${pof} }
spec:
  serviceName: ${name}
  replicas: ${rep}
  selector: { matchLabels: { app.kubernetes.io/name: ${name} } }
  template:
    metadata:
      labels: { app.kubernetes.io/name: ${name}, app.kubernetes.io/part-of: ${pof} }
    spec:
      tolerations: [ ${FAKE_TOL}$( [ -n "${mem}" ] && echo ", ${MEM_TOL}" ) ]
$( [ -n "${mem}" ] && echo '      nodeSelector: { workload: memory }' )
      containers:
        - name: ${name}
          image: docker.io/library/${name}:16
          ports: [{ containerPort: 5432 }]
          resources:
            requests: { cpu: 250m, memory: 512Mi }
            limits:   { cpu: "2",  memory: 4Gi }
          volumeMounts: [{ name: data, mountPath: /var/lib/${name} }]
  volumeClaimTemplates:
    - metadata: { name: data }
      spec:
        accessModes: [ReadWriteOnce]
        storageClassName: gp3
        resources: { requests: { storage: 20Gi } }
YAML
}

# A DaemonSet (one pod per schedulable node — real scheduler does the spread).
# $1 ns  $2 name  $3 part-of
emit_ds() {
  local ns="$1" name="$2" pof="$3"
  cat <<YAML
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: ${name}
  namespace: ${ns}
  labels: { app.kubernetes.io/name: ${name}, app.kubernetes.io/part-of: ${pof} }
spec:
  selector: { matchLabels: { app.kubernetes.io/name: ${name} } }
  template:
    metadata:
      labels: { app.kubernetes.io/name: ${name}, app.kubernetes.io/part-of: ${pof} }
    spec:
      tolerations: [ ${ALL_TOL} ]
      containers:
        - name: ${name}
          image: ghcr.io/acme/${name}:2.1.0
          resources: { requests: { cpu: 20m, memory: 32Mi }, limits: { cpu: 100m, memory: 128Mi } }
          volumeMounts: [{ name: hostfs, mountPath: /host, readOnly: true }]
      volumes: [{ name: hostfs, hostPath: { path: / } }]
YAML
}

emit_ns() { echo "---"; echo "apiVersion: v1"; echo "kind: Namespace"; echo "metadata: { name: $1 }"; }

# ============================================================================
# Storage — kwok has no volume provisioner, so StatefulSet volumeClaimTemplate
# PVCs never bind and pods hang Pending forever. Fix: a no-provisioner
# StorageClass (Immediate binding) + a pool of statically-provisioned PVs.
# kube-controller-manager's PV binder (running in kwokctl) auto-binds the
# STS-created PVCs to these → pods schedule. Fully real controller behaviour,
# no kwok Stage needed.
# ============================================================================
echo "💽 Creating StorageClass + static PV pool..."
{
  cat <<YAML
---
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
  annotations: { storageclass.kubernetes.io/is-default-class: "true" }
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: Immediate
reclaimPolicy: Delete
YAML
  # 30 PVs >> the ~16 STS replicas (headroom for rescale).
  for i in $(seq 1 30); do
    cat <<YAML
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: pv-$(printf '%03d' "$i")
  labels: { type: kwok }
spec:
  capacity: { storage: 20Gi }
  accessModes: [ReadWriteOnce]
  persistentVolumeReclaimPolicy: Delete
  storageClassName: gp3
  hostPath: { path: /tmp/kwok-pv-$(printf '%03d' "$i") }
YAML
  done
} | kubectl apply -f - >/dev/null

echo "📦 Creating namespaces, infra stack, and product workloads..."
{
  for NS in kube-system monitoring ingress-nginx cert-manager logging \
            storefront checkout payments catalog accounts; do
    emit_ns "$NS"
  done

  # --- kube-system (kwok leaves it empty; make it look like a real cluster) ---
  # NOTE: kwok already runs a real metrics-server in kube-system — do NOT
  # create a fake one here or it clobbers the working service.
  emit_app  kube-system coredns 2 kubernetes
  emit_app  kube-system konnectivity-agent 2 kubernetes
  emit_ds   kube-system kube-proxy kubernetes

  # --- monitoring stack ---
  emit_app  monitoring grafana 2 observability
  emit_app  monitoring kube-state-metrics 1 observability
  emit_sts  monitoring prometheus 1 observability
  emit_sts  monitoring alertmanager 3 observability
  emit_ds   monitoring node-exporter observability

  # --- ingress + cert-manager + logging ---
  emit_app  ingress-nginx ingress-nginx-controller 3 ingress "" LoadBalancer
  emit_app  cert-manager cert-manager 2 cert-manager
  emit_app  cert-manager cert-manager-webhook 1 cert-manager
  emit_app  cert-manager cert-manager-cainjector 1 cert-manager
  emit_sts  logging loki 2 observability
  emit_ds   logging fluent-bit observability

  # --- product namespaces (heterogeneous: different app counts & replicas) ---
  emit_app  storefront frontend 8 storefront true        # sidecar + Ingress + HPA
  emit_app  storefront web-bff 4 storefront true
  emit_sts  storefront redis-store 1 storefront

  emit_app  checkout checkout-api 5 checkout true        # HPA
  emit_app  checkout cart 4 checkout
  emit_sts  checkout redis-cart 1 checkout

  emit_app  payments payments-api 4 payments true        # HPA + NetworkPolicy
  emit_app  payments ledger 3 payments
  emit_sts  payments postgres 2 payments true            # on memory pool

  emit_app  catalog catalog-api 6 catalog
  emit_app  catalog indexer 3 catalog
  emit_sts  catalog elasticsearch 3 catalog true         # on memory pool

  emit_app  accounts accounts-api 5 accounts true        # HPA
  emit_sts  accounts kafka 3 accounts
} | kubectl apply -f - >/dev/null

echo "🔗 Adding Ingress, HPAs, NetworkPolicy, ResourceQuota, CronJob/Job..."
{
  # Ingress (network edge) for the public-facing tier.
  cat <<YAML
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: storefront
  namespace: storefront
  annotations: { cert-manager.io/cluster-issuer: letsencrypt-prod }
spec:
  ingressClassName: nginx
  tls: [{ hosts: [shop.acme.test], secretName: storefront-tls }]
  rules:
    - host: shop.acme.test
      http:
        paths:
          - { path: /, pathType: Prefix, backend: { service: { name: frontend, port: { number: 80 } } } }
          - { path: /checkout, pathType: Prefix, backend: { service: { name: checkout-api, port: { number: 80 } } } }
YAML

  # HPAs (owner edge → Deployment) on the elastic tiers.
  for pair in "storefront/frontend" "checkout/checkout-api" "payments/payments-api" "accounts/accounts-api"; do
    ns="${pair%%/*}"; dep="${pair##*/}"
    cat <<YAML
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: ${dep}, namespace: ${ns} }
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: ${dep} }
  minReplicas: 3
  maxReplicas: 20
  metrics:
    - type: Resource
      resource: { name: cpu, target: { type: Utilization, averageUtilization: 70 } }
YAML
  done

  # NetworkPolicy — realistic for a payments namespace.
  cat <<YAML
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: payments-default-deny, namespace: payments }
spec:
  podSelector: {}
  policyTypes: [Ingress]
  ingress:
    - from: [{ namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: checkout } } }]
YAML

  # ResourceQuota + LimitRange on the busiest namespaces.
  for NS in payments checkout; do
    cat <<YAML
---
apiVersion: v1
kind: ResourceQuota
metadata: { name: compute-quota, namespace: ${NS} }
spec:
  hard: { requests.cpu: "20", requests.memory: 40Gi, pods: "60" }
---
apiVersion: v1
kind: LimitRange
metadata: { name: default-limits, namespace: ${NS} }
spec:
  limits:
    - type: Container
      default: { cpu: 500m, memory: 512Mi }
      defaultRequest: { cpu: 100m, memory: 128Mi }
YAML
  done

  # CronJob (payments reconciliation) + a couple of completed Jobs it "ran".
  cat <<YAML
---
apiVersion: batch/v1
kind: CronJob
metadata: { name: payment-reconcile, namespace: payments }
spec:
  schedule: "*/15 * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: Never
          tolerations: [ ${FAKE_TOL} ]
          containers:
            - name: reconcile
              image: ghcr.io/acme/reconcile:1.4.0
              resources: { requests: { cpu: 100m, memory: 128Mi } }
---
apiVersion: batch/v1
kind: Job
metadata:
  name: accounts-migrate
  namespace: accounts
  labels: { app.kubernetes.io/part-of: accounts }
spec:
  backoffLimit: 3
  template:
    spec:
      restartPolicy: Never
      tolerations: [ ${FAKE_TOL} ]
      containers:
        - name: migrate
          image: ghcr.io/acme/accounts:1.8.5
          command: ["sh","-c","echo migrating && sleep 2"]
          resources: { requests: { cpu: 100m, memory: 128Mi } }
YAML
} | kubectl apply -f - >/dev/null

echo "⏳ Waiting for kwok to schedule + mark pods Running..."
sleep 5
TOTAL=$(kubectl get pods -A --no-headers 2>/dev/null | wc -l | tr -d ' ')
RUNNING=$(kubectl get pods -A --no-headers --field-selector=status.phase=Running 2>/dev/null | wc -l | tr -d ' ')
NODES=$(kubectl get nodes --no-headers 2>/dev/null | wc -l | tr -d ' ')
NS_COUNT=$(kubectl get ns --no-headers 2>/dev/null | wc -l | tr -d ' ')
echo "✅ ${CLUSTER_NAME} ready — ${NODES} nodes, ${NS_COUNT} namespaces, ${RUNNING}/${TOTAL} pods Running"
echo "   kubectl config use-context ${CLUSTER_NAME} && make run"
