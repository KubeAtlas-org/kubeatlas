//@ts-check

// ==========================================================================================
// Pure builders for the detail pane: fields, sections, and cached events lookup
// ==========================================================================================

import { getEventsForResource, getTimestamp } from './cache.js'
import { RESOURCE_GROUPS } from './constants.js'
import { ageFrom } from './formatters.js'
import { podDetailedStatus } from './status.js'

const KNOWN_KINDS = new Set(RESOURCE_GROUPS.flatMap((g) => g.kinds))

function ownerRefField(res) {
  const owner = res.metadata?.ownerReferences?.[0]
  if (!owner?.kind || !owner?.name) return null
  const field = { key: 'owner', label: 'Controlled By', value: `${owner.kind}/${owner.name}` }
  if (KNOWN_KINDS.has(owner.kind)) {
    field.ref = { kind: owner.kind, namespace: res.metadata?.namespace, name: owner.name }
  }
  return field
}

/**
 * Build the field list for a resource's detail pane.
 * @param {any} res
 * @param {Record<string, {cpu: string, mem: string}>} podMetrics
 * @param {Record<string, {cpu: string, mem: string}>} nodeMetrics
 */
export function buildDetailFields(res, podMetrics, nodeMetrics) {
  const fields = []
  if (res.kind === 'Pod') {
    const cs = res.status?.containerStatuses || []
    const { text, colorClass } = podDetailedStatus(res)
    fields.push({ key: 'status', label: 'Status', value: text, colorClass })
    const ready = cs.filter((c) => c.ready).length
    fields.push({ key: 'ready', label: 'Ready', value: cs.length ? `${ready}/${cs.length}` : '0/0' })
    const restarts = cs.reduce((s, c) => s + (c.restartCount || 0), 0)
    fields.push({ key: 'restarts', label: 'Restarts', value: String(restarts) })
    if (res.spec?.nodeName) fields.push({ key: 'node', label: 'Node', value: res.spec.nodeName, ref: { kind: 'Node', name: res.spec.nodeName } })
    if (res.status?.podIP) fields.push({ key: 'ip', label: 'IP', value: res.status.podIP })
    if (res.status?.qosClass) fields.push({ key: 'qos', label: 'QoS', value: res.status.qosClass })
    if (res.spec?.serviceAccountName) fields.push({ key: 'sa', label: 'ServiceAccount', value: res.spec.serviceAccountName })
    const podOwner = ownerRefField(res)
    if (podOwner) fields.push(podOwner)
    const pm = podMetrics[res.metadata.name]
    if (pm) {
      fields.push({ key: 'cpuUsage', label: 'CPU', value: pm.cpu })
      fields.push({ key: 'memUsage', label: 'Memory', value: pm.mem })
    }
  } else if (res.kind === 'Deployment') {
    const ready = res.status?.readyReplicas ?? 0
    const desired = res.spec?.replicas ?? 0
    fields.push({ key: 'ready', label: 'Ready', value: `${ready}/${desired}` })
    if (res.status?.availableReplicas !== undefined) fields.push({ key: 'avail', label: 'Available', value: String(res.status.availableReplicas) })
    if (res.status?.updatedReplicas !== undefined) fields.push({ key: 'updated', label: 'Up-to-date', value: String(res.status.updatedReplicas) })
    if (res.spec?.strategy?.type) fields.push({ key: 'strategy', label: 'Strategy', value: res.spec.strategy.type })
    if (res.metadata?.generation) fields.push({ key: 'gen', label: 'Generation', value: String(res.metadata.generation) })
  } else if (res.kind === 'StatefulSet') {
    const ready = res.status?.readyReplicas ?? 0
    const desired = res.spec?.replicas ?? 0
    fields.push({ key: 'ready', label: 'Ready', value: `${ready}/${desired}` })
    if (res.status?.updatedReplicas !== undefined) fields.push({ key: 'updated', label: 'Up-to-date', value: String(res.status.updatedReplicas) })
    if (res.spec?.updateStrategy?.type) fields.push({ key: 'strategy', label: 'Strategy', value: res.spec.updateStrategy.type })
    if (res.metadata?.generation) fields.push({ key: 'gen', label: 'Generation', value: String(res.metadata.generation) })
  } else if (res.kind === 'DaemonSet') {
    const ready = res.status?.numberReady ?? 0
    const desired = res.status?.desiredNumberScheduled ?? 0
    fields.push({ key: 'ready', label: 'Ready', value: `${ready}/${desired}` })
    if (res.status?.numberMisscheduled !== undefined) fields.push({ key: 'mis', label: 'Misscheduled', value: String(res.status.numberMisscheduled) })
  } else if (res.kind === 'Service') {
    if (res.spec?.type) fields.push({ key: 'type', label: 'Type', value: res.spec.type })
    if (res.spec?.clusterIP) fields.push({ key: 'ip', label: 'ClusterIP', value: res.spec.clusterIP })
    const extIPs = (res.spec?.externalIPs || []).join(', ')
    if (extIPs) fields.push({ key: 'extip', label: 'ExternalIP(s)', value: extIPs })
    const ports = (res.spec?.ports || []).map((p) => `${p.port}/${p.protocol || 'TCP'}`).join(', ')
    if (ports) fields.push({ key: 'ports', label: 'Port(s)', value: ports })
    if (res.spec?.sessionAffinity && res.spec.sessionAffinity !== 'None')
      fields.push({ key: 'affinity', label: 'Affinity', value: res.spec.sessionAffinity })
  } else if (res.kind === 'Job') {
    fields.push({ key: 'completions', label: 'Completions', value: `${res.status?.succeeded ?? 0}/${res.spec?.completions ?? 1}` })
    if (res.spec?.backoffLimit !== undefined) fields.push({ key: 'backoff', label: 'BackoffLimit', value: String(res.spec.backoffLimit) })
    if (res.spec?.parallelism !== undefined) fields.push({ key: 'par', label: 'Parallelism', value: String(res.spec.parallelism) })
    if (res.status?.startTime && res.status?.completionTime) {
      const dur = Math.round((Date.parse(res.status.completionTime) - Date.parse(res.status.startTime)) / 1000)
      fields.push({ key: 'dur', label: 'Duration', value: `${dur}s` })
    }
    const jobOwner = ownerRefField(res)
    if (jobOwner) fields.push(jobOwner)
  } else if (res.kind === 'ReplicaSet') {
    const desired = res.spec?.replicas ?? 0
    const ready = res.status?.readyReplicas ?? 0
    const current = res.status?.replicas ?? 0
    fields.push({ key: 'desired', label: 'Desired', value: String(desired) })
    fields.push({ key: 'current', label: 'Current', value: String(current) })
    fields.push({ key: 'ready', label: 'Ready', value: String(ready) })
    const rsOwner = ownerRefField(res)
    if (rsOwner) fields.push(rsOwner)
  } else if (res.kind === 'PersistentVolumeClaim') {
    fields.push({ key: 'phase', label: 'Phase', value: res.status?.phase || '-' })
    const cap = res.status?.capacity?.storage || res.spec?.resources?.requests?.storage || '-'
    fields.push({ key: 'cap', label: 'Capacity', value: cap })
    const accessModes = (res.spec?.accessModes || []).join(', ')
    if (accessModes) fields.push({ key: 'access', label: 'Access', value: accessModes })
    if (res.spec?.storageClassName) fields.push({ key: 'sc', label: 'StorageClass', value: res.spec.storageClassName })
    if (res.spec?.volumeName)
      fields.push({
        key: 'vol',
        label: 'Volume',
        value: res.spec.volumeName,
        ref: { kind: 'PersistentVolume', name: res.spec.volumeName },
      })
  } else if (res.kind === 'HorizontalPodAutoscaler') {
    const tgt = res.spec?.scaleTargetRef
    if (tgt?.kind && tgt?.name) {
      fields.push({
        key: 'target',
        label: 'Target',
        value: `${tgt.kind}/${tgt.name}`,
        ref: { kind: tgt.kind, namespace: res.metadata?.namespace, name: tgt.name },
      })
    }
    if (res.spec?.minReplicas !== undefined) fields.push({ key: 'min', label: 'Min', value: String(res.spec.minReplicas) })
    if (res.spec?.maxReplicas !== undefined) fields.push({ key: 'max', label: 'Max', value: String(res.spec.maxReplicas) })
    if (res.status?.currentReplicas !== undefined) fields.push({ key: 'cur', label: 'Replicas', value: String(res.status.currentReplicas) })
  } else if (res.kind === 'Node') {
    const conditions = res.status?.conditions || []
    const ready = conditions.find((c) => c.type === 'Ready')
    const statusText = ready && ready.status === 'True' ? 'Ready' : 'NotReady'
    const statusColor = ready && ready.status === 'True' ? 'text-green' : 'text-red'
    fields.push({ key: 'status', label: 'Status', value: statusText, colorClass: statusColor })
    const labels = res.metadata?.labels || {}
    const roles = Object.keys(labels)
      .filter((k) => k.startsWith('node-role.kubernetes.io/'))
      .map((k) => k.replace('node-role.kubernetes.io/', ''))
    fields.push({ key: 'roles', label: 'Roles', value: roles.length > 0 ? roles.join(',') : '<none>' })
    const addrs = res.status?.addresses || []
    const internalIP = addrs.find((a) => a.type === 'InternalIP')?.address
    if (internalIP) fields.push({ key: 'internalIP', label: 'Internal-IP', value: internalIP })
    const externalIP = addrs.find((a) => a.type === 'ExternalIP')?.address
    if (externalIP) fields.push({ key: 'externalIP', label: 'External-IP', value: externalIP })
    const info = res.status?.nodeInfo || {}
    if (info.osImage) fields.push({ key: 'os', label: 'OS', value: info.osImage })
    if (info.architecture) fields.push({ key: 'arch', label: 'Arch', value: info.architecture })
    if (info.containerRuntimeVersion) fields.push({ key: 'runtime', label: 'Runtime', value: info.containerRuntimeVersion })
    if (info.kernelVersion) fields.push({ key: 'kernel', label: 'Kernel', value: info.kernelVersion })
    const cap = res.status?.capacity || {}
    const nm = nodeMetrics[res.metadata.name]
    if (cap.cpu) fields.push({ key: 'cpu', label: 'CPU Cap', value: cap.cpu })
    if (nm) fields.push({ key: 'cpuUsage', label: 'CPU Usage', value: nm.cpu })
    if (cap.memory) fields.push({ key: 'mem', label: 'Mem Cap', value: cap.memory })
    if (nm) fields.push({ key: 'memUsage', label: 'Mem Usage', value: nm.mem })
    if (res.spec?.podCIDR) fields.push({ key: 'podCIDR', label: 'Pod CIDR', value: res.spec.podCIDR })
  } else {
    // Generic fallback for CRDs and unknown kinds — show top-level spec and status fields
    if (res.apiVersion) fields.push({ key: 'apiVersion', label: 'API Version', value: res.apiVersion })
    if (res.status?.phase) fields.push({ key: 'phase', label: 'Phase', value: res.status.phase })
    if (res.status?.state) fields.push({ key: 'state', label: 'State', value: res.status.state })
    const spec = res.spec || {}
    for (const [k, v] of Object.entries(spec)) {
      if (v === null || v === undefined || typeof v === 'object') continue
      fields.push({ key: `spec-${k}`, label: k.charAt(0).toUpperCase() + k.slice(1), value: String(v) })
    }
  }

  return fields
}

/**
 * Build the supplementary sections (conditions, selectors, labels) for the detail pane.
 * @param {any} res
 */
export function buildDetailSections(res) {
  const sections = []

  const condSection = (conditions) => {
    if (!conditions?.length) return null
    return {
      label: 'Conditions',
      type: 'table',
      columns: ['Type', 'Status', 'Reason'],
      rows: conditions.map((c) => [c.type, c.status, c.reason || '-']),
    }
  }

  if (res.kind === 'Pod') {
    const containers = res.spec?.containers || []
    const cs = res.status?.containerStatuses || []
    if (containers.length) {
      sections.push({
        label: 'Containers',
        type: 'table',
        columns: ['Name', 'Image', 'Ready', 'Restarts'],
        rows: containers.map((c) => {
          const s = cs.find((x) => x.name === c.name)
          return [c.name, c.image, s?.ready ? 'Yes' : 'No', String(s?.restartCount ?? 0)]
        }),
      })
    }
    const cond = condSection(res.status?.conditions)
    if (cond) sections.push(cond)
  } else if (res.kind === 'Deployment' || res.kind === 'StatefulSet') {
    const cond = condSection(res.status?.conditions)
    if (cond) sections.push(cond)
    const selector = res.spec?.selector?.matchLabels || {}
    if (Object.keys(selector).length) {
      sections.push({ label: 'Selector', type: 'kv', pairs: Object.entries(selector).map(([k, v]) => ({ key: k, value: String(v) })) })
    }
  } else if (res.kind === 'Job') {
    const cond = condSection(res.status?.conditions)
    if (cond) sections.push(cond)
  } else if (res.kind === 'Node') {
    const cond = condSection(res.status?.conditions)
    if (cond) sections.push(cond)
  } else if (res.kind === 'Service') {
    const selector = res.spec?.selector || {}
    if (Object.keys(selector).length) {
      sections.push({ label: 'Selector', type: 'kv', pairs: Object.entries(selector).map(([k, v]) => ({ key: k, value: String(v) })) })
    }
  }

  const labels = res.metadata?.labels || {}
  if (Object.keys(labels).length) {
    sections.push({ label: 'Labels', type: 'kv', pairs: Object.entries(labels).map(([k, v]) => ({ key: k, value: String(v) })) })
  }

  return sections
}

/**
 * Look up events for a resource from the shared cache and format them for the detail pane.
 * @param {any} res
 */
export function getResourceEvents(res) {
  return getEventsForResource(res.metadata.uid).map((ev) => ({
    uid: ev.metadata.uid,
    type: ev.type || 'Normal',
    reason: ev.reason || '',
    message: ev.message || '',
    age: ageFrom(getTimestamp(ev)),
  }))
}
