//@ts-check

import { ALL_NAMESPACES } from './constants.js'

// ==========================================================================================
// Vim-style command palette — pure helpers (state lives on the Alpine component
// so HTML x-model / x-show bindings continue to work).
// ==========================================================================================

/**
 * Build the filtered suggestion list for the palette.
 *
 * @param {string} input - current palette input
 * @param {object} ctx
 * @param {string[] | null} ctx.namespaces
 * @param {string[]} ctx.contexts
 * @param {{label: string, kinds: string[]}[]} ctx.resourceGroups
 * @returns {{cmd: string, label: string}[]}
 */
export function buildSuggestions(input, { namespaces, contexts, resourceGroups }) {
  // Check meta-command prefixes on the untrimmed input so that "ns " /
  // "ctx " (trailing-space state — e.g. after Tab completion or the
  // clickable status-bar buttons) shows the full list immediately.
  const raw = String(input || '').toLowerCase()

  // :ns <namespace>
  if (raw.startsWith('ns ')) {
    const query = raw.slice(3).trim()
    // Pseudo-entry for cross-namespace mode — typed as "all", maps to the sentinel.
    const items = ['all', ...(namespaces || [])]
    return items
      .filter((ns) => !query || ns.toLowerCase().includes(query))
      .slice(0, 10)
      .map((ns) => ({ cmd: `ns ${ns}`, label: `ns  ${ns}` }))
  }

  // :ctx <context>
  if (raw.startsWith('ctx ')) {
    const query = raw.slice(4).trim()
    return contexts
      .filter((ctx) => !query || ctx.toLowerCase().includes(query))
      .slice(0, 10)
      .map((ctx) => ({ cmd: `ctx ${ctx}`, label: `ctx  ${ctx}` }))
  }

  const q = raw.trim()

  const results = []

  // Meta-command prefixes
  if (!q || 'ns'.startsWith(q)) results.push({ cmd: 'ns ', label: 'ns  <namespace>' })
  if (contexts.length > 1 && (!q || 'ctx'.startsWith(q))) results.push({ cmd: 'ctx ', label: 'ctx  <context>' })

  // Action commands
  if (!q || 'refresh'.startsWith(q)) results.push({ cmd: 'refresh', label: 'refresh' })
  if (!q || 'events'.startsWith(q)) results.push({ cmd: 'events', label: 'events  (open dialog)' })
  if (!q || 'cfg'.startsWith(q)) results.push({ cmd: 'cfg', label: 'cfg  (settings)' })
  if (!q || 'pause'.startsWith(q)) results.push({ cmd: 'pause', label: 'pause  (toggle SSE)' })

  // Kind jump — all sidebar kinds, case-insensitive partial match
  const allKinds = resourceGroups.flatMap((g) => g.kinds)
  for (const kind of allKinds) {
    if (!q || kind.toLowerCase().includes(q)) results.push({ cmd: kind.toLowerCase(), label: kind })
  }

  return results.slice(0, 10)
}

/**
 * Parse a command string into an actionable descriptor.
 * Returns `null` when the input is empty.
 *
 * @param {string} input
 * @param {object} ctx
 * @param {string[] | null} ctx.namespaces
 * @param {string[]} ctx.contexts
 * @param {{label: string, kinds: string[]}[]} ctx.resourceGroups
 * @returns {{type: 'ns'|'ctx'|'kind'|'action', arg: string} | null}
 */
export function parseCommand(input, { namespaces, contexts, resourceGroups }) {
  const trimmed = String(input || '').trim()
  if (!trimmed) return null

  const parts = trimmed.split(/\s+/)
  const cmd = parts[0].toLowerCase()

  if (cmd === 'ns') {
    const query = parts[1]
    if (!query) return null
    if (query === 'all' || query === ALL_NAMESPACES) return { type: 'ns', arg: ALL_NAMESPACES }
    const ns = (namespaces || []).find((n) => n === query) || (namespaces || []).find((n) => n.startsWith(query))
    return ns ? { type: 'ns', arg: ns } : null
  }

  if (cmd === 'ctx') {
    const query = parts[1]
    if (!query) return null
    const ctx = contexts.find((c) => c === query) || contexts.find((c) => c.startsWith(query))
    return ctx ? { type: 'ctx', arg: ctx } : null
  }

  if (cmd === 'refresh' || cmd === 'events' || cmd === 'cfg' || cmd === 'pause') {
    return { type: 'action', arg: cmd }
  }

  // Kind jump — exact match first, then prefix match
  const allKinds = resourceGroups.flatMap((g) => g.kinds)
  const exact = allKinds.find((k) => k.toLowerCase() === cmd)
  if (exact) return { type: 'kind', arg: exact }

  const prefix = allKinds.find((k) => k.toLowerCase().startsWith(cmd))
  if (prefix) return { type: 'kind', arg: prefix }

  return null
}
