//@ts-check

// ==========================================================================================
// Client-side structured logger — levels, namespaces, ring buffer, error capture.
// Always-on globals on `window.kaLog` (setLevel, getLevel, download, clear, getBuffer).
// Importing this module side-effect: registers global error/unhandledrejection handlers.
// ==========================================================================================

// NB: log.js intentionally does not import config.js — config.js imports
// log (for the saveConfig diff trail), so the reverse import would form a
// top-level cycle that throws at module init in both Node and browsers.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const LEVEL_NAMES = { 10: 'debug', 20: 'info', 30: 'warn', 40: 'error' }
const BUF_CAP = 5000
const STORAGE_KEY = 'kaLogLevel'

const buf = []
let threshold = LEVELS.info

function resolveInitialLevel() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored && LEVELS[stored] != null) return LEVELS[stored]
  } catch (_e) {
    /* private mode / no localStorage */
  }
  return LEVELS.info
}

threshold = resolveInitialLevel()

// Fires once when the ring buffer first reaches capacity. Past that the
// buffer wraps silently — a one-shot warn lets users notice they should
// download before older entries are evicted.
let _bufFullWarned = false
function push(level, ns, msg, args) {
  if (buf.length >= BUF_CAP) {
    buf.shift()
    if (!_bufFullWarned) {
      _bufFullWarned = true
      // We're about to push the wrap warn AND the caller's entry, so drop
      // one more existing entry to keep the buffer at exactly BUF_CAP.
      if (buf.length > 0) buf.shift()
      buf.push({
        t: Date.now(),
        level: LEVELS.warn,
        ns: 'log',
        msg: `🐌 ring buffer reached ${BUF_CAP} entries; older entries now evicted on each push`,
        args: [],
      })
      console.warn(`[log] ring buffer full (${BUF_CAP}); older entries evicting`)
    }
  }
  buf.push({ t: Date.now(), level, ns, msg, args })
}

function emit(levelNum, ns, args) {
  if (levelNum < threshold) return
  const msg = args.length && typeof args[0] === 'string' ? args[0] : ''
  const rest = msg ? args.slice(1) : args
  const entry = { t: Date.now(), level: levelNum, ns, msg, args: rest }
  push(levelNum, ns, msg, rest)

  const prefix = ns ? `[${ns}]` : ''
  const out = msg ? [prefix, msg, ...rest] : [prefix, ...rest]
  if (levelNum >= LEVELS.error) console.error(...out)
  else if (levelNum >= LEVELS.warn) console.warn(...out)
  else if (levelNum >= LEVELS.info) console.log(...out)
  else console.debug(...out)

  // UI bridge: surface warn/error to the badge + toast component (log-ui.js).
  // Below warn we don't dispatch — the buffer already captures everything,
  // and a UI listener for debug/info chatter would constantly fire.
  if (levelNum >= LEVELS.warn) {
    window.dispatchEvent(new CustomEvent('kubeatlas:log', { detail: entry }))
  }
}

function makeNs(ns) {
  return {
    debug: (...a) => emit(LEVELS.debug, ns, a),
    info: (...a) => emit(LEVELS.info, ns, a),
    warn: (...a) => emit(LEVELS.warn, ns, a),
    error: (...a) => emit(LEVELS.error, ns, a),
  }
}

export const log = {
  ns: (name) => makeNs(name || ''),
  debug: (...a) => emit(LEVELS.debug, '', a),
  info: (...a) => emit(LEVELS.info, '', a),
  warn: (...a) => emit(LEVELS.warn, '', a),
  error: (...a) => emit(LEVELS.error, '', a),
}

export const kaLog = {
  setLevel(name) {
    if (LEVELS[name] == null) return
    threshold = LEVELS[name]
    try {
      localStorage.setItem(STORAGE_KEY, name)
    } catch (_e) {
      /* private mode */
    }
  },
  getLevel() {
    return LEVEL_NAMES[threshold] || 'info'
  },
  getBuffer() {
    return buf.slice()
  },
  clear() {
    buf.length = 0
  },
  download() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '').replace(/-/g, '')
    const blob = new Blob([JSON.stringify(buf, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `kubeatlas-log-${stamp}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  },
}

// Slow-fetch threshold (ms). Above this, timedFetch logs a warn so the buffer
// pins which network call slowed the user's session.
const SLOW_FETCH_MS = 1000

/**
 * Drop-in fetch replacement that times the call and warns if it crosses the
 * slow threshold. Returns the same Response so callers don't need to change
 * downstream parsing. Errors are not swallowed — they propagate.
 *
 * @param {RequestInfo | URL} input
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export async function timedFetch(input, init) {
  const t0 = performance.now()
  const url = typeof input === 'string' ? input : input.url || String(input)
  try {
    const r = await fetch(input, init)
    const ms = Math.round(performance.now() - t0)
    if (ms > SLOW_FETCH_MS) {
      emit(LEVELS.warn, 'fetch', ['🐌 slow fetch', { url, ms, status: r.status }])
    }
    return r
  } catch (err) {
    // Network failures (offline, DNS, CORS) — caller still throws to its own
    // handler, but we tag the failure with timing so "site went unresponsive"
    // reports show the wall-clock pause before the throw.
    const ms = Math.round(performance.now() - t0)
    emit(LEVELS.warn, 'fetch', ['💥 fetch failed', { url, ms, err: err?.message }])
    throw err
  }
}

// Global error capture. Pushes to the ring buffer at error level; the browser
// still surfaces the error in devtools via the natural console path.
window.addEventListener('error', (ev) => {
  push(LEVELS.error, 'window', ev.message || 'window error', [
    {
      filename: ev.filename,
      lineno: ev.lineno,
      colno: ev.colno,
      stack: ev.error && ev.error.stack ? ev.error.stack : undefined,
    },
  ])
})

window.addEventListener('unhandledrejection', (ev) => {
  const reason = ev.reason
  const detail = reason instanceof Error ? { name: reason.name, message: reason.message, stack: reason.stack } : { reason }
  push(LEVELS.error, 'window', 'unhandled promise rejection', [detail])
})

// Expose handles for console + bug-report flows.
window.kaLog = kaLog
// Back-compat alias for muscle memory established during the graph-view debug session.
window._gcDownloadLog = kaLog.download
window._gcClearLog = kaLog.clear
