//@ts-check
/// <reference path="./types/custom.d.ts" />

// ==========================================================================================
// Main JavaScript entry point for KubeAtlas (table-first UI)
// Manages sidebar, resource table, and live SSE updates
// ==========================================================================================
import Alpine from '../ext/alpinejs.esm.min.js'

import { getConfig, saveConfig } from './config.js'
import { getClientId, initEventStreaming, togglePaused } from './events.js'
import { store, clearCache, remove, getResByName } from './cache.js'
import { showToast } from '../ext/toast.js'
import {
  renderTable,
  upsertRow,
  removeRow,
  setRowSelectHandler,
  setRefClickHandler,
  selectRow,
  getSelectedResource,
  navigateRow,
  refreshAges,
  setSearchFilter,
  setDrillDownHandler,
  setDrillableKinds,
  setMetricsData,
  setNodeMetricsData,
  setShowNamespaceColumn,
  refreshMetricsColumns,
} from './table.js'
import eventsDialog from './events-dialog.js'
import { DRILL_DOWN, RESOURCE_GROUPS, CLUSTER_KINDS, ALL_NAMESPACES } from './constants.js'
import { ageFrom, parseCPUNano, parseMemBytes, formatCPU, formatMemory } from './formatters.js'
import { buildDetailFields, buildDetailSections, getResourceEvents } from './detail-fields.js'
import { streamPodLogs, renderLogLines } from './logs-stream.js'
import { iconForKind, iconAction } from './icons.js'
import { createExecClient } from './exec-client.js'
import { buildSuggestions, parseCommand } from './command-palette.js'
import {
  initGraph as _initGraph,
  getGraph,
  destroyGraph,
  addResource as graphAddResource,
  updateResource as graphUpdateResource,
  removeResource as graphRemoveResource,
  replayResources as graphReplayResources,
  setOnNodeClick as graphSetOnNodeClick,
  setOnBackgroundClick as graphSetOnBackgroundClick,
  setOnStatsChange as graphSetOnStatsChange,
  setIconOverlay as graphSetIconOverlay,
  setSimParams as graphSetSimParams,
  setRevealStyle as graphSetRevealStyle,
  SIM_DEFAULTS as GRAPH_SIM_DEFAULTS,
  REVEAL_STYLE_NAMES as GRAPH_REVEAL_STYLES,
  fitToVisible,
  focusByDepth,
  nodeVisByLabel,
  setKindVisibility,
  setNamespaceVisibility,
  setHealthFilter,
} from './graph-canvas.js'
import { statusClass } from './status.js'
import { log, timedFetch } from './log.js'
import { initLogUI } from './log-ui.js'

const slog = log.ns('app')

initLogUI()

// Set up the event streaming for live updates once the DOM is loaded
window.addEventListener('DOMContentLoaded', () => {
  initEventStreaming()
})

// Communicate between different KubeAtlas tabs open at once
export const channel = new BroadcastChannel('kubeatlas')

// Alpine.js component for the main application
Alpine.data('mainApp', () => ({
  // ===== Application state ================================
  errorMessage: '',
  errorDetails: '',
  /** @type {string[] | null} */
  namespaces: null,
  namespace: '',
  /** Active visual theme — mirrors `data-theme` on <html>. Initial value
   *  is whatever the no-flicker boot script in index.html resolved. */
  theme: document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
  showWelcome: true,
  isLoading: false,
  showConfigDialog: false,
  configTab: 1,
  cfg: getConfig(),
  searchQuery: '',
  searchOpen: false,
  showEventsDialog: false,
  connState: 'connecting',
  // Coalesced SSE-change indicator. Only these reactive fields are bound in
  // the status bar; they're recomputed once per second from a plain trailing
  // ring (see _recordSse / the _sseInterval tick) so per-event cost stays
  // O(1) non-reactive even under heavy cluster churn.
  sseActivity: { count: 0, added: 0, updated: 0, removed: 0, pulse: false },
  sidebarPeekOpen: false,
  detailOpen: false,
  // Seed the active tab + per-tab expansion from the persisted config, but
  // only when the matching persistence toggle is on; otherwise fall back
  // to the defaults so an off toggle doesn't silently hydrate stale state.
  detailTab: getConfig().persistDetailTab ? getConfig().detailTab || 'info' : 'info',
  detailExpanded: false,
  detailMoreOpen: false,
  detailHeight: 320,
  _detailResize: null,
  // Table-wrap is hidden only after expand animation completes; kept in sync
  // with detailExpanded for non-animated paths (drag snap, open).
  _detailTableHidden: false,
  _detailAnimating: false,
  // Per-tab expansion preference. `null` = no explicit user choice yet
  // (tab starts collapsed). Set to the chosen value whenever the user
  // toggles expand/collapse manually (button, drag snap). Persisted
  // across refreshes via cfg.detailTabExpanded when
  // persistDetailExpansion is on.
  /** @type {{ info: boolean | null, yaml: boolean | null, events: boolean | null }} */
  _tabExpanded: getConfig().persistDetailExpansion
    ? { ...(getConfig().detailTabExpanded || { info: null, yaml: null, events: null }) }
    : { info: null, yaml: null, events: null },
  delHolding: false,
  delPending: false,
  inLogsView: false,
  inExecView: false,
  inGraphView: false,
  /** @type {string} Graph view search filter (by name) */
  graphSearch: '',
  /** Graph view: BFS depth for focus mode (1..5) */
  graphDepth: getConfig().graphDepth || 2,
  /** Graph view: focus-on-selected enabled */
  graphFocusEnabled: !!getConfig().graphFocusEnabled,
  /** Graph view: show orphan nodes (no edges). Off by default. */
  graphShowOrphans: !!getConfig().graphShowOrphans,
  /** Graph view: overlay official K8s icons on nodes (opt-in) */
  graphIconOverlay: !!getConfig().graphIconOverlay,
  /** Graph view: legend popover open state */
  graphLegendOpen: false,
  /** Graph view: show only unhealthy (red/grey) nodes */
  graphHealthOnly: false,
  /** Graph view: scope to a single namespace ('' = all) */
  graphNsScope: '',
  /** Graph view: namespace list for the scope picker */
  graphNamespaces: [],
  /** Graph view: kinds hidden via legend chips (graph-local, array) */
  graphHiddenKinds: [],
  /** Graph view: sim config panel open state */
  graphConfigOpen: false,
  /** Graph view: live sim params (defaults ← persisted overrides) */
  graphSim: { ...GRAPH_SIM_DEFAULTS, ...(getConfig().graphSim || {}) },
  /** Graph view: open-reveal animation style */
  graphRevealStyle: getConfig().graphRevealStyle || 'bloom',
  /** Stable list of reveal styles for the config <select> */
  graphRevealStyles: GRAPH_REVEAL_STYLES,
  /** Tunable sim sliders: key → [min, max, step, label] */
  graphSimFields: {
    chargeStrength: [-600, -20, 10, 'Charge'],
    linkDistance: [20, 200, 5, 'Link distance'],
    linkStrength: [0.05, 1, 0.05, 'Link strength'],
    collideStrength: [0, 1, 0.05, 'Collide'],
    centerStrength: [0, 0.2, 0.01, 'Center'],
    velocityDecay: [0.1, 0.9, 0.05, 'Friction'],
    clusterStrength: [0, 0.4, 0.01, 'NS clustering'],
  },
  /** Pending focus recompute rAF id — coalesces SSE bursts */
  _graphFocusRaf: null,
  /** Graph status bar: counts + LOD layer + filter summary + selection. */
  graphStats: {
    totalNodes: 0,
    visibleNodes: 0,
    totalEdges: 0,
    visibleEdges: 0,
    namespaces: 0,
    lodLayer: '—', // stub; zoom-driven layers may swap this in later
    filterSummary: '',
    selection: '',
    perfHint: '',
  },
  /** Graph inspector panel. mode 'summary' (cluster-wide) | 'resource'. */
  graphInspect: {
    mode: 'summary',
    kind: '',
    name: '',
    namespace: '',
    /** @type {any|null} */
    resource: null,
    /** @type {any[]} */
    fields: [],
    /** @type {any[]} */
    sections: [],
    /** @type {any[]} */
    events: [],
    /** @type {any} cluster-wide summary when nothing is selected */
    summary: { kinds: [], namespaces: 0, total: 0, unhealthy: 0 },
  },
  /** @type {any | null} */
  execRes: null,
  execContainers: [],
  execContainer: '',
  /** @type {any | null} */
  _execClient: null,
  /** @type {any | null} */
  logsRes: null,
  logContainers: [],
  logContainer: '',
  logPrevious: false,
  logTimestamps: false,
  logSearch: '',
  logMatchCount: 0,
  /** @type {string[]} buffered log lines for search/filter */
  _logLines: [],
  detailData: {
    kind: '',
    name: '',
    namespace: '',
    age: '',
    isPod: false,
    isCluster: false,
    resource: null,
    fields: [],
    sections: [],
    events: [],
    yaml: '',
    yamlLoading: false,
    yamlError: '',
  },
  /** @type {Record<string, string>} */
  _yamlCache: {},
  yamlEditing: false,
  yamlEditContent: '',
  yamlApplying: false,
  yamlApplyError: '',
  metricsAvailable: false,
  /** @type {Record<string, {cpu: string, mem: string}>} */
  podMetrics: {},
  /** @type {Record<string, {cpu: string, mem: string}>} */
  nodeMetrics: {},
  togglePaused,
  connStateClass: 'is-warning',

  /** Sprite href helpers — see public/js/icons.js. Exposed on the
   *  component so templates can bind with :href="iconForKind('Pod')". */
  iconForKind,
  iconAction,

  /** Flip the active theme, persist the choice, update the DOM, and
   *  broadcast a `kaThemeChange` event so non-CSS consumers (the canvas
   *  graph renderer) can rebuild their colour caches. */
  toggleTheme() {
    const next = this.theme === 'dark' ? 'light' : 'dark'
    this.theme = next
    document.documentElement.setAttribute('data-theme', next)
    try {
      localStorage.setItem('kaTheme', next)
    } catch (_) {
      /* storage blocked */
    }
    window.dispatchEvent(new CustomEvent('kaThemeChange', { detail: { theme: next } }))
    slog.info('🎨 theme', { theme: next })
  },

  /** @type {string} Currently selected resource kind */
  selectedKind: '',

  /** @type {{kind: string, name: string, uid: string}[]} Drill-down navigation stack */
  navStack: [],

  /** @type {Record<string, any[]>} kind → resource list, populated after fetch */
  kindData: {},

  /** @type {Record<string, any[]>} kind → resource list for cluster-scoped resources */
  clusterData: {},

  resourceGroups: RESOURCE_GROUPS,
  /** @type {Array<{group: string, version: string, resource: string, kind: string, scope: string}>} */
  crdList: [],
  /** @type {Record<string, {group: string, version: string, resource: string, scope: string}>} CRD kind → GVR info */
  crdMeta: {},

  /** @type {string[]} kubeconfig context names */
  contexts: [],
  /** @type {string} currently active kubeconfig context */
  currentContext: '',

  /** vim-style command palette */
  cmdMode: false,
  cmdInput: '',
  cmdSelectedIdx: -1,

  /** @type {Record<string, string>} */
  serviceMetadata: {
    clusterHost: '',
    version: '',
    buildInfo: '',
  },

  // ===== Functions ============================================

  destroy() {
    this._teardownExec()
    if (this._ageInterval) clearInterval(this._ageInterval)
    if (this._metricsInterval) clearInterval(this._metricsInterval)
    this._cancelPendingDelete()
    if (this._onConnectionStateChange) window.removeEventListener('connectionStateChange', this._onConnectionStateChange)
    if (this._onKubeEvent) window.removeEventListener('kubeEvent', this._onKubeEvent)
    if (this._onClosePanel) window.removeEventListener('closePanel', this._onClosePanel)
    if (this._sseInterval) clearInterval(this._sseInterval)
    if (this._ssePulseTimer) clearTimeout(this._ssePulseTimer)
  },

  // One trailing-window ring (5×1s buckets) of SSE change counts. Per-event
  // work is O(1) and non-reactive (a plain array bump + a one-shot pulse
  // flag), so heavy cluster churn doesn't trigger per-event Alpine renders;
  // the reactive sseActivity fields are refreshed by _sseTick once a second.
  _recordSse(type) {
    const b = this._sseBuckets
    if (!b) return
    const cur = b[this._sseIdx]
    if (type === 'add') cur.a++
    else if (type === 'delete') cur.r++
    else cur.u++
    if (!this.sseActivity.pulse) this.sseActivity.pulse = true
    clearTimeout(this._ssePulseTimer)
    this._ssePulseTimer = setTimeout(() => {
      this.sseActivity.pulse = false
    }, 700)
  },

  _sseTick() {
    const b = this._sseBuckets
    if (!b) return
    // Advance the ring, clearing the slot we're about to reuse → the window
    // decays to 0 on its own when the cluster goes quiet.
    this._sseIdx = (this._sseIdx + 1) % b.length
    b[this._sseIdx] = { a: 0, u: 0, r: 0 }
    let a = 0,
      u = 0,
      r = 0
    for (const k of b) {
      a += k.a
      u += k.u
      r += k.r
    }
    const s = this.sseActivity
    if (s.added !== a || s.updated !== u || s.removed !== r) {
      s.added = a
      s.updated = u
      s.removed = r
      s.count = a + u + r
    }
  },

  async init() {
    slog.info('🚀 Initializing KubeAtlas...')
    slog.info(`🙍 ClientID ${getClientId()}`)

    // Hydrate persisted UI preferences from config
    const initialH = this.cfg.detailHeights?.[this.detailTab]
    if (typeof initialH === 'number') {
      this.detailHeight = initialH
    } else if (typeof this.cfg.detailHeight === 'number') {
      this.detailHeight = this.cfg.detailHeight
    }

    // Listen for BroadcastChannel messages from other tabs
    channel.onmessage = (event) => {
      if (event.data.type === 'namespaceChange') {
        showToast(`Namespace was changed on a different tab<br>you will no longer see live updates here!`, 5000, 'top-center', 'warning')
      }
    }

    // Connection state changes from events.js
    this._onConnectionStateChange = (event) => {
      const newState = /** @type {CustomEvent} */ (event).detail.state
      if (this.connState === 'disconnected' && newState === 'connected') {
        showToast('Reconnected to the server!<br>Resuming live updates', 3000, 'top-center', 'success')
        this.fetchNamespace()
      }
      if (this.connState === 'connected' && newState === 'disconnected') {
        showToast('Disconnected from the server!<br>Live updates are paused', 3000, 'top-center', 'error')
      }
      switch (newState) {
        case 'connecting':
          this.connStateClass = 'is-warning'
          break
        case 'connected':
          this.connStateClass = 'is-success'
          break
        case 'disconnected':
          this.connStateClass = 'is-danger'
          break
        case 'paused':
          this.connStateClass = 'is-grey'
          showToast('Live updates paused', 2000, 'top-center', 'info')
          break
        default:
          this.connStateClass = 'is-warning'
      }
      this.connState = newState
    }
    window.addEventListener('connectionStateChange', this._onConnectionStateChange)

    // Live SSE resource events
    this._onKubeEvent = (event) => {
      const { type, resource } = /** @type {CustomEvent} */ (event).detail
      if (!resource || !resource.kind) {
        slog.warn('💥 kubeEvent dropped (missing kind)', { type, hasResource: !!resource })
        return
      }
      const isCluster = CLUSTER_KINDS.has(resource.kind)
      const dataStore = isCluster ? this.clusterData : this.kindData
      slog.debug('apply event', { type, kind: resource.kind, name: resource.metadata?.name, scope: isCluster ? 'cluster' : 'ns' })
      this._recordSse(type)

      if (type === 'add' || type === 'update') {
        store(resource)
        upsertRow(resource)
        this._updateKindCountIn(dataStore, resource.kind, resource, type)
        if (type === 'update' && this.detailOpen && resource.metadata?.uid === this.detailData.resource?.metadata?.uid) {
          delete this._yamlCache[resource.metadata.uid]
          this._openDetail(resource, { preserveTab: true })
          if (this.detailTab === 'yaml') this._loadYAML()
          // Re-center the graph focus on the updated selection
          this._scheduleGraphFocusRecompute()
        }
        if (this.detailOpen && resource.kind === 'Event' && resource.involvedObject?.uid === this.detailData.resource?.metadata?.uid) {
          this.detailData.events = getResourceEvents(this.detailData.resource)
        }
        // Notify the events dialog so it can update incrementally
        if (resource.kind === 'Event') {
          const evtName = type === 'add' ? 'kubeEventAdded' : 'eventsUpdated'
          window.dispatchEvent(new CustomEvent(evtName, { detail: resource }))
        }
        // Route into the graph if it's live. The d3-force sim runs
        // continuously and absorbs SSE churn — add/update just nudge the
        // sim's alpha back up. No external layout pulse needed.
        if (getGraph()) {
          if (type === 'add') graphAddResource(resource)
          else graphUpdateResource(resource)
          this._scheduleGraphFocusRecompute()
          // Live-refresh the graph inspector when its selected resource
          // changes — mirrors the #detailPane refresh above.
          if (this.inGraphView && this.graphInspect.mode === 'resource' && resource.metadata?.uid === this.graphInspect.resource?.metadata?.uid) {
            this._openGraphInspector(resource)
          }
        }
      } else if (type === 'delete') {
        remove(resource.metadata?.uid)
        removeRow(resource.metadata?.uid)
        this._removeFromDataStore(dataStore, resource.kind, resource.metadata?.uid)
        if (this.detailOpen && resource.metadata?.uid === this.detailData.resource?.metadata?.uid) {
          this.detailOpen = false
        }
        if (getGraph()) {
          graphRemoveResource(resource)
          this._scheduleGraphFocusRecompute()
          // Selected node deleted out from under the inspector → fall back
          // to the cluster summary so it doesn't show a stale resource.
          if (this.inGraphView && this.graphInspect.mode === 'resource' && resource.metadata?.uid === this.graphInspect.resource?.metadata?.uid) {
            this._showGraphSummary()
          }
        }
      }
    }
    // SSE-change indicator ring: init before the listener so no early event
    // races an undefined buffer; recomputed into reactive state every 1s.
    this._sseBuckets = Array.from({ length: 5 }, () => ({ a: 0, u: 0, r: 0 }))
    this._sseIdx = 0
    this._sseInterval = setInterval(() => this._sseTick(), 1000)
    window.addEventListener('kubeEvent', this._onKubeEvent)

    // Refresh age cells and detail pane age every 60s
    this._ageInterval = setInterval(() => {
      refreshAges()
      if (this.detailOpen && this.detailData.resource) {
        this.detailData.age = ageFrom(this.detailData.resource.metadata.creationTimestamp)
      }
    }, 60000)

    // Refresh metrics every 30s when available
    this._metricsInterval = setInterval(() => {
      if (this.metricsAvailable && this.namespace) this._fetchMetrics()
    }, 30000)

    // Search query watcher — also refreshes hint bar so active state updates
    this.$watch('searchQuery', (q) => {
      setSearchFilter(q)
      this._updateHintBar()
    })

    // Detail tab watcher — loads YAML on demand, restores per-tab height,
    // and picks an expansion state from the user's recorded preference
    // (collapsed by default on first visit — every tab can be resized and
    // its state persists, so no kind-specific auto-expand).
    // Tab swaps are instant (no animation): the expand button still
    // animates, but switching tabs should land in the saved state
    // directly so the user never sees a default→stored flicker.
    this.$watch('detailTab', (tab) => {
      const storedH = this.cfg.detailHeights?.[tab]
      if (typeof storedH === 'number' && storedH > 0) this.detailHeight = storedH
      const pref = this._tabExpanded[tab]
      const target = pref === true
      this._setDetailExpanded(target, { animate: false, fromTab: true })
      if (tab === 'yaml') this._loadYAML()
      this.cfg.detailTab = tab
      saveConfig(this.cfg)
    })

    // Log search watcher — re-render visible lines when search changes
    this.$watch('logSearch', () => {
      const el = document.getElementById('logsViewContent')
      if (el && this.inLogsView) this.logMatchCount = renderLogLines(el, this._logLines, this.logSearch)
    })

    // Graph search watcher — re-applies all graph filters on debounced change
    this.$watch('graphSearch', () => {
      if (this.inGraphView) this._applyGraphFilters()
    })

    // Command palette focus
    this.$watch('cmdMode', (val) => {
      if (val) {
        this.$nextTick(() => document.getElementById('cmdInputField')?.focus())
      }
    })

    // Namespace watcher
    this.$watch('namespace', () => {
      slog.info(`🔄 Namespace changed to: ${this.namespace}`)
      // Close graph view and drop the instance so it rebuilds cleanly from
      // the fresh namespace's resource stream.
      if (this.inGraphView) this.hideGraphView()
      destroyGraph()
      this.fetchNamespace()
      channel.postMessage({ type: 'namespaceChange', namespace: this.namespace })
    })

    // Register the row select → detail pane handler
    setRowSelectHandler((res) => {
      this._openDetail(res)
      this._updateHintBar()
    })

    // Close detail pane when a row is removed or navigation occurs
    this._onClosePanel = () => {
      this._cancelPendingDelete()
      this.detailOpen = false
      this._updateHintBar()
    }
    window.addEventListener('closePanel', this._onClosePanel)

    // Register the drill-down handler
    setDrillDownHandler((res) => {
      this.drillDown(res)
    })

    // Register the table cell cross-reference click handler
    setRefClickHandler((ref) => {
      this._jumpToRef(ref.kind, ref.namespace, ref.name)
    })

    // Sync drillable kinds with DRILL_DOWN keys (single source of truth)
    setDrillableKinds(new Set(Object.keys(DRILL_DOWN)))

    // Swipe gesture to peek-open the collapsed sidebar on narrow viewports
    this._sidebarPeekInit()

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Ctrl+Shift+L: dump the in-memory log buffer to a JSON file for bug reports.
      // Works from any context; the file download itself is non-disruptive.
      if (e.ctrlKey && e.shiftKey && (e.key === 'L' || e.key === 'l')) {
        const tag = e.target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        e.preventDefault()
        window.kaLog?.download()
        return
      }

      if (e.key === 'Escape') {
        // Esc closes only the top-most open layer. Order = z-stack from top down.
        // The terminal in exec view owns Esc; the cmd palette input stops
        // propagation itself, so this handler never fires while it's active.
        if (this.inExecView) return
        if (this._closeTopLayer()) {
          e.preventDefault()
        }
        return
      }

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const tag = e.target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        if (this.inLogsView) return
        e.preventDefault()
        navigateRow(e.key === 'ArrowDown' ? 1 : -1)
        this._updateHintBar()
        return
      }

      if (e.key === 'Enter') {
        const tag = e.target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        const res = getSelectedResource()
        if (!res) return
        if (DRILL_DOWN[res.kind]) {
          this.drillDown(res)
        } else if (res.kind === 'Pod') {
          this.showLogsView(res)
        }
        return
      }

      if (e.key === 'l') {
        const tag = e.target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        const res = getSelectedResource()
        if (res?.kind === 'Pod') this.showLogsView(res)
        return
      }

      if (e.key === 'e') {
        const tag = e.target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        const res = getSelectedResource()
        if (res?.kind === 'Pod') this.showExecView(res)
        return
      }

      if (e.key === 'g') {
        const tag = e.target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        if (this.inLogsView || this.inExecView) return
        if (this.inGraphView) this.hideGraphView()
        else this.showGraphView()
        return
      }

      if (e.key === 'r') {
        const tag = e.target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        if (this.inLogsView && this.logsRes) {
          this._fetchLogs(this.logsRes)
        } else if (!this.inExecView) {
          this.refreshAll()
        }
        return
      }

      if (e.key === 'd') {
        const tag = e.target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        if (!this.detailOpen) return
        if (!this.delPending) {
          this.delPending = true
          this._deletePendingTimer = setTimeout(() => {
            this.delPending = false
            this._deletePendingTimer = null
            this._updateHintBar()
          }, 3000)
        } else {
          this._cancelPendingDelete()
          this.deleteDetailResource()
        }
        this._updateHintBar()
        return
      }

      if (e.key === '/') {
        const tag = e.target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        e.preventDefault()
        // In graph view, '/' belongs to the graph's own name filter — the
        // global sidebar search isn't even visible there.
        if (this.inGraphView) this.focusGraphSearch()
        else this.openSearch()
        return
      }

      if (e.key === ':') {
        const tag = e.target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        if (this.inLogsView) return
        e.preventDefault()
        this.cmdMode = true
        this.cmdInput = ''
        this.cmdSelectedIdx = -1
      }
    })

    // Hint-bar click delegation: each non-nav hint renders as a button
    // with data-hint-key; a single listener routes to _hintAction() so
    // mouse users get the same affordances as keyboard users.
    const hintBar = document.getElementById('hintBar')
    if (hintBar) {
      hintBar.addEventListener('click', (e) => {
        const btn = /** @type {HTMLElement} */ (e.target).closest('[data-hint-key]')
        if (!btn) return
        const key = btn.getAttribute('data-hint-key')
        if (key) this._hintAction(key)
      })
    }

    // URL namespace param
    const urlParams = new URLSearchParams(window.location.search)
    const queryNs = urlParams.get('ns') || ''
    if (queryNs) {
      this.showWelcome = false
      this.namespace = queryNs
    }

    await this.refreshNamespaces()
  },

  async refreshNamespaces() {
    let res
    try {
      res = await timedFetch('api/namespaces')
      if (!res.ok) throw new Error(`HTTP error ${res.status}: ${res.statusText}`)
      const data = await res.json()
      slog.debug('namespaces loaded', { count: data.namespaces?.length })
      this.namespaces = data.namespaces || []
      this.serviceMetadata.clusterHost = data.clusterHost || ''
      this.serviceMetadata.version = data.version || ''
      this.serviceMetadata.buildInfo = data.buildInfo || ''
      this.metricsAvailable = !!data.metricsAvailable
      this.contexts = data.contexts || []
      this.currentContext = data.currentContext || ''
      if (!this.namespace && this.namespaces && this.namespaces.length) {
        // Prefer "default"; otherwise fall back to the first namespace in the list
        this.namespace = this.namespaces.includes('default') ? 'default' : this.namespaces[0]
      }
    } catch (err) {
      this.showError(`Failed to fetch namespaces: ${err.message}`, res)
      return
    }
    slog.info(`📚 Found ${this.namespaces ? this.namespaces.length : 0} namespaces in cluster`)
  },

  async refreshAll() {
    slog.info('🔄 refresh all')
    await this.refreshNamespaces()
    if (this.namespace) await this.fetchNamespace()
  },

  async switchContext(ctxName) {
    if (!ctxName || ctxName === this.currentContext) return
    slog.info(`🔄 Switching context → ${ctxName}`)
    const prevContext = this.currentContext
    this.isLoading = true
    this.namespaces = null
    this.namespace = ''
    this.showWelcome = true
    this.kindData = {}
    this.clusterData = {}
    clearCache()
    window.dispatchEvent(new CustomEvent('closePanel'))
    try {
      const res = await timedFetch('api/contexts/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: ctxName }),
      })
      if (!res.ok) throw new Error(`HTTP error ${res.status}: ${res.statusText}`)
    } catch (err) {
      slog.warn('💥 context switch failed', { context: ctxName, err })
      // Switch failed — restore contexts from server so selector reflects reality
      this.currentContext = prevContext
      await this.refreshNamespaces()
      this.showError(`Failed to switch context to "${ctxName}": cluster unreachable`)
      return
    }
    await this.refreshNamespaces()
    // fetchNamespace handles isLoading when a namespace is auto-selected; reset it otherwise
    if (!this.namespace) this.isLoading = false
  },

  showError(message, res) {
    this.errorMessage = message
    this.errorDetails = ''
    if (!res) {
      slog.error(message)
    } else {
      res.json().then((data) => {
        this.errorDetails = JSON.stringify(data, null, 2) || 'No additional error information provided'
        slog.error('API error', data)
      })
    }
    this.showWelcome = false
    this.isLoading = false
  },

  /**
   * Fetch namespace data and populate sidebar counts + table
   */
  async fetchNamespace() {
    if (!this.namespace) return

    this.errorMessage = ''

    // Cancel any in-flight fetch from a previous namespace switch
    if (this._fetchAbort) {
      this._fetchAbort.abort()
    }
    const ctrl = new AbortController()
    this._fetchAbort = ctrl

    this.isLoading = true
    this.searchQuery = ''
    this.selectedKind = ''
    this.kindData = {}
    this.clusterData = {}
    setShowNamespaceColumn(this.namespace === ALL_NAMESPACES)

    window.history.replaceState({}, '', `?ns=${this.namespace}`)
    window.dispatchEvent(new CustomEvent('closePanel'))

    let data
    let res
    try {
      const [nsRes, clusterRes, crdRes] = await Promise.all([
        timedFetch(`api/fetch/${this.namespace}?clientID=${getClientId()}`, { signal: ctrl.signal }),
        timedFetch(`api/fetch-cluster?clientID=${getClientId()}`, { signal: ctrl.signal }),
        timedFetch('api/crds', { signal: ctrl.signal }),
      ])
      if (!nsRes.ok) throw new Error(`HTTP error ${nsRes.status}: ${nsRes.statusText}`)
      if (!clusterRes.ok) throw new Error(`Cluster fetch error ${clusterRes.status}: ${clusterRes.statusText}`)
      data = await nsRes.json()
      const clusterDataRaw = await clusterRes.json()
      this.crdList = crdRes.ok ? await crdRes.json() : []
      res = nsRes
      this.isLoading = false
      this.showWelcome = false

      clearCache()

      // Store namespace-scoped resources
      for (const kindKey in data) {
        const resources = data[kindKey] || []
        for (const r of resources) {
          store(r)
          if (r.kind) {
            if (!this.kindData[r.kind]) this.kindData[r.kind] = []
            this.kindData[r.kind].push(r)
          }
        }
      }

      // Store cluster-scoped resources
      for (const kindKey in clusterDataRaw) {
        const resources = clusterDataRaw[kindKey] || []
        for (const r of resources) {
          store(r)
          if (r.kind) {
            if (!this.clusterData[r.kind]) this.clusterData[r.kind] = []
            this.clusterData[r.kind].push(r)
          }
        }
      }

      const nsRows = Object.values(this.kindData).reduce((sum, arr) => sum + arr.length, 0)
      const clusterRows = Object.values(this.clusterData).reduce((sum, arr) => sum + arr.length, 0)
      slog.debug('namespace data loaded', {
        namespace: this.namespace,
        kinds: Object.keys(this.kindData).length,
        ns_rows: nsRows,
        cluster_rows: clusterRows,
        crds: this.crdList.length,
      })

      // Warn on per-kind counts that historically slow rendering. The exact
      // bottleneck shifts with the renderer (table vs graph), but >500 of a
      // single kind reliably starts to degrade the graph sim. This pins
      // "UI feels slow" reports to data volume rather than a code bug.
      const LARGE_KIND = 500
      for (const [kind, arr] of Object.entries(this.kindData)) {
        if (arr.length > LARGE_KIND) {
          slog.warn('🐌 large resource count', { kind, count: arr.length, namespace: this.namespace })
        }
      }
      for (const [kind, arr] of Object.entries(this.clusterData)) {
        if (arr.length > LARGE_KIND) {
          slog.warn('🐌 large cluster resource count', { kind, count: arr.length })
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        slog.info(`🚫 Fetch aborted for namespace: ${this.namespace}`)
        return
      }
      this.showError(`Failed to fetch namespace data: ${err.message}`, res)
      return
    }

    // Build CRD sidebar group from discovered CRDs
    this.crdMeta = {}
    if (this.crdList.length > 0) {
      const crdKinds = []
      for (const crd of this.crdList) {
        this.crdMeta[crd.kind] = { group: crd.group, version: crd.version, resource: crd.resource, scope: crd.scope }
        crdKinds.push(crd.kind)
      }
      this.resourceGroups = [...RESOURCE_GROUPS, { label: 'Custom Resources', kinds: crdKinds }]
    } else {
      this.resourceGroups = RESOURCE_GROUPS
    }

    // Auto-select first kind with data (skip cluster kinds, prefer namespace-scoped)
    const nsKinds = RESOURCE_GROUPS.filter((g) => !g.isCluster).flatMap((g) => g.kinds)
    const defaultKind = nsKinds.find((k) => (this.kindData[k] || []).length > 0) || nsKinds[0]
    this.selectKind(defaultKind)

    if (this.metricsAvailable) this._fetchMetrics()
  },

  async _fetchMetrics() {
    try {
      const [podRes, nodeRes] = await Promise.all([timedFetch(`api/metrics/${this.namespace}/pods`), timedFetch('api/metrics/nodes')])

      if (podRes.ok) {
        const items = await podRes.json()
        const m = {}
        for (const item of items) {
          const name = item.metadata?.name
          if (!name) continue
          let cpuNano = 0
          let memBytes = 0
          for (const c of item.containers || []) {
            const usage = c.usage || {}
            cpuNano += parseCPUNano(usage.cpu || '0')
            memBytes += parseMemBytes(usage.memory || '0')
          }
          m[name] = { cpu: formatCPU(cpuNano + 'n'), mem: formatMemory(String(memBytes)) }
        }
        this.podMetrics = m
        setMetricsData(m)
      }

      if (nodeRes.ok) {
        const items = await nodeRes.json()
        const m = {}
        for (const item of items) {
          const name = item.metadata?.name
          const usage = item.usage || {}
          if (!name) continue
          m[name] = { cpu: formatCPU(usage.cpu || '0'), mem: formatMemory(usage.memory || '0') }
        }
        this.nodeMetrics = m
        setNodeMetricsData(m)
      }
    } catch (err) {
      slog.error('⚠️ Failed to fetch metrics:', err)
    }

    // If table already has metrics columns, update in-place; otherwise full re-render to add them
    const kind = this.selectedKind
    if ((kind === 'Pod' || kind === 'Node') && !document.querySelector('#resourceTable th[data-col="cpu"]')) {
      const resources = this._getKindData(kind)
      renderTable(kind, resources)
      this._updateBreadcrumb(kind, resources.length)
    } else {
      refreshMetricsColumns()
    }
  },

  /**
   * Select a resource kind in the sidebar and render its table
   * @param {string} kind
   */
  selectKind(kind) {
    this.selectedKind = kind
    this.navStack = []
    this.searchQuery = ''
    this.detailOpen = false
    this.sidebarPeekOpen = false
    setSearchFilter('')

    // CRD kinds need on-demand fetch
    if (this.crdMeta[kind]) {
      this._fetchCRDResources(kind)
      return
    }

    const resources = this._getKindData(kind)
    renderTable(kind, resources)
    this._updateBreadcrumb(kind, resources.length)
    this._updateHintBar()
  },

  /**
   * Returns the count of resources for a given kind
   * @param {string} kind
   * @returns {number}
   */
  async _fetchCRDResources(kind) {
    const meta = this.crdMeta[kind]
    if (!meta) return

    const ns = meta.scope === 'Namespaced' ? this.namespace : '_'

    renderTable(kind, [])
    this._updateBreadcrumb(kind, 0)

    try {
      const res = await timedFetch(`api/crds/${meta.group}/${meta.version}/${meta.resource}/${ns}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const items = await res.json()
      slog.debug('crd loaded', { kind, count: items.length })

      // Ensure each item has the kind set (API may not include it)
      for (const item of items) {
        if (!item.kind) item.kind = kind
      }

      // Store in kindData so _getKindData works for detail pane, etc.
      this.kindData[kind] = items
      for (const r of items) store(r)

      if (this.selectedKind === kind) {
        renderTable(kind, items)
        this._updateBreadcrumb(kind, items.length)
      }
    } catch (err) {
      slog.error(`⚠️ Failed to fetch CRD ${kind}:`, err)
    }

    this._updateHintBar()
  },

  kindCount(kind) {
    return this._getKindData(kind).length
  },

  /**
   * Sidebar groups with hidden kinds filtered out. Cluster and Custom Resource
   * groups bypass the filter (they're not exposed in the Filters tab).
   */
  visibleGroups() {
    const hidden = this.cfg.hiddenKinds || []
    return this.resourceGroups
      .map((g) => {
        if (g.isCluster || g.label === 'Custom Resources') return g
        return { ...g, kinds: g.kinds.filter((k) => !hidden.includes(k)) }
      })
      .filter((g) => g.kinds.length > 0)
  },

  /** Non-cluster sidebar groups — the universe exposed in the Filters tab */
  filterableGroups() {
    return this.resourceGroups.filter((g) => !g.isCluster && g.label !== 'Custom Resources')
  },

  /**
   * Toggle a kind's visibility in the sidebar (used by the Filters tab chips)
   * @param {string} kind
   */
  toggleKindVisibility(kind) {
    const hidden = this.cfg.hiddenKinds || []
    const i = hidden.indexOf(kind)
    const action = i >= 0 ? 'show' : 'hide'
    if (i >= 0) hidden.splice(i, 1)
    else hidden.push(kind)
    this.cfg.hiddenKinds = [...hidden]
    slog.info('kind visibility', { kind, action, hidden_total: this.cfg.hiddenKinds.length })
    // Keep the graph in sync when it's live
    if (getGraph()) this._applyGraphFilters()
  },

  kindLabel(kind) {
    const irregulars = {
      Ingress: 'Ingresses',
      NetworkPolicy: 'NetworkPolicies',
      PersistentVolume: 'PersistentVolumes',
      PersistentVolumeClaim: 'PVCs',
      HorizontalPodAutoscaler: 'HPAs',
    }
    return irregulars[kind] || kind + 's'
  },

  /**
   * Returns the resource list for a kind from the correct data store
   * @param {string} kind
   * @returns {any[]}
   */
  _getKindData(kind) {
    if (CLUSTER_KINDS.has(kind)) return this.clusterData[kind] || []
    return this.kindData[kind] || []
  },

  /**
   * Update counts in a data store when a live event arrives
   * @param {Record<string, any[]>} dataStore
   * @param {string} kind
   * @param {any} resource
   * @param {string} type 'add' | 'update'
   */
  _updateKindCountIn(dataStore, kind, resource, type) {
    if (!dataStore[kind]) dataStore[kind] = []
    const arr = dataStore[kind]
    const idx = arr.findIndex((r) => r.metadata.uid === resource.metadata.uid)
    if (idx >= 0) {
      arr[idx] = resource
    } else if (type === 'add') {
      arr.push(resource)
    }
  },

  /**
   * Remove a resource from a data store when deleted
   * @param {Record<string, any[]>} dataStore
   * @param {string} kind
   * @param {string} uid
   */
  _removeFromDataStore(dataStore, kind, uid) {
    if (!dataStore[kind]) return
    dataStore[kind] = dataStore[kind].filter((r) => r.metadata.uid !== uid)
  },

  // ── Drill-down navigation ────────────────────────────────────────────────

  openSearch() {
    this.searchOpen = true
    this.$nextTick(() => {
      const input = document.getElementById('searchInput')
      if (input) {
        input.focus()
        input.select()
      }
    })
  },

  closeSearch() {
    this.searchOpen = false
    this.searchQuery = ''
    const input = document.getElementById('searchInput')
    if (input) input.blur()
  },

  _onSearchBlur() {
    if (!this.searchQuery) this.searchOpen = false
  },

  /**
   * Drill into a resource's children (triggered by the › icon)
   * @param {any} resource
   */
  drillDown(resource) {
    if (!DRILL_DOWN[resource.kind]) return
    slog.info('drill down', { kind: resource.kind, name: resource.metadata.name })
    this.navStack.push({ kind: resource.kind, name: resource.metadata.name, uid: resource.metadata.uid })
    this._renderCurrentView()
    window.dispatchEvent(new CustomEvent('closePanel'))
  },

  /** Pop one level up in the drill-down stack */
  navBack() {
    if (this.navStack.length === 0) return
    slog.info('nav back', { depth: this.navStack.length - 1 })
    this.navStack.pop()
    this._renderCurrentView()
    window.dispatchEvent(new CustomEvent('closePanel'))
  },

  /**
   * Jump to a specific depth in the nav stack (used by breadcrumb clicks)
   * @param {number} index - number of stack entries to keep (0 = back to root)
   */
  navTo(index) {
    this.navStack = this.navStack.slice(0, index)
    this._renderCurrentView()
    window.dispatchEvent(new CustomEvent('closePanel'))
  },

  /** Returns the kind currently shown in the table (may differ from selectedKind when drilled in) */
  _currentKind() {
    if (this.navStack.length === 0) return this.selectedKind
    const last = this.navStack[this.navStack.length - 1]
    return DRILL_DOWN[last.kind]?.childKind || this.selectedKind
  },

  /** Re-render the table and breadcrumb for the current nav state */
  _renderCurrentView() {
    const kind = this._currentKind()
    let resources = this._getKindData(kind)
    let filterFn = null

    if (this.navStack.length > 0) {
      const parent = this.navStack[this.navStack.length - 1]
      filterFn = (r) => (r.metadata?.ownerReferences || []).some((ref) => ref.uid === parent.uid)
      resources = resources.filter(filterFn)
    }

    renderTable(kind, resources, filterFn)
    this._updateBreadcrumb(kind, resources.length)
    this._updateHintBar()
  },

  /**
   * Rebuild the breadcrumb DOM in #breadcrumb
   * @param {string} currentKind
   * @param {number} count
   */
  _updateBreadcrumb(currentKind, count) {
    const nav = document.getElementById('breadcrumb')
    if (!nav) return
    nav.innerHTML = ''

    const addSep = () => {
      const sep = document.createElement('span')
      sep.className = 'breadcrumb-sep'
      sep.textContent = '›'
      nav.appendChild(sep)
    }

    const addItem = (label, isLink, onClick) => {
      const el = document.createElement('span')
      el.className = 'breadcrumb-item' + (isLink ? ' breadcrumb-link' : '')
      el.textContent = label
      if (isLink && onClick) el.addEventListener('click', onClick)
      nav.appendChild(el)
    }

    const atRoot = this.navStack.length === 0

    // Root kind — link when drilled in so you can go back
    addItem(`${this.selectedKind}s`, !atRoot, () => this.navTo(0))

    // Each drilled-into resource
    this.navStack.forEach((entry, i) => {
      addSep()
      // All entries except the last are navigable links
      const isLink = i < this.navStack.length - 1
      addItem(entry.name, isLink, isLink ? () => this.navTo(i + 1) : null)
    })

    // Current kind + count
    if (!atRoot) {
      addSep()
      const badge = document.createElement('span')
      badge.className = 'breadcrumb-item breadcrumb-kind'
      badge.textContent = `${currentKind}s [${count}]`
      nav.appendChild(badge)
    } else {
      // Append count inline to the root label
      const rootItem = nav.querySelector('.breadcrumb-item')
      if (rootItem) rootItem.textContent += ` [${count}]`
    }
  },

  // Settings save
  configDialogSave() {
    saveConfig(this.cfg)
    this.showConfigDialog = false
    showToast('Configuration saved successfully', 3000, 'top-center', 'success')
    this.fetchNamespace()
  },

  // ── Detail pane ──────────────────────────────────────────────

  _startDetailResize(ev) {
    ev.preventDefault()
    const pane = document.querySelector('#detailPane')
    if (!pane) return
    const paneBottom = pane.getBoundingClientRect().bottom
    const startHeight = this.detailHeight
    const maxH = Math.max(240, window.innerHeight - 160)
    // Offset between pane top and content top (= handle + header + tabs).
    // detailHeight stores only the tab-content height, so target = paneBottom
    // - mouseY - offsetTop to keep the handle under the cursor.
    const contentTop =
      pane.querySelector('.detail-tab-content:not([style*="display: none"])')?.getBoundingClientRect().top ?? pane.getBoundingClientRect().top
    const offsetTop = contentTop - pane.getBoundingClientRect().top
    // Measure the active tab's natural content height so dragging down floors
    // at it (no forced scrollbar). CSS forces a fixed height in collapsed mode
    // and flex:1 in expanded mode — override both inline to read scrollHeight.
    const measureNatural = () => {
      const el = pane.querySelector('.detail-tab-content:not([style*="display: none"])')
      if (!el) return 200
      const prevH = el.style.height
      const prevF = el.style.flex
      el.style.height = 'auto'
      el.style.flex = 'none'
      const n = el.scrollHeight
      el.style.height = prevH
      el.style.flex = prevF
      return n
    }
    // Floor the drag at the natural content height, but cap that floor at 200px
    // so long-content tabs (yaml/events) can still be shrunk. Short content
    // keeps its natural floor to avoid empty space.
    let minH = this.detailExpanded
      ? 160 // placeholder until we exit expanded mode and can re-measure
      : Math.min(maxH, Math.min(measureNatural(), 200))
    // Dragging the handle above this Y snaps the pane into expanded mode.
    const expandSnap = 80
    const stop = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    const move = (e) => {
      if (e.clientY < expandSnap) {
        if (!this.detailExpanded) {
          // Remember the pre-drag height so collapse restores it.
          this.detailHeight = startHeight
          this.detailExpanded = true
          this._detailTableHidden = true
          this._tabExpanded[this.detailTab] = true
          this._persistTabExpanded()
        }
        return
      }
      if (this.detailExpanded) {
        this.detailExpanded = false
        this._detailTableHidden = false
        this._tabExpanded[this.detailTab] = false
        this._persistTabExpanded()
        // flex:1 is gone now; re-measure after Alpine applies the class change.
        requestAnimationFrame(() => {
          minH = Math.min(maxH, Math.min(measureNatural(), 200))
          const targetH = paneBottom - e.clientY - offsetTop
          this.detailHeight = Math.max(minH, Math.min(maxH, targetH))
        })
        return
      }
      const targetH = paneBottom - e.clientY - offsetTop
      this.detailHeight = Math.max(minH, Math.min(maxH, targetH))
    }
    const up = () => {
      stop()
      if (!this.detailExpanded) {
        if (!this.cfg.detailHeights || typeof this.cfg.detailHeights !== 'object') {
          this.cfg.detailHeights = {}
        }
        this.cfg.detailHeights[this.detailTab] = this.detailHeight
        // Legacy single-value key kept roughly in sync for older readers.
        this.cfg.detailHeight = this.detailHeight
        saveConfig(this.cfg)
      }
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
  },

  // Mirror _tabExpanded into cfg.detailTabExpanded and persist. Called
  // from every site that mutates _tabExpanded so the user's per-tab
  // expand/collapse choice survives a page reload.
  _persistTabExpanded() {
    this.cfg.detailTabExpanded = { ...this._tabExpanded }
    saveConfig(this.cfg)
  },

  /**
   * Flip detailExpanded and keep _detailTableHidden in sync.
   * Pass { animate: true } for UI-initiated transforms (expand button, Esc,
   * tab auto-expand). Drag-initiated flips stay instant and set both flags
   * directly — never route through here.
   */
  _setDetailExpanded(value, { animate = false, fromTab = false } = {}) {
    if (!fromTab) {
      // Manual toggle — record as the user's preference for this tab so
      // subsequent switches to it honor the chosen state.
      this._tabExpanded[this.detailTab] = value
      this._persistTabExpanded()
    }
    if (this.detailExpanded === value) return
    if (!animate) {
      this.detailExpanded = value
      this._detailTableHidden = value
      return
    }
    this._animateDetailExpand(value)
  },

  _animateDetailExpand(target) {
    if (this._detailAnimating) return
    const el = document.getElementById('detailPane')
    const tableArea = document.getElementById('tableArea')
    if (!el || !tableArea) {
      this.detailExpanded = target
      this._detailTableHidden = target
      return
    }
    const fromH = el.offsetHeight
    let toH
    if (target) {
      toH = tableArea.clientHeight
    } else {
      // Measure the natural collapsed height by briefly stripping the class.
      el.classList.remove('is-expanded')
      toH = el.offsetHeight
      el.classList.add('is-expanded')
    }

    this._detailAnimating = true
    // Keep the table-wrap visible throughout the animation so it fills the
    // gap above the pane (or shrinks as the pane grows). It's toggled at
    // end-of-animation via _detailTableHidden.
    this._detailTableHidden = false
    // Lock the pane's current height so the class flip doesn't snap.
    el.style.height = fromH + 'px'
    el.style.flex = 'none'
    // Force tab content to fill the pane during animation, so collapsing
    // from full-size doesn't show empty space below a fixed-height content.
    el.classList.add('is-animating')
    this.detailExpanded = target

    let safetyTimer = 0
    const cleanup = () => {
      el.removeEventListener('transitionend', cleanup)
      if (safetyTimer) clearTimeout(safetyTimer)
      // Flip table-wrap visibility first; wait a frame so Alpine applies
      // x-show before we release the inline height that was masking flex.
      this._detailTableHidden = target
      requestAnimationFrame(() => {
        el.style.height = ''
        el.style.flex = ''
        el.style.transition = ''
        el.classList.remove('is-animating')
        this._detailAnimating = false
      })
    }

    requestAnimationFrame(() => {
      void el.offsetHeight
      el.style.transition = 'height var(--dur-med) var(--ease-out)'
      el.style.height = toH + 'px'
      el.addEventListener('transitionend', cleanup, { once: true })
      safetyTimer = window.setTimeout(cleanup, 400)
    })
  },

  _openDetail(res, { preserveTab = false } = {}) {
    slog.debug('detail open', { kind: res?.kind, name: res?.metadata?.name })
    this._cancelPendingDelete()
    this.detailMoreOpen = false
    if (!preserveTab) {
      // New resource — two independent toggles gate what carries over:
      //   persistDetailExpansion: keep each tab's expanded/collapsed state.
      //   persistDetailTab:       keep the active tab (info/yaml/events).
      // When either is off, reset the corresponding state so defaults
      // (info tab, all tabs collapsed) apply again.
      if (!this.cfg.persistDetailExpansion) {
        this._tabExpanded = { info: null, yaml: null, events: null }
        this._persistTabExpanded()
        this.detailExpanded = false
      }
      if (!this.cfg.persistDetailTab) {
        this.detailTab = 'info'
      }
      this._detailTableHidden = false
      this.yamlEditing = false
      this.yamlApplyError = ''
    }
    const uid = res.metadata.uid
    this.detailData = {
      kind: res.kind,
      name: res.metadata.name,
      namespace: res.metadata.namespace || '',
      age: ageFrom(res.metadata.creationTimestamp),
      isPod: res.kind === 'Pod',
      isScalable: ['Deployment', 'ReplicaSet', 'StatefulSet'].includes(res.kind),
      isRestartable: ['Deployment', 'StatefulSet', 'DaemonSet'].includes(res.kind),
      isCluster: CLUSTER_KINDS.has(res.kind),
      resource: res,
      fields: buildDetailFields(res, this.podMetrics, this.nodeMetrics),
      sections: buildDetailSections(res),
      events: getResourceEvents(res),
      yaml: this._yamlCache[uid] || '',
      yamlLoading: false,
      yamlError: '',
    }
    this.detailOpen = true
    // When persistDetailTab keeps the active tab across resources, the
    // detailTab watcher doesn't fire (value unchanged), so the YAML fetch
    // that normally hangs off that watcher never triggers. Kick it here.
    if (this.detailTab === 'yaml') this._loadYAML()
  },

  async _loadYAML() {
    const res = this.detailData.resource
    if (!res) return
    const uid = res.metadata.uid
    if (this._yamlCache[uid]) {
      this.detailData.yaml = this._yamlCache[uid]
      this._highlightYAML()
      return
    }

    this.detailData.yamlLoading = true
    this.detailData.yamlError = ''

    try {
      const ns = res.metadata.namespace || '_'
      const r = await timedFetch(`api/resource/${ns}/${res.kind}/${res.metadata.name}/yaml`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const text = await r.text()
      this._yamlCache[uid] = text
      this.detailData.yaml = text
      this._highlightYAML()
    } catch (err) {
      this.detailData.yamlError = `Error loading YAML: ${err.message}`
    } finally {
      this.detailData.yamlLoading = false
    }
  },

  _highlightYAML() {
    this.$nextTick(() => {
      const el = document.querySelector('#detailPane code.language-yaml')
      if (el && window.Prism) window.Prism.highlightElement(el)
    })
  },

  _startYAMLEdit() {
    this.yamlEditContent = this.detailData.yaml
    this.yamlApplyError = ''
    this.yamlEditing = true
    this.$nextTick(() => {
      const ta = document.querySelector('#yamlEditor')
      if (ta) ta.focus()
    })
  },

  _cancelYAMLEdit() {
    this.yamlEditing = false
    this.yamlApplyError = ''
  },

  async _applyYAML() {
    const res = this.detailData.resource
    const ns = res.metadata.namespace || '_'
    slog.info('📝 yaml apply attempt', { kind: res.kind, name: res.metadata.name, namespace: ns, bytes: this.yamlEditContent.length })
    this.yamlApplying = true
    this.yamlApplyError = ''
    try {
      const r = await timedFetch(`api/resource/${ns}/${res.kind}/${res.metadata.name}/yaml`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/yaml',
          'X-Client-ID': getClientId(),
        },
        body: this.yamlEditContent,
      })
      if (!r.ok) {
        const text = await r.text()
        throw new Error(text || `HTTP ${r.status}`)
      }
      slog.info('✅ yaml applied', { kind: res.kind, name: res.metadata.name })
      // Invalidate cache and reload YAML in view mode
      delete this._yamlCache[res.metadata.uid]
      this.yamlEditing = false
      this.detailData.yaml = ''
      this._loadYAML()
    } catch (err) {
      slog.error('💥 yaml apply failed', { kind: res.kind, name: res.metadata.name, err })
      this.yamlApplyError = err.message
    } finally {
      this.yamlApplying = false
    }
  },

  // ── Graph view ────────────────────────────────────────────────

  async showGraphView() {
    slog.info('graph view open', { namespace: this.namespace })
    this.inGraphView = true
    this._updateHintBar()

    // Wait for the container to appear (Alpine x-show toggles display).
    await this.$nextTick()

    const container = document.getElementById('graphViewContent')
    if (!container) {
      slog.error('💥 #graphViewContent not found')
      return
    }

    try {
      _initGraph(container)
    } catch (err) {
      slog.error('💥 Failed to init graph:', err)
      showToast('Failed to initialise graph', 3000, 'top-center', 'error')
      this.inGraphView = false
      return
    }

    const g = getGraph()
    if (!g) return

    // Wire node-click → graph inspector (NOT #detailPane — that pane is
    // x-show-hidden while inGraphView, so the old _openDetail path opened an
    // invisible pane). Re-registered each open since the closures capture
    // `this`. Background click + Esc fall back to the cluster summary.
    graphSetOnNodeClick((uid) => {
      const r = this._findResourceByUid(uid)
      if (r) {
        selectRow(r.metadata.uid)
        this._openGraphInspector(r)
      }
    })
    graphSetOnBackgroundClick(() => this._showGraphSummary())
    graphSetOnStatsChange((s) => {
      this.graphStats = { ...this.graphStats, ...s, perfHint: s.totalNodes > 1500 ? `${s.totalNodes} nodes — filter to focus` : '' }
      // Keep the no-selection rollup fresh on the same coalesced cadence as
      // the counts (cheap; only when the summary is actually showing).
      if (this.graphInspect.mode === 'summary') this.graphInspect.summary = this._graphClusterSummary()
    })

    // Apply persisted renderer prefs (forces are seeded in initGraph from
    // cfg.graphSim; reveal style + icon overlay need an explicit apply).
    graphSetIconOverlay(this.graphIconOverlay)
    graphSetRevealStyle(this.graphRevealStyle)

    // Populate the namespace scope picker; reset graph-local filters.
    this.graphNamespaces = this._graphNamespaceList()
    this.graphNsScope = ''
    this.graphHealthOnly = false
    this.graphHiddenKinds = []

    // Open showing the cluster-wide summary until a node is clicked.
    this._showGraphSummary()

    // Replay every cached resource into the graph on first open. Orphans
    // are pruned at replay time when the toggle is off so fitToVisible
    // doesn't zoom out to encompass them.
    if (g.nodes.length === 0) {
      const all = []
      for (const kind in this.kindData) {
        for (const r of this.kindData[kind]) all.push(r)
      }
      for (const kind in this.clusterData) {
        for (const r of this.clusterData[kind]) all.push(r)
      }
      graphReplayResources(all, { pruneOrphans: !this.graphShowOrphans })
    }

    // Fit-on-open is renderer-driven: replayResources() pre-ticks the
    // force sim (_settle) so the layout is already settled, then arms a
    // one-shot fit that the first valid resize consumes. The graph opens
    // already laid-out and framed — no bloom-from-centre, no manual Fit.
    // The header Fit button stays for after-the-fact reframing.
  },

  hideGraphView() {
    slog.info('graph view close')
    this.inGraphView = false
    // Drop the renderer so closed-view SSE bursts don't keep mutating an
    // invisible graph. Next showGraphView() rebuilds from the cache.
    if (this._graphFocusRaf) {
      cancelAnimationFrame(this._graphFocusRaf)
      this._graphFocusRaf = null
    }
    destroyGraph()
    this._updateHintBar()
  },

  _onGraphFocusChange() {
    saveConfig({ ...this.cfg, graphFocusEnabled: this.graphFocusEnabled })
    this._applyGraphFilters()
  },

  _onGraphIconChange() {
    saveConfig({ ...this.cfg, graphIconOverlay: this.graphIconOverlay })
    if (this.inGraphView && getGraph()) graphSetIconOverlay(this.graphIconOverlay)
  },

  /** Sorted namespace list across the in-memory stores (for the scope picker). */
  _graphNamespaceList() {
    const set = new Set()
    for (const kind in this.kindData) for (const r of this.kindData[kind]) if (r.metadata?.namespace) set.add(r.metadata.namespace)
    return [...set].sort()
  },

  _onGraphHealthChange() {
    this.graphHealthOnly = !this.graphHealthOnly
    this._applyGraphFilters()
  },

  _onGraphNsChange() {
    this._applyGraphFilters()
  },

  /** Legend chip click → toggle a kind's graph-local visibility. */
  _toggleGraphKind(kind) {
    const i = this.graphHiddenKinds.indexOf(kind)
    if (i >= 0) this.graphHiddenKinds.splice(i, 1)
    else this.graphHiddenKinds.push(kind)
    this._applyGraphFilters()
  },

  /** Actionable perf hint: snap to the namespace overview (fit = zoom out). */
  _graphCollapseToNamespace() {
    this.graphLegendOpen = false
    this._graphFit()
  },

  /** Slider/dropdown changed → live-apply to the sim + persist. */
  _onGraphSimChange() {
    // x-model.number can leave strings; coerce so the sim gets real numbers.
    const sim = {}
    for (const k of Object.keys(this.graphSimFields)) sim[k] = +this.graphSim[k]
    this.graphSim = { ...this.graphSim, ...sim }
    if (this.inGraphView && getGraph()) graphSetSimParams(sim)
    saveConfig({ ...this.cfg, graphSim: sim })
  },

  _onGraphRevealChange() {
    graphSetRevealStyle(this.graphRevealStyle)
    saveConfig({ ...this.cfg, graphRevealStyle: this.graphRevealStyle })
  },

  /** Reset every sim param to the tuned defaults. */
  _resetGraphSim() {
    this.graphSim = { ...GRAPH_SIM_DEFAULTS }
    this.graphRevealStyle = 'bloom'
    if (this.inGraphView && getGraph()) {
      graphSetSimParams(GRAPH_SIM_DEFAULTS)
      graphSetRevealStyle('bloom')
    }
    saveConfig({ ...this.cfg, graphSim: {}, graphRevealStyle: 'bloom' })
  },

  async _onGraphOrphansChange() {
    saveConfig({ ...this.cfg, graphShowOrphans: this.graphShowOrphans })
    if (!this.inGraphView || !getGraph()) return
    // Toggling orphans changes which nodes exist in the graph. Cheapest
    // correct rebuild: destroy + reopen, which replays from the in-memory
    // cache with the new pruneOrphans setting.
    destroyGraph()
    await this.showGraphView()
  },

  async _graphFit() {
    const g = getGraph()
    if (!g) return
    try {
      await fitToVisible(g, true)
    } catch (err) {
      slog.debug('graph fit failed', err)
    }
  },

  /**
   * Re-apply search + kind + focus filters in order. Each filter only hides
   * nodes; none re-show, so ordering doesn't matter for visibility, but
   * applying focus last ensures its BFS considers the already-pruned graph.
   */
  async _applyGraphFilters() {
    const g = getGraph()
    if (!g) return

    saveConfig({ ...this.cfg, graphDepth: this.graphDepth })

    // Order: search → kinds → namespace scope → health → focus. Every helper
    // only hides; focus is last so its BFS walks the already-pruned graph.
    nodeVisByLabel(g, (this.graphSearch || '').toLowerCase())

    const hiddenKinds = [...(this.cfg.hiddenKinds || []), ...this.graphHiddenKinds]
    if (hiddenKinds.length > 0) setKindVisibility(g, hiddenKinds)

    if (this.graphNsScope) setNamespaceVisibility(g, this.graphNsScope)

    if (this.graphHealthOnly) setHealthFilter(g, 'unhealthy')

    if (this.graphFocusEnabled) {
      // Focus root is the inspector selection in graph view (detailData is
      // not populated here anymore); fall back to detailData for safety.
      const rootUid = this.graphInspect.resource?.metadata?.uid || this.detailData?.resource?.metadata?.uid
      if (rootUid) focusByDepth(g, rootUid, this.graphDepth)
    }

    // Surface the active filter chain in the status bar.
    const parts = []
    if (this.graphSearch) parts.push(`name:"${this.graphSearch}"`)
    if (hiddenKinds.length > 0) parts.push(`${hiddenKinds.length} kinds hidden`)
    if (this.graphNsScope) parts.push(`ns:${this.graphNsScope}`)
    if (this.graphHealthOnly) parts.push('unhealthy only')
    if (this.graphFocusEnabled) parts.push(`focus depth ${this.graphDepth}`)
    this.graphStats.filterSummary = parts.join(' · ')

    try {
      await fitToVisible(g, true)
    } catch (err) {
      slog.debug('graph filters fit failed', err)
    }
  },

  /**
   * Coalesce graph focus recomputes during SSE bursts. rAF guarantees at
   * most one recompute per frame even if hundreds of events arrive in <1s.
   */
  _scheduleGraphFocusRecompute() {
    if (!this.inGraphView || !this.graphFocusEnabled) return
    if (this._graphFocusRaf) return
    this._graphFocusRaf = requestAnimationFrame(() => {
      this._graphFocusRaf = null
      this._applyGraphFilters()
    })
  },

  /** Look up a cached resource by uid across namespaced + cluster stores. */
  _findResourceByUid(uid) {
    for (const kind in this.kindData) {
      const r = this.kindData[kind].find((x) => x.metadata?.uid === uid)
      if (r) return r
    }
    for (const kind in this.clusterData) {
      const r = this.clusterData[kind].find((x) => x.metadata?.uid === uid)
      if (r) return r
    }
    return null
  },

  /** Focus the graph view's own name filter (the '/' target in graph view). */
  focusGraphSearch() {
    this.$nextTick(() => {
      const input = document.querySelector('#graphViewHeader .graph-search')
      if (input) {
        input.focus()
        input.select()
      }
    })
  },

  /**
   * Populate the in-graph inspector for a clicked node. Reuses the exact
   * detail-pane builders so the fields/sections/events render identically;
   * the bottom #detailPane stays untouched (it's hidden in graph view).
   */
  _openGraphInspector(res) {
    if (!res) return
    slog.debug('graph inspect', { kind: res.kind, name: res.metadata?.name })
    this.graphInspect = {
      mode: 'resource',
      kind: res.kind,
      name: res.metadata?.name || '',
      namespace: res.metadata?.namespace || '',
      resource: res,
      fields: buildDetailFields(res, this.podMetrics, this.nodeMetrics),
      sections: buildDetailSections(res),
      events: getResourceEvents(res),
      summary: this.graphInspect.summary,
    }
    this.graphStats.selection = `${res.kind}/${res.metadata?.name || ''}`
  },

  /** Switch the inspector back to the cluster-wide summary (no selection). */
  _showGraphSummary() {
    selectRow(null)
    this.graphInspect = {
      mode: 'summary',
      kind: '',
      name: '',
      namespace: '',
      resource: null,
      fields: [],
      sections: [],
      events: [],
      summary: this._graphClusterSummary(),
    }
    this.graphStats.selection = ''
  },

  /**
   * Cluster-wide rollup for the inspector's no-selection state: per-kind
   * counts, namespace count, and unhealthy total derived from statusClass
   * (same status logic the table uses). Built from the in-memory stores.
   */
  _graphClusterSummary() {
    const kinds = []
    const namespaces = new Set()
    let total = 0
    let unhealthy = 0
    const tally = (store) => {
      for (const kind in store) {
        const arr = store[kind]
        if (!arr || arr.length === 0) continue
        kinds.push({ kind, count: arr.length })
        for (const r of arr) {
          total++
          if (r.metadata?.namespace) namespaces.add(r.metadata.namespace)
          const sc = statusClass(r)
          if (sc === 'status-red' || sc === 'status-yellow') unhealthy++
        }
      }
    }
    tally(this.kindData)
    tally(this.clusterData)
    kinds.sort((a, b) => b.count - a.count)
    return { kinds, namespaces: namespaces.size, total, unhealthy }
  },

  // ── Logs view ────────────────────────────────────────────────

  showLogsView(res) {
    slog.info('logs view open', { namespace: res.metadata?.namespace, pod: res.metadata?.name })
    this.logsRes = res
    this.inLogsView = true

    const containers = [...(res.spec?.containers || []), ...(res.spec?.initContainers || [])].map((c) => c.name)
    this.logContainers = containers
    this.logContainer = containers[0] || ''
    this.logPrevious = false
    this.logTimestamps = false
    this.logSearch = ''
    this.logMatchCount = 0
    this._logLines = []

    this._updateBreadcrumbForLogs(res)
    this._updateHintBar()
    this._fetchLogs(res)
  },

  hideLogsView() {
    slog.info('logs view close')
    if (this._logsAbort) {
      this._logsAbort.abort()
      this._logsAbort = null
    }
    this.logsRes = null
    this.inLogsView = false
    const kind = this._currentKind()
    this._updateBreadcrumb(kind, this._getKindData(kind).length)
    this._updateHintBar()
  },

  async _fetchLogs(res) {
    const el = document.getElementById('logsViewContent')
    if (!el) return

    if (this._logsAbort) this._logsAbort.abort()
    const ctrl = new AbortController()
    this._logsAbort = ctrl
    this._logLines = []

    el.textContent = 'Loading…'
    try {
      el.textContent = ''
      await streamPodLogs({
        namespace: res.metadata.namespace,
        pod: res.metadata.name,
        container: this.logContainer,
        follow: !this.logPrevious,
        previous: this.logPrevious,
        timestamps: this.logTimestamps,
        signal: ctrl.signal,
        onLine: (line) => {
          this._logLines.push(line)
          this.logMatchCount = renderLogLines(el, this._logLines, this.logSearch)
        },
      })
    } catch (err) {
      if (err.name === 'AbortError') return
      slog.error('💥 Failed to fetch logs:', err.message)
      el.textContent = `Error: ${err.message}`
    }
  },

  async _copyLogs() {
    try {
      await navigator.clipboard.writeText(this._logLines.join('\n'))
      showToast('Logs copied', 1500, 'top-center', 'success')
    } catch {
      showToast('Copy failed', 1500, 'top-center', 'error')
    }
  },

  async _copyYAML() {
    try {
      await navigator.clipboard.writeText(this.detailData.yaml || '')
      showToast('YAML copied', 1500, 'top-center', 'success')
    } catch {
      showToast('Copy failed', 1500, 'top-center', 'error')
    }
  },

  _updateBreadcrumbForLogs(res) {
    const nav = document.getElementById('breadcrumb')
    if (!nav) return
    nav.innerHTML = ''
    const addItem = (label, isLink, onClick) => {
      const el = document.createElement('span')
      el.className = 'breadcrumb-item' + (isLink ? ' breadcrumb-link' : '')
      el.textContent = label
      if (isLink && onClick) el.addEventListener('click', onClick)
      nav.appendChild(el)
    }
    const addSep = () => {
      const sep = document.createElement('span')
      sep.className = 'breadcrumb-sep'
      sep.textContent = '›'
      nav.appendChild(sep)
    }
    addItem(`${res.kind}s`, true, () => this.hideLogsView())
    addSep()
    addItem(res.metadata.name, false, null)
    addSep()
    addItem('Logs', false, null)
  },

  // ── Delete / scale / restart ────────────────────────────────

  startDelete() {
    this.delHolding = true
    this._deleteTimer = setTimeout(() => this._commitDelete(), 1500)
  },

  cancelDelete() {
    if (this._deleteTimer) {
      clearTimeout(this._deleteTimer)
      this._deleteTimer = null
    }
    this.delHolding = false
  },

  async _commitDelete() {
    this.delHolding = false
    this._deleteTimer = null
    await this.deleteDetailResource()
  },

  async deleteDetailResource() {
    const { kind, namespace, name } = this.detailData
    slog.info('🗑️ delete attempt', { kind, namespace, name })
    try {
      const r = await timedFetch(`api/resources/${namespace}/${kind}/${name}`, {
        method: 'DELETE',
        headers: { 'X-Client-ID': getClientId() },
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${r.statusText}`)
      this.detailOpen = false
    } catch (err) {
      slog.error('💥 Failed to delete resource:', err)
      alert(`Failed to delete: ${err.message}`)
    }
  },

  async scaleResource() {
    const { kind, namespace, name, resource } = this.detailData
    const current = resource.spec?.replicas ?? resource.status?.replicas ?? 0
    const input = prompt(`Scale ${kind} "${name}" — enter new replica count:`, String(current))
    if (input === null) return

    const replicas = parseInt(input, 10)
    if (isNaN(replicas) || replicas < 0) {
      alert('Invalid replica count. Must be a non-negative integer.')
      return
    }

    slog.info('⚖️ scale attempt', { kind, namespace, name, replicas, from: current })
    try {
      const r = await timedFetch(`api/resources/${namespace}/${kind}/${name}/scale`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Client-ID': getClientId() },
        body: JSON.stringify({ replicas }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${r.statusText}`)
      showToast(`Scaled ${name} to ${replicas} replicas`)
    } catch (err) {
      slog.error('💥 Failed to scale resource:', err)
      alert(`Failed to scale: ${err.message}`)
    }
  },

  async restartResource() {
    const { kind, namespace, name } = this.detailData
    if (!confirm(`Rollout restart ${kind} "${name}"?`)) return

    slog.info('🔄 restart attempt', { kind, namespace, name })
    try {
      const r = await timedFetch(`api/resources/${namespace}/${kind}/${name}/restart`, {
        method: 'POST',
        headers: { 'X-Client-ID': getClientId() },
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${r.statusText}`)
      showToast(`Restarted ${name}`)
    } catch (err) {
      slog.error('💥 Failed to restart resource:', err)
      alert(`Failed to restart: ${err.message}`)
    }
  },

  _cancelPendingDelete() {
    if (this._deletePendingTimer) {
      clearTimeout(this._deletePendingTimer)
      this._deletePendingTimer = null
    }
    this.delPending = false
  },

  /**
   * Close the top-most open UI layer. Returns true if something closed.
   * Layers are listed from top (closed first) to bottom (closed last); only
   * the first matching branch runs, so one Esc press closes exactly one layer.
   */
  _closeTopLayer() {
    if (this.showConfigDialog) {
      this.showConfigDialog = false
      return true
    }
    if (this.showEventsDialog) {
      this.showEventsDialog = false
      return true
    }
    if (this.inLogsView) {
      this.hideLogsView()
      return true
    }
    if (this.inGraphView && this.graphInspect.mode === 'resource') {
      // First Esc in graph view drops the inspector selection back to the
      // cluster summary; a second Esc closes the graph view.
      this._showGraphSummary()
      return true
    }
    if (this.inGraphView) {
      this.hideGraphView()
      return true
    }
    if (this.sidebarPeekOpen) {
      this.sidebarPeekOpen = false
      return true
    }
    if (this.detailMoreOpen) {
      this.detailMoreOpen = false
      return true
    }
    if (this.delPending) {
      this._cancelPendingDelete()
      this._updateHintBar()
      return true
    }
    if (document.activeElement?.id === 'searchInput') {
      const input = /** @type {HTMLInputElement} */ (document.activeElement)
      input.value = ''
      input.dispatchEvent(new Event('input'))
      input.blur()
      this.searchOpen = false
      return true
    }
    if (this.searchOpen) {
      this.searchOpen = false
      this.searchQuery = ''
      return true
    }
    if (this.detailExpanded) {
      this._setDetailExpanded(false, { animate: true })
      return true
    }
    if (this.detailOpen) {
      this.detailOpen = false
      this._updateHintBar()
      return true
    }
    if (this.navStack.length > 0) {
      this.navBack()
      return true
    }
    return false
  },

  // ── Sidebar peek (swipe-in drawer) ───────────────────────────

  _sidebarPeekInit() {
    // Swipe right anywhere in the left half of the viewport (including on
    // the icon-only sidebar itself) to peek-open the collapsed sidebar.
    // Swipe left (anywhere) while open closes it. Pointer events cover
    // both touch and mouse. Only active at ≤700px — otherwise the
    // sidebar is already full width.
    const MIN_DX = 40
    const MAX_MS = 500
    let sx = null,
      sy = null,
      st = 0,
      inLeftHalf = false

    const onDown = (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      sx = e.clientX
      sy = e.clientY
      st = performance.now()
      inLeftHalf = e.clientX < window.innerWidth / 2
    }
    const onUp = (e) => {
      if (sx === null) return
      const dx = e.clientX - sx
      const dy = e.clientY - sy
      const dt = performance.now() - st
      const startedInLeftHalf = inLeftHalf
      sx = null
      if (dt > MAX_MS) return
      if (Math.abs(dy) > Math.abs(dx) * 0.6) return
      if (Math.abs(dx) < MIN_DX) return
      if (this.inLogsView || this.inExecView) return
      if (window.innerWidth > 700) return
      if (!this.sidebarPeekOpen && dx > 0 && startedInLeftHalf) {
        this.sidebarPeekOpen = true
      } else if (this.sidebarPeekOpen && dx < 0) {
        this.sidebarPeekOpen = false
      }
    }
    document.addEventListener('pointerdown', onDown, { passive: true })
    document.addEventListener('pointerup', onUp, { passive: true })

    // Force-close when the viewport grows past the narrow breakpoint.
    window.addEventListener('resize', () => {
      if (window.innerWidth > 700 && this.sidebarPeekOpen) {
        this.sidebarPeekOpen = false
      }
    })
  },

  // ── Exec / shell view ────────────────────────────────────────

  showExecView(res) {
    slog.info('exec view open', { namespace: res.metadata?.namespace, pod: res.metadata?.name })
    this._teardownExec()
    this.execRes = res
    const containers = [...(res.spec?.containers || []), ...(res.spec?.initContainers || [])].map((c) => c.name)
    this.execContainers = containers
    this.execContainer = containers[0] || ''
    this.inExecView = true
    this._updateHintBar()
    this.$nextTick(() => this._connectExec())
  },

  hideExecView() {
    slog.info('exec view close')
    this._teardownExec()
    this.inExecView = false
    this.execRes = null
    const kind = this._currentKind()
    this._updateBreadcrumb(kind, this._getKindData(kind).length)
    this._updateHintBar()
  },

  _reconnectExec() {
    this._teardownExec()
    this.$nextTick(() => this._connectExec())
  },

  _teardownExec() {
    if (this._execClient) {
      this._execClient.teardown()
      this._execClient = null
    }
  },

  _connectExec() {
    if (!this.execRes) return
    const el = document.getElementById('execTerminal')
    if (!el) return

    this._execClient = createExecClient({
      namespace: this.execRes.metadata.namespace,
      pod: this.execRes.metadata.name,
      container: this.execContainer,
      termElement: el,
    })
    this._execClient.connect()
  },

  // ── Command palette ──────────────────────────────────────────

  /**
   * Open the command palette pre-filled with a prefix (e.g. "ns " or "ctx ")
   * @param {string} prefix
   */
  _openPaletteWith(prefix) {
    this.cmdInput = prefix
    this.cmdSelectedIdx = -1
    this.cmdMode = true
  },

  _cmdSuggestions() {
    return buildSuggestions(this.cmdInput, {
      namespaces: this.namespaces,
      contexts: this.contexts,
      resourceGroups: this.resourceGroups,
    })
  },

  /** ↓ — move highlight down, wrapping past the last item back to no-selection (-1) */
  _cmdMoveDown() {
    const len = this._cmdSuggestions().length
    if (!len) return
    this.cmdSelectedIdx = this.cmdSelectedIdx >= len - 1 ? -1 : this.cmdSelectedIdx + 1
  },

  /** ↑ — move highlight up, wrapping from no-selection (-1) to the last item */
  _cmdMoveUp() {
    const len = this._cmdSuggestions().length
    if (!len) return
    this.cmdSelectedIdx = this.cmdSelectedIdx <= -1 ? len - 1 : this.cmdSelectedIdx - 1
  },

  /** Tab — fill the highlighted (or first) suggestion; reset selection so Enter executes the filled text */
  _cmdTabComplete() {
    const suggestions = this._cmdSuggestions()
    if (!suggestions.length) return
    const idx = this.cmdSelectedIdx >= 0 ? this.cmdSelectedIdx : 0
    this.cmdInput = suggestions[idx]?.cmd || this.cmdInput
    this.cmdSelectedIdx = -1
  },

  /**
   * Enter key handler — fills meta-commands (ns/ctx) into the input for further typing
   * rather than executing an incomplete command.
   */
  _handleCmdEnter() {
    const suggestions = this._cmdSuggestions()
    if (this.cmdSelectedIdx >= 0 && this.cmdSelectedIdx < suggestions.length) {
      const s = suggestions[this.cmdSelectedIdx]
      // Meta-commands end with a space — fill them in for the user to complete
      if (s.cmd.endsWith(' ')) {
        this.cmdInput = s.cmd
        this.cmdSelectedIdx = -1
        return
      }
      this._execCmd(s.cmd)
    } else {
      this._execCmd(this.cmdInput)
    }
  },

  /**
   * Execute a command string from the palette
   * @param {string} input
   */
  _execCmd(input) {
    const parsed = parseCommand(input, {
      namespaces: this.namespaces,
      contexts: this.contexts,
      resourceGroups: this.resourceGroups,
    })

    this.cmdMode = false
    this.cmdInput = ''
    this.cmdSelectedIdx = -1

    if (!parsed) {
      slog.debug('palette no-match', { input })
      return
    }

    slog.info('palette', { type: parsed.type, arg: parsed.arg })

    if (parsed.type === 'ns') this.namespace = parsed.arg
    else if (parsed.type === 'ctx') this.switchContext(parsed.arg)
    else if (parsed.type === 'kind') this.selectKind(parsed.arg)
    else if (parsed.type === 'action') {
      if (parsed.arg === 'refresh') this.refreshAll()
      else if (parsed.arg === 'events') this.showEventsDialog = true
      else if (parsed.arg === 'cfg') this.showConfigDialog = true
      else if (parsed.arg === 'pause') this.togglePaused()
    }
  },

  // Return to a Pod's detail pane from the logs or exec view. Captures
  // the resource before closing the view (hide* clears the ref).
  _backToPodDetail() {
    const res = this.logsRes || this.execRes
    if (!res) return
    if (this.inLogsView) this.hideLogsView()
    if (this.inExecView) this.hideExecView()
    selectRow(res.metadata.uid)
    this._openDetail(res)
    this._updateHintBar()
  },

  // Jump to a referenced resource by kind+name. Switches the visible
  // kind, selects the matching row, and opens the detail pane. If the
  // ref isn't currently in the cache (e.g. cluster-scoped kind not yet
  // fetched), surfaces a toast rather than failing silently.
  _jumpToRef(kind, _namespace, name) {
    if (!kind || !name) return
    this.selectKind(kind)
    const res = getResByName(kind, name)
    if (res) {
      selectRow(res.metadata.uid)
      this._openDetail(res)
      this._updateHintBar()
    } else {
      showToast(`${kind} "${name}" not loaded`, 2000, 'top-center', 'warning')
    }
  },

  // Copy text to the clipboard and surface a transient toast. Used by
  // the clickable name/value affordances throughout the detail pane.
  async _copyToClipboard(text, label) {
    if (!text) return
    try {
      await navigator.clipboard.writeText(String(text))
      showToast(label || 'Copied', 1500, 'top-center', 'success')
    } catch {
      showToast('Copy failed', 1500, 'top-center', 'error')
    }
  },

  _updateHintBar() {
    const bar = document.getElementById('hintBar')
    if (!bar) return
    // Tier 1 = always visible, Tier 2 = hidden ≤1100px, Tier 3 = hidden ≤900px
    const hints = []
    if (this.inExecView) {
      // No keyboard shortcuts while exec is open — user closes via the Close button
    } else if (this.inLogsView) {
      hints.push({ key: 'r', label: 'refresh', tier: 2 }, { key: 'esc', label: 'back', tier: 3 })
    } else {
      const res = getSelectedResource()
      const kind = this._currentKind()
      hints.push({ key: '↑↓', label: 'navigate', tier: 3 }, { key: 'r', label: 'refresh', tier: 2 })
      if (res) {
        if (DRILL_DOWN[kind]) hints.push({ key: '↵', label: DRILL_DOWN[kind].childKind.toLowerCase() + 's', tier: 3 })
        if (kind === 'Pod')
          hints.push({ key: '↵', label: 'logs', tier: 3 }, { key: 'l', label: 'logs', tier: 2 }, { key: 'e', label: 'exec', tier: 2 })
      }
      if (this.searchQuery) {
        hints.push({ key: '/', label: 'search active', active: true, tier: 1 })
      } else {
        hints.push({ key: '/', label: 'search', tier: 1 })
      }
      hints.push({ key: ':', label: 'command', tier: 1 })
      if (this.detailOpen) {
        hints.push({ key: 'd', label: this.delPending ? 'confirm delete!' : 'delete', tier: 2 })
      }
      if (this.detailOpen || this.navStack.length > 0) hints.push({ key: 'esc', label: 'back', tier: 3 })
    }
    const html = hints
      .map((h) => {
        const cls = `hint-item${h.active ? ' is-active' : ''}`
        const tier = h.tier || 1
        // ↑↓ is a keyboard-only affordance; render as span so it isn't
        // clickable. Everything else becomes a real button that invokes
        // the same handler as its key (see _hintAction + the delegated
        // listener wired in init()).
        if (h.key === '↑↓') {
          return `<span class="${cls}" data-tier="${tier}"><kbd>${h.key}</kbd>${h.label}</span>`
        }
        return `<button type="button" class="${cls}" data-tier="${tier}" data-hint-key="${h.key}"><kbd>${h.key}</kbd>${h.label}</button>`
      })
      .join('')
    // Skip the DOM write when nothing changed — _updateHintBar is called
    // from many sites (including SSE updates) that don't actually affect
    // the hint set, and innerHTML assignment repaints kbd children each
    // time, which reads as a visible blink.
    if (html === this._lastHintBarHtml) return
    this._lastHintBarHtml = html
    bar.innerHTML = html
  },

  // Dispatch a hint-bar click to the same behavior as pressing the key.
  // Mirrors the keydown handlers in init() — kept in sync with those
  // branches. Non-actionable keys (↑↓) never reach this because the
  // template renders them as <span>.
  _hintAction(key) {
    if (key === 'r') {
      if (this.inLogsView && this.logsRes) this._fetchLogs(this.logsRes)
      else if (!this.inExecView) this.refreshAll()
      return
    }
    if (key === 'esc') {
      this._closeTopLayer()
      return
    }
    if (key === '/') {
      if (this.inGraphView) this.focusGraphSearch()
      else this.openSearch()
      return
    }
    if (key === ':') {
      if (this.inLogsView) return
      this.cmdMode = true
      this.cmdInput = ''
      this.cmdSelectedIdx = -1
      return
    }
    if (key === 'l') {
      const res = getSelectedResource()
      if (res?.kind === 'Pod') this.showLogsView(res)
      return
    }
    if (key === 'e') {
      const res = getSelectedResource()
      if (res?.kind === 'Pod') this.showExecView(res)
      return
    }
    if (key === '↵') {
      const res = getSelectedResource()
      if (!res) return
      if (DRILL_DOWN[res.kind]) this.drillDown(res)
      else if (res.kind === 'Pod') this.showLogsView(res)
      return
    }
    if (key === 'd') {
      if (!this.detailOpen) return
      if (!this.delPending) {
        this.delPending = true
        this._deletePendingTimer = setTimeout(() => {
          this.delPending = false
          this._deletePendingTimer = null
          this._updateHintBar()
        }, 3000)
      } else {
        this._cancelPendingDelete()
        this.deleteDetailResource()
      }
      this._updateHintBar()
    }
  },
}))

// Register sub child-components
Alpine.data('eventsDialog', eventsDialog)

// Initialize & start!
Alpine.start()
