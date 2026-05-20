//@ts-check

// ==========================================================================================
// Shared constants: drill-down map, sidebar groups, cluster-scoped kinds
// ==========================================================================================

// Drill-down relationships: which kind's children to show when drilling in
export const DRILL_DOWN = {
  Deployment: { childKind: 'ReplicaSet' },
  ReplicaSet: { childKind: 'Pod' },
  StatefulSet: { childKind: 'Pod' },
  DaemonSet: { childKind: 'Pod' },
  Job: { childKind: 'Pod' },
  CronJob: { childKind: 'Job' },
}

// Resource groups shown in the sidebar
export const RESOURCE_GROUPS = [
  { label: 'Cluster', kinds: ['Node', 'PersistentVolume'], isCluster: true },
  { label: 'Workloads', kinds: ['Pod', 'Deployment', 'ReplicaSet', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob'] },
  { label: 'Networking', kinds: ['Service', 'Ingress', 'NetworkPolicy'] },
  { label: 'Config', kinds: ['ConfigMap', 'Secret'] },
  { label: 'Storage', kinds: ['PersistentVolumeClaim'] },
  { label: 'Other', kinds: ['HorizontalPodAutoscaler'] },
]

// Kinds that are cluster-scoped (no namespace)
export const CLUSTER_KINDS = new Set(RESOURCE_GROUPS.filter((g) => g.isCluster).flatMap((g) => g.kinds))

// Sentinel for "all namespaces" mode. Must match the backend's AllNamespacesSentinel
// (server/routes.go) and SSE group name (server/services/events/events.go).
export const ALL_NAMESPACES = '_all_'
