//@ts-check

// ==========================================================================================
// Pod log streaming (ReadableStream) + highlight rendering
// ==========================================================================================

import { escHtml } from './formatters.js'
import { log } from './log.js'

const slog = log.ns('logs')

/**
 * Stream pod logs line-by-line. Resolves when the stream completes or is aborted.
 *
 * @param {object} opts
 * @param {string} opts.namespace
 * @param {string} opts.pod
 * @param {string} [opts.container]
 * @param {boolean} [opts.follow]
 * @param {boolean} [opts.previous]
 * @param {boolean} [opts.timestamps]
 * @param {AbortSignal} opts.signal
 * @param {(line: string) => void} opts.onLine - called for each completed line (including the trailing partial on close)
 */
export async function streamPodLogs({ namespace, pod, container, follow, previous, timestamps, signal, onLine }) {
  const params = new URLSearchParams({ max: '300' })
  if (follow) params.set('follow', 'true')
  if (container) params.set('container', container)
  if (previous) params.set('previous', 'true')
  if (timestamps) params.set('timestamps', 'true')

  slog.debug('start stream', { namespace, pod, container, follow: !!follow, previous: !!previous })

  const r = await fetch(`api/logs/${namespace}/${pod}?${params}`, { signal })
  if (!r.ok) {
    slog.warn('💥 log stream HTTP non-ok', { status: r.status, statusText: r.statusText, namespace, pod })
    throw new Error(`HTTP ${r.status}: ${r.statusText}`)
  }

  let partial = ''
  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  while (true) {
    let chunk
    try {
      chunk = await reader.read()
    } catch (err) {
      // Mid-stream network drop or upstream abort. The outer caller already
      // handled the initial HTTP 200; without this log we'd never know why
      // the live tail just stopped.
      if (err?.name !== 'AbortError') {
        slog.warn('💥 log stream read failed', { namespace, pod, err })
      }
      throw err
    }
    const { done, value } = chunk
    if (done) break
    partial += decoder.decode(value, { stream: true })
    const lines = partial.split('\n')
    partial = lines.pop()
    for (const line of lines) onLine(line)
  }
  if (partial) onLine(partial)
}

/**
 * Render buffered log lines into an element, applying optional search highlight.
 * Returns the number of matches when a search term is provided.
 *
 * @param {HTMLElement} el
 * @param {string[]} lines
 * @param {string} search
 * @returns {number} match count (0 when no search)
 */
export function renderLogLines(el, lines, search) {
  const trimmed = search.trim()
  if (!trimmed) {
    el.innerHTML = lines.map((l) => `<span>${escHtml(l)}</span>`).join('\n')
    el.scrollTop = el.scrollHeight
    return 0
  }
  const re = new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
  let count = 0
  el.innerHTML = lines
    .map((l) => {
      const escaped = escHtml(l)
      const highlighted = escaped.replace(re, (m) => {
        count++
        return `<mark>${m}</mark>`
      })
      return `<span>${highlighted}</span>`
    })
    .join('\n')
  el.scrollTop = el.scrollHeight
  return count
}
