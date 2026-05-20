//@ts-check

// ==========================================================================================
// Kubernetes resource status detection (text + CSS color class)
// ==========================================================================================

/**
 * @param {any} r Kubernetes Pod resource
 * @returns {{ text: string, colorClass: string }}
 */
export function podDetailedStatus(r) {
  // A pod with a deletionTimestamp is being torn down — kubectl reports this
  // as "Terminating" regardless of phase/container state (a pod stuck on a
  // finalizer stays Running by phase but is really Terminating). Check first.
  if (r.metadata?.deletionTimestamp) {
    return { text: 'Terminating', colorClass: 'text-yellow' }
  }

  const containerStatuses = r.status?.containerStatuses || []

  for (const cs of containerStatuses) {
    const reason = cs.state?.waiting?.reason
    if (reason && reason !== 'ContainerCreating') {
      return { text: reason, colorClass: 'text-red' }
    }
  }

  for (const cs of containerStatuses) {
    const reason = cs.state?.terminated?.reason
    if (reason === 'OOMKilled' || reason === 'Error') {
      return { text: reason, colorClass: 'text-red' }
    }
    if (reason === 'Completed') {
      return { text: reason, colorClass: 'text-blue' }
    }
  }

  const phase = r.status?.phase || 'Unknown'
  switch (phase) {
    case 'Running': {
      const allReady = containerStatuses.every((c) => c.ready)
      return allReady ? { text: 'Running', colorClass: 'text-green' } : { text: 'Running', colorClass: 'text-yellow' }
    }
    case 'Pending':
      return { text: 'Pending', colorClass: 'text-yellow' }
    case 'Succeeded':
      return { text: 'Succeeded', colorClass: 'text-blue' }
    case 'Failed':
      return { text: 'Failed', colorClass: 'text-red' }
    default:
      return { text: phase, colorClass: 'text-grey' }
  }
}

/**
 * Returns a CSS status class based on Kubernetes resource status
 * @param {any} res Kubernetes resource object
 * @returns {string} CSS class name
 */
export function statusClass(res) {
  const kind = res.kind
  const status = res.status || {}
  const spec = res.spec || {}

  if (kind === 'Pod') {
    const { colorClass } = podDetailedStatus(res)
    if (colorClass === 'text-red') return 'status-red'
    if (colorClass === 'text-yellow') return 'status-yellow'
    if (colorClass === 'text-blue') return 'status-blue'
    if (colorClass === 'text-green') return 'status-green'
    return 'status-grey'
  }

  if (kind === 'Deployment') {
    const desired = spec.replicas ?? 1
    const ready = status.readyReplicas ?? 0
    return ready >= desired ? 'status-green' : 'status-yellow'
  }

  if (kind === 'ReplicaSet') {
    const desired = spec.replicas ?? 0
    const ready = status.readyReplicas ?? 0
    return desired === 0 ? 'status-grey' : ready >= desired ? 'status-green' : 'status-yellow'
  }

  if (kind === 'StatefulSet') {
    const desired = spec.replicas ?? 1
    const ready = status.readyReplicas ?? 0
    return ready >= desired ? 'status-green' : 'status-yellow'
  }

  if (kind === 'DaemonSet') {
    const desired = status.desiredNumberScheduled ?? 0
    const ready = status.numberReady ?? 0
    return ready >= desired ? 'status-green' : 'status-yellow'
  }

  if (kind === 'Job') {
    if (status.succeeded && status.succeeded > 0) return 'status-green'
    if (status.failed && status.failed > 0) return 'status-red'
    return 'status-yellow'
  }

  if (kind === 'CronJob') return 'status-blue'

  if (kind === 'Service') return 'status-blue'

  if (kind === 'Ingress') return 'status-blue'

  if (kind === 'PersistentVolumeClaim') {
    return status.phase === 'Bound' ? 'status-green' : 'status-yellow'
  }

  if (kind === 'Node') {
    const conditions = status.conditions || []
    const ready = conditions.find((c) => c.type === 'Ready')
    return ready && ready.status === 'True' ? 'status-green' : 'status-red'
  }

  return 'status-grey'
}
