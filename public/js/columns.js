//@ts-check

// ==========================================================================================
// Per-kind column definitions for the resource table
// ==========================================================================================

import { CLUSTER_KINDS } from './constants.js'
import { ageFrom, humanDuration } from './formatters.js'
import { podDetailedStatus } from './status.js'

/** @type {Record<string, {cpu: string, mem: string}>} Pod metrics keyed by pod name */
let _podMetrics = {}
/** @type {Record<string, {cpu: string, mem: string}>} Node metrics keyed by node name */
let _nodeMetrics = {}
/** @type {boolean} Whether to prepend a Namespace column (set in all-namespaces mode) */
let _showNamespaceCol = false

/**
 * Update pod metrics data used by CPU/Memory columns
 * @param {Record<string, {cpu: string, mem: string}>} m
 */
export function setMetricsData(m) {
  _podMetrics = m
}

/**
 * Update node metrics data used by CPU/Memory columns
 * @param {Record<string, {cpu: string, mem: string}>} m
 */
export function setNodeMetricsData(m) {
  _nodeMetrics = m
}

/**
 * Toggle whether columnsForKind prepends a Namespace column for namespaced kinds.
 * @param {boolean} show
 */
export function setShowNamespaceColumn(show) {
  _showNamespaceCol = !!show
}

const NAMESPACE_COL = {
  key: 'namespace',
  label: 'Namespace',
  getValue: (/** @type {any} */ r) => r.metadata?.namespace || '-',
}

/**
 * Returns the table column definitions for a given resource kind.
 * When all-namespaces mode is active (set via setShowNamespaceColumn), a Namespace
 * column is inserted after Name for namespaced kinds.
 * @param {string} kind
 * @returns {{key: string, label: string, getValue: (res: any) => string, getClass?: (res: any) => string}[]}
 */
export function columnsForKind(kind) {
  const cols = _columnsForKind(kind)
  if (!_showNamespaceCol || CLUSTER_KINDS.has(kind)) return cols
  // Insert after the Name column; fall back to the front if Name isn't first.
  const idx = cols[0]?.key === 'name' ? 1 : 0
  return [...cols.slice(0, idx), NAMESPACE_COL, ...cols.slice(idx)]
}

function _columnsForKind(kind) {
  switch (kind) {
    case 'Pod': {
      const cols = [
        { key: 'name', label: 'Name', getValue: (r) => r.metadata.name },
        {
          key: 'ready',
          label: 'Ready',
          getValue: (r) => {
            const cs = r.status?.containerStatuses || []
            if (cs.length === 0) return '0/0'
            const ready = cs.filter((c) => c.ready).length
            return `${ready}/${cs.length}`
          },
        },
        {
          key: 'status',
          label: 'Status',
          getValue: (r) => podDetailedStatus(r).text,
          getClass: (r) => podDetailedStatus(r).colorClass,
        },
        {
          key: 'restarts',
          label: 'Restarts',
          getValue: (r) => {
            const cs = r.status?.containerStatuses || []
            if (cs.length === 0) return '0'
            return String(cs.reduce((sum, c) => sum + (c.restartCount || 0), 0))
          },
        },
      ]
      if (Object.keys(_podMetrics).length > 0) {
        cols.push({ key: 'cpu', label: 'CPU', getValue: (r) => _podMetrics[r.metadata.name]?.cpu || '—' })
        cols.push({ key: 'mem', label: 'Memory', getValue: (r) => _podMetrics[r.metadata.name]?.mem || '—' })
      }
      cols.push({ key: 'age', label: 'Age', getValue: (r) => ageFrom(r.metadata.creationTimestamp) })
      return cols
    }

    case 'Deployment':
      return [
        { key: 'name', label: 'Name', getValue: (r) => r.metadata.name },
        {
          key: 'ready',
          label: 'Ready',
          getValue: (r) => `${r.status?.readyReplicas ?? 0}/${r.spec?.replicas ?? 0}`,
        },
        { key: 'upToDate', label: 'Up-to-date', getValue: (r) => String(r.status?.updatedReplicas ?? 0) },
        { key: 'available', label: 'Available', getValue: (r) => String(r.status?.availableReplicas ?? 0) },
        { key: 'age', label: 'Age', getValue: (r) => ageFrom(r.metadata.creationTimestamp) },
      ]

    case 'ReplicaSet':
      return [
        { key: 'name', label: 'Name', getValue: (r) => r.metadata.name },
        { key: 'desired', label: 'Desired', getValue: (r) => String(r.spec?.replicas ?? 0) },
        { key: 'current', label: 'Current', getValue: (r) => String(r.status?.replicas ?? 0) },
        { key: 'ready', label: 'Ready', getValue: (r) => String(r.status?.readyReplicas ?? 0) },
        { key: 'age', label: 'Age', getValue: (r) => ageFrom(r.metadata.creationTimestamp) },
      ]

    case 'StatefulSet':
      return [
        { key: 'name', label: 'Name', getValue: (r) => r.metadata.name },
        {
          key: 'ready',
          label: 'Ready',
          getValue: (r) => `${r.status?.readyReplicas ?? 0}/${r.spec?.replicas ?? 0}`,
        },
        { key: 'age', label: 'Age', getValue: (r) => ageFrom(r.metadata.creationTimestamp) },
      ]

    case 'DaemonSet':
      return [
        { key: 'name', label: 'Name', getValue: (r) => r.metadata.name },
        { key: 'desired', label: 'Desired', getValue: (r) => String(r.status?.desiredNumberScheduled ?? 0) },
        { key: 'current', label: 'Current', getValue: (r) => String(r.status?.currentNumberScheduled ?? 0) },
        { key: 'ready', label: 'Ready', getValue: (r) => String(r.status?.numberReady ?? 0) },
        { key: 'age', label: 'Age', getValue: (r) => ageFrom(r.metadata.creationTimestamp) },
      ]

    case 'Job':
      return [
        { key: 'name', label: 'Name', getValue: (r) => r.metadata.name },
        {
          key: 'completions',
          label: 'Completions',
          getValue: (r) => `${r.status?.succeeded ?? 0}/${r.spec?.completions ?? 1}`,
        },
        {
          key: 'duration',
          label: 'Duration',
          getValue: (r) => {
            if (!r.status?.startTime) return '-'
            const end = r.status.completionTime ? new Date(r.status.completionTime) : new Date()
            const start = new Date(r.status.startTime)
            return humanDuration(end - start)
          },
        },
        { key: 'age', label: 'Age', getValue: (r) => ageFrom(r.metadata.creationTimestamp) },
      ]

    case 'CronJob':
      return [
        { key: 'name', label: 'Name', getValue: (r) => r.metadata.name },
        { key: 'schedule', label: 'Schedule', getValue: (r) => r.spec?.schedule || '-' },
        { key: 'active', label: 'Active', getValue: (r) => String((r.status?.active || []).length) },
        { key: 'lastSchedule', label: 'Last Schedule', getValue: (r) => (r.status?.lastScheduleTime ? ageFrom(r.status.lastScheduleTime) : '-') },
        { key: 'age', label: 'Age', getValue: (r) => ageFrom(r.metadata.creationTimestamp) },
      ]

    case 'Service':
      return [
        { key: 'name', label: 'Name', getValue: (r) => r.metadata.name },
        { key: 'type', label: 'Type', getValue: (r) => r.spec?.type || '-' },
        { key: 'clusterIP', label: 'Cluster-IP', getValue: (r) => r.spec?.clusterIP || '-' },
        {
          key: 'ports',
          label: 'Port(s)',
          getValue: (r) => (r.spec?.ports || []).map((p) => `${p.port}/${p.protocol || 'TCP'}`).join(', ') || '-',
        },
        { key: 'age', label: 'Age', getValue: (r) => ageFrom(r.metadata.creationTimestamp) },
      ]

    case 'Ingress':
      return [
        { key: 'name', label: 'Name', getValue: (r) => r.metadata.name },
        {
          key: 'hosts',
          label: 'Hosts',
          getValue: (r) => (r.spec?.rules || []).map((rule) => rule.host || '*').join(', ') || '-',
        },
        {
          key: 'address',
          label: 'Address',
          getValue: (r) => (r.status?.loadBalancer?.ingress || []).map((i) => i.ip || i.hostname).join(', ') || '-',
        },
        { key: 'age', label: 'Age', getValue: (r) => ageFrom(r.metadata.creationTimestamp) },
      ]

    case 'NetworkPolicy':
      return [
        { key: 'name', label: 'Name', getValue: (r) => r.metadata.name },
        {
          key: 'podSelector',
          label: 'Pod Selector',
          getValue: (r) => {
            const sel = r.spec?.podSelector?.matchLabels || {}
            const entries = Object.entries(sel)
            return entries.length ? entries.map(([k, v]) => `${k}=${v}`).join(', ') : '<all>'
          },
        },
        {
          key: 'policyTypes',
          label: 'Policy Types',
          getValue: (r) => (r.spec?.policyTypes || []).join(', ') || '-',
        },
        { key: 'age', label: 'Age', getValue: (r) => ageFrom(r.metadata.creationTimestamp) },
      ]

    case 'ConfigMap':
      return [
        { key: 'name', label: 'Name', getValue: (r) => r.metadata.name },
        { key: 'data', label: 'Data', getValue: (r) => String(Object.keys(r.data || {}).length) },
        { key: 'age', label: 'Age', getValue: (r) => ageFrom(r.metadata.creationTimestamp) },
      ]

    case 'Secret':
      return [
        { key: 'name', label: 'Name', getValue: (r) => r.metadata.name },
        { key: 'type', label: 'Type', getValue: (r) => r.type || '-' },
        { key: 'data', label: 'Data', getValue: (r) => String(Object.keys(r.data || {}).length) },
        { key: 'age', label: 'Age', getValue: (r) => ageFrom(r.metadata.creationTimestamp) },
      ]

    case 'PersistentVolumeClaim':
      return [
        { key: 'name', label: 'Name', getValue: (r) => r.metadata.name },
        { key: 'status', label: 'Status', getValue: (r) => r.status?.phase || '-' },
        { key: 'capacity', label: 'Capacity', getValue: (r) => r.status?.capacity?.storage || r.spec?.resources?.requests?.storage || '-' },
        { key: 'age', label: 'Age', getValue: (r) => ageFrom(r.metadata.creationTimestamp) },
      ]

    case 'Node': {
      const cols = [
        { key: 'name', label: 'Name', getValue: (r) => r.metadata.name },
        {
          key: 'status',
          label: 'Status',
          getValue: (r) => {
            const conditions = r.status?.conditions || []
            const ready = conditions.find((c) => c.type === 'Ready')
            return ready && ready.status === 'True' ? 'Ready' : 'NotReady'
          },
          getClass: (r) => {
            const conditions = r.status?.conditions || []
            const ready = conditions.find((c) => c.type === 'Ready')
            return ready && ready.status === 'True' ? 'text-green' : 'text-red'
          },
        },
        {
          key: 'roles',
          label: 'Roles',
          getValue: (r) => {
            const labels = r.metadata?.labels || {}
            const roles = Object.keys(labels)
              .filter((k) => k.startsWith('node-role.kubernetes.io/'))
              .map((k) => k.replace('node-role.kubernetes.io/', ''))
            return roles.length > 0 ? roles.join(',') : '<none>'
          },
        },
        { key: 'version', label: 'Version', getValue: (r) => r.status?.nodeInfo?.kubeletVersion || '-' },
        {
          key: 'internalIP',
          label: 'Internal-IP',
          getValue: (r) => {
            const addrs = r.status?.addresses || []
            const internal = addrs.find((a) => a.type === 'InternalIP')
            return internal?.address || '-'
          },
        },
      ]
      if (Object.keys(_nodeMetrics).length > 0) {
        cols.push({ key: 'cpu', label: 'CPU', getValue: (r) => _nodeMetrics[r.metadata.name]?.cpu || '—' })
        cols.push({ key: 'mem', label: 'Memory', getValue: (r) => _nodeMetrics[r.metadata.name]?.mem || '—' })
      }
      cols.push({ key: 'age', label: 'Age', getValue: (r) => ageFrom(r.metadata.creationTimestamp) })
      return cols
    }

    case 'PersistentVolume':
      return [
        { key: 'name', label: 'Name', getValue: (r) => r.metadata.name },
        { key: 'capacity', label: 'Capacity', getValue: (r) => r.spec?.capacity?.storage || '-' },
        {
          key: 'accessModes',
          label: 'Access Modes',
          getValue: (r) => (r.spec?.accessModes || []).join(', ') || '-',
        },
        { key: 'reclaimPolicy', label: 'Reclaim', getValue: (r) => r.spec?.persistentVolumeReclaimPolicy || '-' },
        {
          key: 'status',
          label: 'Status',
          getValue: (r) => r.status?.phase || '-',
          getClass: (r) => {
            const phase = r.status?.phase
            if (phase === 'Bound') return 'text-green'
            if (phase === 'Available') return 'text-blue'
            if (phase === 'Released') return 'text-yellow'
            return 'text-red'
          },
        },
        {
          key: 'claim',
          label: 'Claim',
          getValue: (r) => {
            const ref = r.spec?.claimRef
            return ref ? `${ref.namespace}/${ref.name}` : '-'
          },
          getRef: (r) => {
            const ref = r.spec?.claimRef
            return ref?.name ? { kind: 'PersistentVolumeClaim', namespace: ref.namespace, name: ref.name } : null
          },
        },
        { key: 'storageClass', label: 'StorageClass', getValue: (r) => r.spec?.storageClassName || '-' },
        { key: 'age', label: 'Age', getValue: (r) => ageFrom(r.metadata.creationTimestamp) },
      ]

    case 'HorizontalPodAutoscaler':
      return [
        { key: 'name', label: 'Name', getValue: (r) => r.metadata.name },
        {
          key: 'reference',
          label: 'Reference',
          getValue: (r) => (r.spec?.scaleTargetRef ? `${r.spec.scaleTargetRef.kind}/${r.spec.scaleTargetRef.name}` : '-'),
          getRef: (r) => {
            const tgt = r.spec?.scaleTargetRef
            return tgt?.kind && tgt?.name ? { kind: tgt.kind, namespace: r.metadata?.namespace, name: tgt.name } : null
          },
        },
        { key: 'min', label: 'Min', getValue: (r) => String(r.spec?.minReplicas ?? '-') },
        { key: 'max', label: 'Max', getValue: (r) => String(r.spec?.maxReplicas ?? '-') },
        { key: 'replicas', label: 'Replicas', getValue: (r) => String(r.status?.currentReplicas ?? 0) },
        { key: 'age', label: 'Age', getValue: (r) => ageFrom(r.metadata.creationTimestamp) },
      ]

    default:
      return [
        { key: 'name', label: 'Name', getValue: (r) => r.metadata.name },
        {
          key: 'status',
          label: 'Status',
          getValue: (r) => {
            // Try common status patterns: .status.phase, .status.conditions[0].type, .status.state
            const s = r.status
            if (!s) return '-'
            if (s.phase) return s.phase
            if (s.state) return s.state
            if (Array.isArray(s.conditions) && s.conditions.length > 0) {
              const ready = s.conditions.find((c) => c.type === 'Ready' && c.status === 'True')
              return ready ? 'Ready' : s.conditions[0].type
            }
            return '-'
          },
        },
        { key: 'age', label: 'Age', getValue: (r) => ageFrom(r.metadata.creationTimestamp) },
      ]
  }
}
