//@ts-check

// ==========================================================================================
// Table rendering and live row management for KubeAtlas table UI
// ==========================================================================================

import { columnsForKind, setMetricsData, setNodeMetricsData, setShowNamespaceColumn } from './columns.js'
import { statusClass } from './status.js'
import { log } from './log.js'

const slog = log.ns('table')

// Re-export for external callers so main.js keeps one import surface
export { setMetricsData, setNodeMetricsData, setShowNamespaceColumn }
export { podDetailedStatus } from './status.js'
export { ageFrom } from './formatters.js'

// ── Module state ──────────────────────────────────────────────────────────────

/** @type {string} Currently displayed kind */
let currentKind = ''
/** @type {Map<string, any>} uid → resource */
const rowData = new Map()
/** @type {string} Search filter */
let searchFilter = ''
/** @type {((res: any) => void) | null} Row select callback */
let onRowSelect = null
/** @type {string | null} Currently selected uid */
let selectedUid = null
/** @type {((res: any) => boolean) | null} Active filter for drill-down views */
let currentFilter = null
/** @type {((res: any) => void) | null} Drill-down callback */
let onDrillDown = null
/** @type {((ref: {kind: string, namespace?: string, name: string}) => void) | null} Cell cross-reference click callback */
let onRefClick = null

/** Kinds that have children and show the drill-down › icon */
let drillableKinds = new Set()

/**
 * Set which kinds show the drill-down › icon (called from main.js to avoid circular imports)
 * @param {Set<string>} kinds
 */
export function setDrillableKinds(kinds) {
  drillableKinds = kinds
}

/**
 * Set the callback invoked when a non-drillable row is selected
 * @param {(res: any) => void} cb
 */
export function setRowSelectHandler(cb) {
  onRowSelect = cb
}

/**
 * Returns the currently selected resource, or null if none selected
 * @returns {any | null}
 */
export function getSelectedResource() {
  return selectedUid ? rowData.get(selectedUid) : null
}

/**
 * Set the callback invoked when the drill-down › icon is clicked
 * @param {(res: any) => void} cb
 */
export function setDrillDownHandler(cb) {
  onDrillDown = cb
}

/**
 * Set the callback invoked when a clickable cross-reference cell is clicked.
 * @param {(ref: {kind: string, namespace?: string, name: string}) => void} cb
 */
export function setRefClickHandler(cb) {
  onRefClick = cb
}

/**
 * Set the search filter and re-render the table
 * @param {string} q
 */
export function setSearchFilter(q) {
  searchFilter = q.trim().toLowerCase()
  renderRows()
}

/**
 * Render the entire table for a given kind using cached rows
 * @param {string} kind
 * @param {any[]} resources
 * @param {((res: any) => boolean) | null} filterFn - optional filter for drill-down views (applied to SSE events)
 */
export function renderTable(kind, resources, filterFn = null) {
  currentKind = kind
  currentFilter = filterFn
  selectedUid = null
  rowData.clear()
  for (const r of resources) {
    rowData.set(r.metadata.uid, r)
  }
  _buildTableDOM()
  renderRows()
}

/**
 * Add or update a row (called on SSE add/update events)
 * @param {any} res
 */
export function upsertRow(res) {
  if (res.kind !== currentKind) return
  if (currentFilter && !currentFilter(res)) return
  rowData.set(res.metadata.uid, res)
  const existing = document.getElementById(`row-${res.metadata.uid}`)
  if (existing) {
    _updateRowEl(existing, res)
  } else {
    const tbody = document.querySelector('#resourceTable tbody')
    if (!tbody) return
    const tr = _createRowEl(res)
    tbody.appendChild(tr)
    if (searchFilter) {
      const text = Array.from(tr.querySelectorAll('td'))
        .map((td) => td.textContent?.toLowerCase() || '')
        .join(' ')
      if (!text.includes(searchFilter)) tr.style.display = 'none'
    }
  }
}

/**
 * Remove a row by uid
 * @param {string} uid
 */
export function removeRow(uid) {
  rowData.delete(uid)
  if (selectedUid === uid) {
    selectedUid = null
    window.dispatchEvent(new CustomEvent('closePanel'))
  }
  const el = document.getElementById(`row-${uid}`)
  if (el) el.remove()
  _showEmptyIfNeeded()
}

/**
 * Mark a row as selected (highlight it)
 * @param {string} uid
 */
export function selectRow(uid) {
  if (selectedUid) {
    const prev = document.getElementById(`row-${selectedUid}`)
    if (prev) prev.classList.remove('is-selected')
  }
  selectedUid = uid
  const el = document.getElementById(`row-${uid}`)
  if (el) {
    el.classList.add('is-selected')
    el.scrollIntoView({ block: 'nearest' })
  }
}

/**
 * Move selection up (-1) or down (+1) among visible rows, firing onRowSelect.
 * @param {number} direction -1 or 1
 */
export function navigateRow(direction) {
  const rows = /** @type {HTMLTableRowElement[]} */ (Array.from(document.querySelectorAll('#resourceTable tbody tr:not([style*="display: none"])')))
  if (rows.length === 0) return

  const currentIndex = selectedUid ? rows.findIndex((r) => r.id === `row-${selectedUid}`) : -1
  const nextIndex = currentIndex < 0 ? (direction > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, currentIndex + direction))

  if (nextIndex === currentIndex && currentIndex >= 0) return

  const nextRow = rows[nextIndex]
  const uid = nextRow.id.replace('row-', '')
  const res = rowData.get(uid)
  if (!res) return

  selectRow(uid)
  if (onRowSelect) onRowSelect(res)
}

/**
 * Re-render age cells for all visible rows (call on a 60s interval).
 */
export function refreshAges() {
  const cols = columnsForKind(currentKind)
  document.querySelectorAll('#resourceTable tbody tr').forEach((tr) => {
    const uid = tr.id.replace('row-', '')
    const res = rowData.get(uid)
    if (!res) return
    const tds = tr.querySelectorAll('td')
    cols.forEach((col, i) => {
      if (col.key === 'age' && tds[i]) tds[i].textContent = col.getValue(res)
    })
  })
}

/**
 * Update only CPU/Memory cells in-place (called after metrics refresh).
 * Preserves selection, scroll, and all other row state.
 */
export function refreshMetricsColumns() {
  if (currentKind !== 'Pod' && currentKind !== 'Node') return
  const cols = columnsForKind(currentKind)
  document.querySelectorAll('#resourceTable tbody tr').forEach((tr) => {
    const uid = tr.id.replace('row-', '')
    const res = rowData.get(uid)
    if (!res) return
    const tds = tr.querySelectorAll('td')
    cols.forEach((col, i) => {
      if ((col.key === 'cpu' || col.key === 'mem') && tds[i]) tds[i].textContent = col.getValue(res)
    })
  })
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _buildTableDOM() {
  const container = document.getElementById('tableContent')
  if (!container) {
    // Expected during bootstrap: HTML fragments load on DOMContentLoaded
    // (loader.js), so the first renderTable() call from the namespace fetch
    // can arrive before the table container exists. Subsequent SSE upserts
    // re-trigger render once the fragment is in. Debug-level so a true
    // contract break (fragment never loads) still shows when LOG_LEVEL=debug.
    slog.debug('#tableContent not yet in DOM; skipping render', { kind: currentKind })
    return
  }

  const cols = columnsForKind(currentKind)

  const table = document.createElement('table')
  table.className = 'resource-table'
  table.id = 'resourceTable'

  const thead = document.createElement('thead')
  const headerRow = document.createElement('tr')
  for (const col of cols) {
    const th = document.createElement('th')
    th.textContent = col.label
    th.dataset.col = col.key
    headerRow.appendChild(th)
  }
  thead.appendChild(headerRow)
  table.appendChild(thead)

  const tbody = document.createElement('tbody')
  table.appendChild(tbody)

  container.innerHTML = ''
  container.appendChild(table)
}

function renderRows() {
  const tbody = document.querySelector('#resourceTable tbody')
  if (!tbody) return

  tbody.innerHTML = ''

  for (const res of rowData.values()) {
    const tr = _createRowEl(res)
    tbody.appendChild(tr)
  }

  _applySearch()
  _showEmptyIfNeeded()
}

/**
 * Render a single cell (used by both create and update paths). If the
 * column exposes `getRef` and returns a non-null ref, the cell is
 * replaced with a clickable button that dispatches to the app's
 * cross-reference handler. Otherwise falls back to the textContent
 * render path.
 * @param {HTMLElement} td
 * @param {any} col
 * @param {any} res
 */
function _renderCell(td, col, res) {
  // Clear any prior color classes that getClass may have applied so we
  // don't leak them across updates.
  td.classList.remove('text-green', 'text-yellow', 'text-red', 'text-blue', 'text-grey')
  td.textContent = ''
  const ref = col.getRef ? col.getRef(res) : null
  const value = col.getValue(res)
  if (ref && ref.kind && ref.name) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'cell-ref is-clickable'
    btn.textContent = value
    btn.title = `Go to ${ref.kind} ${ref.name}`
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (onRefClick) onRefClick(ref)
    })
    td.appendChild(btn)
  } else {
    td.textContent = value
  }
  if (col.getClass) {
    td.classList.add(col.getClass(res))
  }
}

/**
 * @param {any} res
 * @returns {HTMLTableRowElement}
 */
function _createRowEl(res) {
  const cols = columnsForKind(currentKind)
  const tr = document.createElement('tr')
  tr.id = `row-${res.metadata.uid}`
  tr.className = statusClass(res)

  if (res.metadata.uid === selectedUid) {
    tr.classList.add('is-selected')
  }

  for (let i = 0; i < cols.length; i++) {
    const td = document.createElement('td')
    if (i === 0) td.className = 'name-col'
    _renderCell(td, cols[i], res)
    tr.appendChild(td)
  }

  const isDrillable = onDrillDown && drillableKinds.has(currentKind)
  if (isDrillable) tr.classList.add('is-drillable')

  tr.addEventListener('click', (e) => {
    e.stopPropagation()
    selectRow(res.metadata.uid)
    if (onRowSelect) onRowSelect(res)
  })

  if (isDrillable) {
    tr.addEventListener('dblclick', (e) => {
      e.stopPropagation()
      onDrillDown(res)
    })
  }

  return tr
}

/**
 * @param {HTMLElement} tr
 * @param {any} res
 */
function _updateRowEl(tr, res) {
  const cols = columnsForKind(currentKind)
  const tds = tr.querySelectorAll('td')
  for (let i = 0; i < cols.length; i++) {
    if (tds[i]) {
      _renderCell(/** @type {HTMLElement} */ (tds[i]), cols[i], res)
    }
  }

  // Update status class
  tr.classList.remove('status-green', 'status-yellow', 'status-red', 'status-blue', 'status-grey')
  tr.classList.add(statusClass(res))
}

function _applySearch() {
  if (!searchFilter) {
    document.querySelectorAll('#resourceTable tbody tr').forEach((tr) => {
      const row = /** @type {HTMLElement} */ (tr)
      row.style.display = ''
    })
    return
  }

  document.querySelectorAll('#resourceTable tbody tr').forEach((tr) => {
    const row = /** @type {HTMLElement} */ (tr)
    const text = Array.from(row.querySelectorAll('td'))
      .map((td) => td.textContent?.toLowerCase() || '')
      .join(' ')
    row.style.display = text.includes(searchFilter) ? '' : 'none'
  })
}

function _showEmptyIfNeeded() {
  const container = document.getElementById('tableContent')
  if (!container) return
  const visibleRows = container.querySelectorAll('#resourceTable tbody tr:not([style*="display: none"])')
  let empty = container.querySelector('.empty-state')

  if (visibleRows.length === 0 && rowData.size === 0) {
    if (!empty) {
      empty = document.createElement('div')
      empty.className = 'empty-state'
      empty.textContent = `No ${currentKind}s found in this namespace`
      container.appendChild(empty)
      slog.info('empty state', { kind: currentKind })
    }
  } else {
    if (empty) empty.remove()
  }
}
