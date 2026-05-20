//@ts-check

// ==========================================================================================
// User-facing surface for log-buffer errors and warnings.
//
// log.js dispatches `kubeatlas:log` window events for every entry at warn or
// error level. This module wires them into:
//
//   1. A toast on `error` (rate-limited per message, so a repeating canary
//      can't flood the screen).
//   2. A persistent floating badge bottom-right that shows unread error/warn
//      counts. Click → slide-up panel with the last ~50 entries (timestamp,
//      namespace, message) plus a "Download log" button that delegates to
//      `kaLog.download()`.
//
// Backend errors that affect a user action already surface through
// `mainApp.showError(...)`. This component closes the gap for frontend-only
// signals (window.error, slow-fetch warns, graph processLinks errors,
// large-resource-count warnings, etc.) that previously only lived in the
// in-memory ring buffer.
// ==========================================================================================

import { showToast } from '../ext/toast.js'

const LEVEL_CLASSES = { 30: 'lui-warn', 40: 'lui-error' }
const RECENT_CAP = 50
const TOAST_DEDUP_WINDOW_MS = 5000

const _styles = `
.lui-badge {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 60;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: #2a2a2a;
  border: 1px solid #3a3a3a;
  border-radius: 999px;
  color: #e6e6e6;
  font-size: 0.85rem;
  font-family: system-ui, sans-serif;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  user-select: none;
  transition: opacity 0.2s ease;
}
.lui-badge:hover { opacity: 0.85; }
.lui-badge.lui-hidden { display: none; }
.lui-badge .lui-count-err { color: #ff6b6b; font-weight: 600; }
.lui-badge .lui-count-warn { color: #f5a623; font-weight: 600; }
.lui-badge .lui-count-zero { color: #6a6a6a; }
.lui-panel {
  position: fixed;
  right: 16px;
  bottom: 60px;
  z-index: 60;
  width: 480px;
  max-width: calc(100vw - 32px);
  max-height: 60vh;
  background: #1f1f1f;
  border: 1px solid #3a3a3a;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  font-family: system-ui, sans-serif;
  color: #e6e6e6;
}
.lui-panel.lui-hidden { display: none; }
.lui-panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid #3a3a3a;
  font-size: 0.9rem;
  font-weight: 600;
}
.lui-panel-head button {
  background: transparent;
  border: 1px solid #3a3a3a;
  border-radius: 4px;
  color: #e6e6e6;
  padding: 3px 8px;
  font-size: 0.8rem;
  cursor: pointer;
  margin-left: 6px;
}
.lui-panel-head button:hover { background: #2a2a2a; }
.lui-list {
  overflow-y: auto;
  padding: 4px 0;
}
.lui-entry {
  display: grid;
  grid-template-columns: 70px 70px 1fr;
  gap: 8px;
  padding: 6px 14px;
  font-size: 0.78rem;
  border-bottom: 1px solid #2a2a2a;
  font-family: ui-monospace, monospace;
}
.lui-entry:last-child { border-bottom: none; }
.lui-entry-time { color: #888; }
.lui-entry-ns { color: #aaa; }
.lui-warn .lui-entry-msg { color: #f5a623; }
.lui-error .lui-entry-msg { color: #ff6b6b; }
.lui-empty {
  padding: 20px;
  text-align: center;
  color: #6a6a6a;
  font-size: 0.85rem;
}
`

let _badgeEl = null
let _panelEl = null
let _listEl = null
let _countErrEl = null
let _countWarnEl = null
const _recent = [] // newest first
let _unreadErr = 0
let _unreadWarn = 0
let _open = false
const _lastToastAt = new Map() // dedup key → timestamp

function _ts(t) {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function _renderCounts() {
  if (!_countErrEl || !_countWarnEl) return
  _countErrEl.textContent = `${_unreadErr} err`
  _countErrEl.className = _unreadErr > 0 ? 'lui-count-err' : 'lui-count-zero'
  _countWarnEl.textContent = `${_unreadWarn} warn`
  _countWarnEl.className = _unreadWarn > 0 ? 'lui-count-warn' : 'lui-count-zero'
  // Hide the badge entirely when nothing's pending and the panel is closed.
  if (_unreadErr === 0 && _unreadWarn === 0 && !_open) {
    _badgeEl.classList.add('lui-hidden')
  } else {
    _badgeEl.classList.remove('lui-hidden')
  }
}

function _renderList() {
  if (!_listEl) return
  if (_recent.length === 0) {
    _listEl.innerHTML = '<div class="lui-empty">No warnings or errors yet.</div>'
    return
  }
  _listEl.innerHTML = _recent
    .map((e) => {
      const cls = LEVEL_CLASSES[e.level] || ''
      const argSummary = e.args && e.args.length ? ' ' + _stringifyArgs(e.args) : ''
      return `<div class="lui-entry ${cls}"><span class="lui-entry-time">${_ts(e.t)}</span><span class="lui-entry-ns">[${e.ns || ''}]</span><span class="lui-entry-msg">${_escape(e.msg + argSummary)}</span></div>`
    })
    .join('')
}

function _escape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function _stringifyArgs(args) {
  try {
    return args
      .map((a) => {
        if (a instanceof Error) return a.message
        if (typeof a === 'object') return JSON.stringify(a)
        return String(a)
      })
      .join(' ')
  } catch (_e) {
    return ''
  }
}

function _onLogEntry(ev) {
  const entry = ev.detail
  if (!entry || (entry.level !== 30 && entry.level !== 40)) return

  // Push to recent (newest first), cap at RECENT_CAP
  _recent.unshift(entry)
  if (_recent.length > RECENT_CAP) _recent.length = RECENT_CAP

  if (!_open) {
    if (entry.level === 40) _unreadErr++
    else _unreadWarn++
  }
  _renderCounts()
  if (_open) _renderList()

  // Toast on error only — sustained warn streams (slow sim ticks during
  // heavy load) would otherwise be obnoxious. Dedup by ns+msg so a repeating
  // canary doesn't wallpaper the screen.
  if (entry.level === 40) {
    const key = `${entry.ns}::${entry.msg}`
    const last = _lastToastAt.get(key) || 0
    if (Date.now() - last > TOAST_DEDUP_WINDOW_MS) {
      _lastToastAt.set(key, Date.now())
      const text = `${entry.ns ? `[${entry.ns}] ` : ''}${entry.msg}`
      showToast(text, 4000, 'top-center', 'error')
    }
  }
}

function _toggleOpen() {
  _open = !_open
  if (_open) {
    _unreadErr = 0
    _unreadWarn = 0
    _panelEl.classList.remove('lui-hidden')
    _renderList()
  } else {
    _panelEl.classList.add('lui-hidden')
  }
  _renderCounts()
}

function _build() {
  const styleEl = document.createElement('style')
  styleEl.textContent = _styles
  document.head.appendChild(styleEl)

  _badgeEl = document.createElement('div')
  _badgeEl.className = 'lui-badge lui-hidden'
  _badgeEl.title = 'Click to view recent warnings and errors'
  _badgeEl.innerHTML = `<span class="lui-icon">⚠️</span><span class="lui-count-err"></span><span class="lui-count-warn"></span>`
  _countErrEl = _badgeEl.querySelector('.lui-count-err')
  _countWarnEl = _badgeEl.querySelector('.lui-count-warn')
  _badgeEl.addEventListener('click', _toggleOpen)
  document.body.appendChild(_badgeEl)

  _panelEl = document.createElement('div')
  _panelEl.className = 'lui-panel lui-hidden'
  _panelEl.innerHTML = `
    <div class="lui-panel-head">
      <span>Recent warnings &amp; errors</span>
      <span>
        <button data-act="download">Download log</button>
        <button data-act="clear">Clear</button>
        <button data-act="close">×</button>
      </span>
    </div>
    <div class="lui-list"></div>
  `
  _listEl = _panelEl.querySelector('.lui-list')
  _panelEl.querySelector('[data-act="download"]').addEventListener('click', () => window.kaLog?.download())
  _panelEl.querySelector('[data-act="clear"]').addEventListener('click', () => {
    _recent.length = 0
    _renderList()
  })
  _panelEl.querySelector('[data-act="close"]').addEventListener('click', _toggleOpen)
  document.body.appendChild(_panelEl)

  window.addEventListener('kubeatlas:log', _onLogEntry)
}

/**
 * Initialise the log UI surface. Idempotent — safe to call twice.
 */
export function initLogUI() {
  if (_badgeEl) return
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _build, { once: true })
  } else {
    _build()
  }
}
