//@ts-check

// ==========================================================================================
// Pure formatters: HTML escaping, Kubernetes CPU/memory parsing and display, age/duration
// ==========================================================================================

// Escape HTML entities for safe innerHTML insertion
export const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Parse CPU quantity to nanocores for summing across containers
export function parseCPUNano(val) {
  if (val.endsWith('n')) return parseInt(val)
  if (val.endsWith('u')) return parseInt(val) * 1e3
  if (val.endsWith('m')) return parseInt(val) * 1e6
  return parseFloat(val) * 1e9
}

// Parse memory quantity to bytes for summing across containers
export function parseMemBytes(val) {
  if (val.endsWith('Ki')) return parseInt(val) * 1024
  if (val.endsWith('Mi')) return parseInt(val) * 1024 * 1024
  if (val.endsWith('Gi')) return parseInt(val) * 1024 * 1024 * 1024
  return parseInt(val)
}

// Format a Kubernetes CPU quantity (e.g. "250000000n" → "250m", "1" → "1000m")
export function formatCPU(val) {
  if (!val) return '—'
  if (val.endsWith('n')) return Math.round(parseInt(val) / 1e6) + 'm'
  if (val.endsWith('u')) return Math.round(parseInt(val) / 1e3) + 'm'
  if (val.endsWith('m')) return val
  return Math.round(parseFloat(val) * 1000) + 'm'
}

// Format a Kubernetes memory quantity (e.g. "131072Ki" → "128Mi", "134217728" → "128Mi")
export function formatMemory(val) {
  if (!val) return '—'
  let bytes
  if (val.endsWith('Ki')) bytes = parseInt(val) * 1024
  else if (val.endsWith('Mi')) bytes = parseInt(val) * 1024 * 1024
  else if (val.endsWith('Gi')) bytes = parseInt(val) * 1024 * 1024 * 1024
  else bytes = parseInt(val)
  const mi = bytes / (1024 * 1024)
  if (mi >= 1024) return (mi / 1024).toFixed(1) + 'Gi'
  return Math.round(mi) + 'Mi'
}

// Returns a human-readable duration from milliseconds
export function humanDuration(ms) {
  if (ms < 0) ms = 0
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d`
}

// Returns a human-readable age string from an ISO 8601 timestamp
export function ageFrom(timestamp) {
  if (!timestamp) return '-'
  const ms = Date.now() - new Date(timestamp).getTime()
  return humanDuration(ms)
}
