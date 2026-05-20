//@ts-check

// ==========================================================================================
// Canvas2D + d3-force graph renderer.
//
// Public surface:
//   initGraph / getGraph / destroyGraph
//   replayResources / addResource / updateResource / removeResource
//   setOnNodeClick / setLayout / layout / setIconOverlay
//   fitToVisible / nodeVisByLabel / setKindVisibility / focusByDepth / hideOrphans
//   setData (lower-level, bulk replacement of the whole node set)
//
// Visual model: colored circles + label. Pod color encodes readiness (green /
// red / grey); workload kinds (Deployment / RS / StatefulSet / DaemonSet / Job
// / PVC) follow the same status logic. Stateless kinds (Service / ConfigMap /
// Secret / Ingress / Node / Namespace) get a kind-fixed color. Edge color
// encodes semantic link type (owner / network / mount / env-ref) — same palette
// as the legend in fragments/table.html.
//
// Optional K8s icon overlay (opt-in via setIconOverlay, persisted as the
// graphIconOverlay config flag): when on, the official Kubernetes glyph
// (rasterized in graph-icons.js) replaces the per-kind shape and status moves
// to a thin ring around it. Perf-gated — only at zoom ≥ iconZoomMin and ≤
// iconNodeCap nodes. K8s pack only; independent of the DOM-side kaIconStyle.
//
// Layout: a single d3-force simulation with link / charge / center / collide
// runs continuously; SSE adds/updates restart it with low alpha so the graph
// stays organic without us managing per-tick state.
// ==========================================================================================

import { getResByIP, getResByName, getResById, queryRes, remove as cacheRemove, store } from './cache.js'
import { getConfig } from './config.js'
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from '../ext/d3-force.esm.js'
import { iconImageFor, warmIcons, clearIconCache } from './graph-icons.js'
import { log, kaLog } from './log.js'

// ===== visual config =======================================================
const NODE_RADIUS = 10 // default/fallback radius; per-kind sizes live in NODE_GEOM
const ZERO_ANCHOR = { x: 0, y: 0 } // cluster-force fallback for unknown namespace
const DIM_ALPHA = 0.18
const LABEL_OUTLINE_PX = 3 // bg-coloured halo behind label text; keeps it legible over edges + red status fills

// Pre-tick "settle": after a bulk replay/setData we advance the force sim
// synchronously so the graph opens already laid-out instead of blooming from
// canvas centre on screen. Bounded by both a tick cap and a wall-clock budget
// so a large cluster (≥ ~500 nodes) can't freeze the open — it just opens a
// little less relaxed. SETTLE_ALPHA_FLOOR early-outs once converged so small
// clusters don't waste ticks. Tuned at ~500 resources; ceiling validated at
// ~660 resources.
const SETTLE_MAX_TICKS = 500
const SETTLE_BUDGET_MS = 350
const SETTLE_ALPHA_FLOOR = 0.02
const SETTLE_RESUME_ALPHA = 0.05 // gentle live motion after pre-tick

// Open "reveal": the pre-tick removed the old on-screen bloom (graph exploding
// from centre), which also lost the "this is a live force layout" theatre. We
// bring the theatre back as a *controlled* reveal of the already-settled,
// already-framed graph over REVEAL_MS. Several interchangeable styles are
// available (see REVEAL_STYLES); pick via setRevealStyle(). Every style is a
// pure draw-time camera/alpha/clip effect — node x/y, hit-test, and the fit
// all stay on final coords, so none can destabilise the layout, and all
// converge to identity at p=1 so the graph lands exactly on the fitted frame.
const REVEAL_MS = 520
const REVEAL_SCALE_MIN = 0.16 // 'bloom': start size as a fraction of the fitted layout
const REVEAL_ZOOM_FROM = 1.8 // 'zoom': start scale (dolly back to 1.0)
const REVEAL_RISE_FRAC = 0.18 // 'rise': start offset as a fraction of the viewport height
const DEFAULT_REVEAL_STYLE = 'bloom'

// ===== simulation params ===================================================
// Force-layout knobs. Defaults match the long-tuned literals that used to be
// inline in _restartSim. setSimParams() can override them and persist via
// config.js (cfg.graphSim). _restartSim reads from `simParams` (never the
// literals) so live overrides take effect on the next restart.
export const SIM_DEFAULTS = {
  chargeStrength: -180,
  chargeDistanceMax: 400,
  linkDistance: 60,
  linkStrength: 0.4,
  centerStrength: 0.03,
  collideStrength: 1,
  collideIterations: 3,
  velocityDecay: 0.45,
  // Cool-down rate. The original 0.025 + the per-namespace cluster force
  // drifted visibly for 10s+ after open (the real culprit was centre-spawn
  // migration, now fixed by anchor pre-seeding). 0.03 keeps a gentle, bounded
  // organic ease-out (~5-7s to rest) rather than an abrupt freeze.
  alphaDecay: 0.03,
  // Per-namespace clustering: a gentle forceX/forceY toward each namespace's
  // anchor on a ring. Without this every namespace intermixes into one blob
  // and the territory hulls/labels all stack at the centre (useless). Low
  // enough that link/charge still shape intra-namespace structure.
  clusterStrength: 0.09,
  // Semantic-zoom LOD bands (keyed off camera `scale`). Layers crossfade
  // over a band via _smoothstep so there's no hard pop:
  //   scale < lodNsMax              → namespace layer (territories + ns labels)
  //   lodNsMax ≤ scale < lodPodMin  → workload layer (per-group labels)
  //   scale ≥ lodPodMin             → pod layer (per-node labels)
  lodNsFadeLo: 0.28, // ns territory alpha = 1 below this …
  lodNsFadeHi: 0.5, // … → 0 above this
  lodWlFadeLo: 0.32, // workload labels fade in over [lo,mid]
  lodWlFadeHi: 1.05, // … and out by here (as pod labels take over)
  lodPodFadeLo: 0.7, // pod labels fade in over [lo,hi] (was LABEL_FADE_ZOOM_*)
  lodPodFadeHi: 0.95,
  // Optional K8s icon overlay perf gates: only drawn at/above this zoom and
  // below this node count (decode + drawImage cost doesn't scale to huge n).
  iconZoomMin: 0.6,
  iconNodeCap: 1200,
}
let simParams = { ...SIM_DEFAULTS }

// Seed simParams from persisted config (cfg.graphSim). Called from initGraph
// rather than at module-eval so we don't touch localStorage before the app
// is ready.
function _seedSimParams() {
  try {
    const cfg = getConfig()
    if (cfg && cfg.graphSim && typeof cfg.graphSim === 'object') {
      simParams = { ...SIM_DEFAULTS, ...cfg.graphSim }
    }
  } catch (err) {
    glog.debug('simParams seed skipped', { err: err?.message || String(err) })
  }
}

// ===== node geometry =======================================================
// Per-kind shape + radius. NODE_GEOM holds per-kind shape/size; the draw
// pass uses n.shape / n.r and the collide force uses the radius accessor.
// Shape + radius per kind. Radius is the circumscribed radius (collide +
// hit-test use it). Size encodes scope: Node biggest, workload controllers
// bigger than Pods, config/secret smallest — so the eye reads importance
// before reading any label. Shape encodes role; status/kind colour still
// fills it (unchanged from before).
const NODE_GEOM = {
  Node: { shape: 'hexagon', radius: 16 },
  PersistentVolume: { shape: 'cylinder', radius: 13 },
  PersistentVolumeClaim: { shape: 'cylinder', radius: 11 },
  Deployment: { shape: 'roundsquare', radius: 13 },
  StatefulSet: { shape: 'roundsquare', radius: 13 },
  DaemonSet: { shape: 'roundsquare', radius: 13 },
  ReplicaSet: { shape: 'roundsquare', radius: 11 },
  Job: { shape: 'diamond', radius: 12 },
  CronJob: { shape: 'diamond', radius: 13 },
  Service: { shape: 'triangle', radius: 12 },
  Ingress: { shape: 'triangleDown', radius: 12 },
  HorizontalPodAutoscaler: { shape: 'gauge', radius: 11 },
  Pod: { shape: 'circle', radius: 9 },
  ConfigMap: { shape: 'square', radius: 8 },
  Secret: { shape: 'hexagon', radius: 8 },
}
function kindGeom(kind) {
  return NODE_GEOM[kind] || { shape: 'circle', radius: NODE_RADIUS }
}

// Trace a kind's shape onto ctx, centered at (x,y), circumscribed radius r.
// Path only — caller sets fillStyle and calls fill(). No save/restore so it
// stays as cheap as the old single arc().
function _tracePath(c, shape, x, y, r) {
  c.beginPath()
  switch (shape) {
    case 'roundsquare': {
      const s = r * 0.82
      const rad = r * 0.28
      c.moveTo(x - s + rad, y - s)
      c.arcTo(x + s, y - s, x + s, y + s, rad)
      c.arcTo(x + s, y + s, x - s, y + s, rad)
      c.arcTo(x - s, y + s, x - s, y - s, rad)
      c.arcTo(x - s, y - s, x + s, y - s, rad)
      c.closePath()
      break
    }
    case 'square': {
      const s = r * 0.8
      c.rect(x - s, y - s, s * 2, s * 2)
      break
    }
    case 'diamond':
      c.moveTo(x, y - r)
      c.lineTo(x + r, y)
      c.lineTo(x, y + r)
      c.lineTo(x - r, y)
      c.closePath()
      break
    case 'triangle': {
      const h = r * 1.15
      c.moveTo(x, y - h)
      c.lineTo(x + h * 0.95, y + h * 0.6)
      c.lineTo(x - h * 0.95, y + h * 0.6)
      c.closePath()
      break
    }
    case 'triangleDown': {
      const h = r * 1.15
      c.moveTo(x, y + h)
      c.lineTo(x + h * 0.95, y - h * 0.6)
      c.lineTo(x - h * 0.95, y - h * 0.6)
      c.closePath()
      break
    }
    case 'hexagon':
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i - Math.PI / 2
        const px = x + r * Math.cos(a)
        const py = y + r * Math.sin(a)
        if (i === 0) c.moveTo(px, py)
        else c.lineTo(px, py)
      }
      c.closePath()
      break
    case 'cylinder': {
      // Storage barrel: rounded body + elliptical cap.
      const w = r * 0.78
      const hh = r
      const ry = r * 0.32
      c.moveTo(x - w, y - hh + ry)
      c.ellipse(x, y - hh + ry, w, ry, 0, Math.PI, 0)
      c.lineTo(x + w, y + hh - ry)
      c.ellipse(x, y + hh - ry, w, ry, 0, 0, Math.PI)
      c.lineTo(x - w, y - hh + ry)
      c.closePath()
      break
    }
    case 'gauge': {
      // Dial wedge: 3/4 disc with a notch — reads as a meter.
      c.moveTo(x, y)
      c.arc(x, y, r, Math.PI * 0.75, Math.PI * 0.25)
      c.closePath()
      break
    }
    default: // 'circle'
      c.arc(x, y, r, 0, Math.PI * 2)
  }
}

// Theme-derived colour tables. Resolved from CSS custom properties at module
// init and rebuilt on `kaThemeChange` so the canvas tracks the active theme
// without callers needing to know it switched. CSS is the source of truth —
// see :root and [data-theme="light"] in public/css/main.css.
let BG = '#1a1a1a'
let LABEL_COLOR = '#e6e6e6'
let STATUS_COLORS = { green: '#3ecf8e', red: '#ff6b6b', grey: '#9aa0a6' }
let KIND_COLORS = {}
let DEFAULT_COLOR = '#9aa0a6'
let EDGE_COLORS = { owner: '#9aa0a6', network: '#4a9eff', mount: '#3ecf8e', 'env-ref': '#f5a623' }

const _cssVar = (name, fallback) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

const _rebuildPalette = () => {
  BG = _cssVar('--bg-app', '#0f1117')
  LABEL_COLOR = _cssVar('--text-primary', '#e6e6e6')
  STATUS_COLORS = {
    green: _cssVar('--success-text-soft', '#86efac'),
    red: _cssVar('--danger-text', '#f87171'),
    grey: _cssVar('--edge-owner', '#9aa0a6'),
  }
  EDGE_COLORS = {
    owner: _cssVar('--edge-owner', '#9aa0a6'),
    network: _cssVar('--edge-network', '#4a9eff'),
    mount: _cssVar('--edge-mount', '#3ecf8e'),
    'env-ref': _cssVar('--edge-env', '#f5a623'),
  }
  DEFAULT_COLOR = EDGE_COLORS.owner
  // Kind → fill colour, used when statusColour() returns '' (kinds with no
  // status concept). Hues align with edges/status tokens so the legend
  // reads as one palette.
  const accent = _cssVar('--accent-softer', '#4a9eff')
  const node = _cssVar('--text-primary', '#e6e6e6')
  const mount = EDGE_COLORS.mount
  const env = EDGE_COLORS.env || EDGE_COLORS['env-ref']
  KIND_COLORS = {
    Service: '#9b6bff',
    Ingress: '#9b6bff',
    ConfigMap: env,
    Secret: _cssVar('--danger-text', '#f87171'),
    PersistentVolume: mount,
    Node: node,
    Namespace: EDGE_COLORS.owner,
    HorizontalPodAutoscaler: accent,
    Deployment: accent,
    ReplicaSet: accent,
    StatefulSet: accent,
    DaemonSet: accent,
    Job: accent,
    CronJob: accent,
  }
}

_rebuildPalette()
// Theme switches: flush the cached statusColour table (status hex changes
// in light mode) and request a redraw on the next animation frame.
window.addEventListener('kaThemeChange', () => {
  _rebuildPalette()
  statusCache.clear()
  clearIconCache()
  _invalidate('theme')
})
// An icon image finished decoding — repaint so it appears even if the sim
// has already gone idle.
window.addEventListener('kaGraphIconReady', () => {
  if (canvas) _invalidate('icon-ready')
})

// ===== module state ========================================================
let canvas = null
let ctx = null
let resizeObserver = null
let dpr = 1
let width = 0
let height = 0

let nodes = [] // d3-force mutates these in place (adds x/y/vx/vy)
let edges = []
let nodeById = new Map()
let neighborSets = new Map() // id → Set<id>
let nsGroups = new Map() // namespace → Set<id>   (used by LOD layers)
let wlGroups = new Map() // groupId (top owner uid) → Set<id>

// Semantic-zoom caches. Recomputed lazily (only when a LOD layer that needs
// them is actually on screen AND something changed) — never per frame.
//   _territories: [{ ns, cx, cy, angle, ext, hull:[[x,y]...] }]
//   _wlLabels:    [{ text, cx, cy, n }]
let _territories = []
let _wlLabels = []
let _lodDirty = true // set on group rebuild + when the sim re-settles
let _nsAnchors = new Map() // namespace → { x, y } ring anchor for the cluster force
let _iconOverlay = false // opt-in K8s icon overlay (set by main.js from config)

// Uniform grid spatial index over node positions for O(1)-ish hit-testing.
// Rebuilt when the sim cools (positions stop changing). While it's stale
// (sim still hot) _hitTest falls back to the linear scan, so behavior is
// byte-identical to before — the grid is a pure speedup once settled.
const GRID_CELL = 60 // world units; > hit radius so a 3×3 query is exhaustive
let grid = new Map() // "cx,cy" → node[]
let _gridStale = true

let sim = null

let scale = 1
let tx = 0
let ty = 0
let _cameraCentered = false // first valid _resize seeds tx/ty to canvas center
let _pendingFit = false // _settle armed a one-shot fit; first valid _resize consumes it
let _pruneOrphans = false // mirror replay's pruneOrphans on the incremental path
let _revealing = false // open reveal animation in flight
let _revealT0 = 0 // performance.now() when the reveal was armed (at fit time)
let _revealCx = 0 // reveal pivot = centroid of the fitted layout (world coords)
let _revealCy = 0
let _revealR = 0 // max node distance from the pivot (world units) — for 'iris'
let _revealStyle = DEFAULT_REVEAL_STYLE // active style key; set via setRevealStyle()

let hoverId = null
let dragging = null
let panning = null

let rafId = null
let needsDraw = true

// Render-activity sampler. The per-frame repaint paths (sim 'tick', reveal
// keepalive) are deliberately unlogged — but "the canvas keeps painting and
// nothing in the buffer says why" is exactly the bug that silence hides. This
// rolls every repaint cause into ONE debug line every _ACTIVITY_MS, emitted
// only when frames were actually drawn: ≤1 line / 2s while busy, silent when
// idle. The same snapshot is mirrored to window._gcActivity (cf. _gcLastSettleMs
// / _gcRevealP) so it's inspectable from the console without raising the log
// level — the lowest-friction path when chasing a no-interaction repaint.
const _ACTIVITY_MS = 2000
let _drawCount = 0 // _draw() calls since last sample
let _tickRepaints = 0 // needsDraw set by the sim 'tick' handler (otherwise unlogged)
const _invalReasons = new Map() // reason → count since last sample
let _activityLast = 0 // performance.now() of last sample emit

let onNodeClick = null // (uid) => void — set by main.js to wire the inspector
let onBackgroundClick = null // () => void — empty-canvas click clears selection
let onStatsChange = null // (stats) => void — feeds the graph status bar
let _statsRaf = null // rAF id; coalesces stat emits during SSE/filter bursts
let _mouseDownAt = null // { x, y, hitId } — used to distinguish click from drag

const statusCache = new Map() // uid → { rv, colour }

// ===== debug logging =======================================================
// Backed by the shared logger in ./log.js. Toggle via console:
//   kaLog.setLevel('debug')        — show graph debug lines + buffer them
//   kaLog.download()               — save the global ring buffer
// The graph-view 🛑 NaN canary fires at warn (always on by default).
const glog = log.ns('graph')
const dbg = (...args) => glog.debug(...args)
const dbgWarn = (...args) => glog.warn(...args)
const dbgError = (...args) => glog.error(...args)
const camSnap = () => ({
  scale: +scale.toFixed(3),
  tx: +tx.toFixed(1),
  ty: +ty.toFixed(1),
  w: width,
  h: height,
})

// Single render-invalidation seam. Every data / state / filter / lifecycle
// change that should repaint funnels through here, so a missing or spurious
// redraw is one grep + one log line away instead of a bisect across ~20 raw
// flag sets. The lazy needsDraw gate is what turns a *forgotten* invalidate
// into a user-visible "graph went stale" bug — the sim goes idle, nothing
// repaints — so the logged reason is the breadcrumb that tells a triager
// whether a mutation fired without a matching redraw (or fired one for nothing).
//
// Deliberately NOT routed through here, kept as raw `needsDraw = true`: the
// sim 'tick' handler and the reveal keepalive (per-frame — would flood the
// buffer), and the direct pointer/scroll handlers (per-mousemove, or already
// self-logged at their own handler). Same rule as the rest of the codebase:
// per-frame paths stay silent.
function _invalidate(reason) {
  needsDraw = true
  _invalReasons.set(reason, (_invalReasons.get(reason) || 0) + 1)
  dbg('redraw', { reason })
}

// ===== public surface ======================================================

/**
 * Initialize the renderer. Force is the only layout.
 * @param {HTMLElement} container
 */
export function initGraph(container) {
  if (canvas) return getGraph()

  glog.debug('init')
  _seedSimParams()

  canvas = document.createElement('canvas')
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;cursor:grab;background:' + BG
  container.appendChild(canvas)
  ctx = canvas.getContext('2d')

  _resize()
  // Container size can change without a window resize — Alpine x-show
  // toggling, sidebar collapse, splitter drags. ResizeObserver on the
  // parent catches all of them. Also covers the init-time case where
  // _resize() runs before layout has flushed and reads 0×0.
  resizeObserver = new ResizeObserver(() => _resize())
  resizeObserver.observe(container)
  window.addEventListener('resize', _resize)

  canvas.addEventListener('wheel', _onWheel, { passive: false })
  canvas.addEventListener('mousedown', _onMouseDown)
  window.addEventListener('mousemove', _onMouseMove)
  window.addEventListener('mouseup', _onMouseUp)

  _startLoop()
  return getGraph()
}

/** Returns a thin handle. The `g` arg passed to filter helpers below is ignored. */
export function getGraph() {
  if (!canvas) return null
  return {
    canvas,
    get nodes() {
      return nodes
    },
    get edges() {
      return edges
    },
  }
}

/**
 * Request a repaint with no state change. Thin public wrapper over the
 * `_invalidate` seam — for callers that mutated something the renderer reads
 * but that isn't owned by one of the mutator exports (e.g. an external
 * style/CSS-var change). State-changing callers should use the matching
 * mutator instead; it already invalidates.
 */
export function redraw(reason = 'external') {
  if (canvas) _invalidate(reason)
}

/**
 * Bulk replay used on first open / namespace switch. Mirrors graph.js
 * replayResources: caches every resource (so processLinks can resolve cross-
 * references during the link pass), filters out non-graph kinds (Endpoints,
 * EndpointSlice, Event), then runs a single processLinks pass over the lot.
 * @param {Array<any>} resources
 * @param {{ pruneOrphans?: boolean }} [opts]
 */
export function replayResources(resources, opts = {}) {
  if (!canvas || !resources || resources.length === 0) return

  // Remember the prune decision so the incremental SSE path (_reconcile) can
  // apply the same orphan filter — otherwise every heartbeat update for a
  // pruned orphan re-injected it as a node + re-warmed the sim.
  _pruneOrphans = !!opts.pruneOrphans

  const _t0 = performance.now()
  for (const r of resources) store(r)

  const newNodes = []
  const seen = new Set()
  const cfg = getConfig()
  for (const r of resources) {
    const k = r.kind
    if (k === 'Endpoints' || k === 'EndpointSlice' || k === 'Event') continue
    if (cfg.resFilter && !cfg.resFilter.includes(k)) continue
    const id = r.metadata?.uid
    if (!id || seen.has(id)) continue
    seen.add(id)
    const node = _makeNode(r)
    if (node) newNodes.push(node)
  }

  nodes = newNodes
  nodeById = new Map(nodes.map((n) => [n.id, n]))

  // One processLinks pass over everything in the cache. knownIds is the post-
  // add node set so cross-refs resolve cleanly within a single batch. Errors
  // are swallowed so one malformed resource can't break the whole replay;
  // we surface the first one + a count so the buffer captures the signal.
  const knownIds = new Set(nodeById.keys())
  const pendingEdges = new Map()
  let processErrors = 0
  for (const r of resources) {
    try {
      _processLinks(r, knownIds, pendingEdges)
    } catch (err) {
      if (processErrors === 0) {
        glog.warn('🛑 processLinks failed', { kind: r?.kind, name: r?.metadata?.name, err })
      }
      processErrors++
    }
  }
  if (processErrors > 1) glog.debug('processLinks burst', { errors: processErrors, total: resources.length })
  edges = Array.from(pendingEdges.values())

  if (opts.pruneOrphans) {
    const connected = new Set()
    for (const e of edges) {
      connected.add(typeof e.source === 'object' ? e.source.id : e.source)
      connected.add(typeof e.target === 'object' ? e.target.id : e.target)
    }
    nodes = nodes.filter((n) => connected.has(n.id))
    nodeById = new Map(nodes.map((n) => [n.id, n]))
  }

  _rebuildNeighborIndex()
  _restartSim(0.8)
  _settle() // pre-tick so the graph opens laid-out + framed, not blooming from centre
  _invalidate('replay')
  _emitStats()
  const _ms = Math.round(performance.now() - _t0)
  glog.debug('replay', { nodes: nodes.length, edges: edges.length, ms: _ms })
  if (_ms > 100) glog.warn('🐌 slow graph replay', { nodes: nodes.length, edges: edges.length, ms: _ms })
}

/** @param {any} res */
export function addResource(res) {
  if (res.kind === 'Endpoints' || res.kind === 'EndpointSlice') {
    store(res)
    _refreshServiceLinks(res)
    return
  }
  if (res.kind === 'Event') {
    store(res)
    window.dispatchEvent(new CustomEvent('kubeEventAdded', { detail: res }))
    return
  }
  const cfg = getConfig()
  if (cfg.resFilter && !cfg.resFilter.includes(res.kind)) {
    glog.debug(`🍇 skipping resource ${res.kind}: not in filter`)
    return
  }
  store(res)
  if (!canvas) return
  _addOrUpdateNode(res) // refresh fields if it's already a node; reconcile owns creation
  const structural = _reconcile()
  _rebuildNeighborIndex()
  if (structural) _restartSim(0.3) // only when the node set actually changed
  _invalidate('add')
  _emitStats()
  return res.metadata?.uid
}

/** @param {any} res */
export function updateResource(res) {
  if (res.kind === 'Endpoints' || res.kind === 'EndpointSlice') {
    store(res)
    _refreshServiceLinks(res)
    return
  }
  if (res.kind === 'Event') {
    store(res)
    window.dispatchEvent(new CustomEvent('eventsUpdated', { detail: res }))
    return
  }
  store(res)
  if (!canvas) return
  _addOrUpdateNode(res) // refresh fields in place if it's a node; reconcile owns creation
  // _reconcile derives the node set from connectivity, so a heartbeat update
  // that changes no topology returns false → no _restartSim → no re-bloom.
  // A genuinely new connected resource is materialized there; the structural
  // _restartSim then seeds its x/y (d3-force's h()), so no NaN spiral.
  const structural = _reconcile()
  _rebuildNeighborIndex()
  if (structural) _restartSim(0.3)
  _invalidate('update')
  _emitStats()
}

/**
 * Re-run processLinks on the Service that owns this Endpoints / EndpointSlice
 * so its network edges refresh. Endpoints/EndpointSlice resources are cache-only
 * — they never become nodes themselves.
 * @param {any} res
 */
function _refreshServiceLinks(res) {
  if (!canvas) return
  let serviceName = null
  if (res.kind === 'Endpoints') serviceName = res.metadata?.name
  else if (res.kind === 'EndpointSlice') serviceName = res.metadata?.labels?.['kubernetes.io/service-name']
  if (!serviceName) return
  const svc = getResByName('Service', serviceName)
  if (!svc) return
  // An Endpoints/EndpointSlice change can give a previously-orphan Service or
  // Pod its first edge — reconcile late-materializes it here.
  const structural = _reconcile()
  _rebuildNeighborIndex()
  if (structural) _restartSim(0.3)
  _invalidate('service-links')
  _emitStats()
}

/** @param {any} res */
export function removeResource(res) {
  const uid = res.metadata?.uid
  cacheRemove(uid)
  if (!canvas || !uid) return
  statusCache.delete(uid)
  // Resource is gone from the cache → no longer a reconcile candidate; this
  // also drops any node that was only connected through it (now an orphan).
  const structural = _reconcile()
  _rebuildNeighborIndex()
  if (structural) _restartSim(0.2)
  _invalidate('remove')
  _emitStats()
}

/** Force only — kept for API compat. */
export async function setLayout(_kind) {
  _restartSim(0.5)
}

/** Register a click handler — fires when a node is clicked without dragging. */
export function setOnNodeClick(handler) {
  onNodeClick = typeof handler === 'function' ? handler : null
}

/** Register an empty-canvas click handler — used to clear inspector selection. */
export function setOnBackgroundClick(handler) {
  onBackgroundClick = typeof handler === 'function' ? handler : null
}

/** Toggle the opt-in K8s icon overlay (perf-gated in the draw loop). */
export function setIconOverlay(on) {
  _iconOverlay = !!on
  if (_iconOverlay) warmIcons([...new Set(nodes.map((n) => n.kind))])
  _invalidate('icon-overlay')
}

/**
 * Live-tune the force/LOD params. Merges a partial patch into simParams and
 * re-runs the (already simParams-driven) sim at a modest alpha so the layout
 * responds without a full re-open. Persistence is the caller's job (main.js
 * writes cfg.graphSim; _seedSimParams reads it back on the next init).
 * @param {Partial<typeof SIM_DEFAULTS>} patch
 */
export function setSimParams(patch) {
  if (!patch || typeof patch !== 'object') return
  for (const k of Object.keys(SIM_DEFAULTS)) {
    if (k in patch && Number.isFinite(+patch[k])) simParams[k] = +patch[k]
  }
  _lodDirty = true // LOD thresholds may have moved
  if (sim) _restartSim(0.3)
  _invalidate('sim-params')
  dbg('setSimParams', { ...simParams })
}

/**
 * Register the status-bar feed. Emits { totalNodes, visibleNodes, totalEdges,
 * visibleEdges, namespaces } whenever structure or visibility changes, rAF-
 * coalesced so an SSE/filter burst produces at most one emit per frame.
 * lodLayer is owned by main.js for now; zoom-driven layers may move here later.
 */
export function setOnStatsChange(handler) {
  onStatsChange = typeof handler === 'function' ? handler : null
}

function _emitStats() {
  if (!onStatsChange || _statsRaf) return
  _statsRaf = requestAnimationFrame(() => {
    _statsRaf = null
    if (!onStatsChange || !canvas) return
    let vn = 0
    for (const n of nodes) if (!n.hidden) vn++
    let ve = 0
    for (const e of edges) if (!e.hidden) ve++
    const lodLayer = scale < simParams.lodNsFadeHi ? 'namespace' : scale < simParams.lodPodFadeLo ? 'workload' : 'pod'
    onStatsChange({
      totalNodes: nodes.length,
      visibleNodes: vn,
      totalEdges: edges.length,
      visibleEdges: ve,
      namespaces: nsGroups.size,
      lodLayer,
    })
  })
}

/** Sim runs continuously while alpha > alphaMin. Surface parity only. */
export async function layout() {
  if (!canvas) return
  _restartSim(0.5)
}

export function destroyGraph() {
  if (!canvas) return
  glog.debug('destroy', { nodes: nodes.length, edges: edges.length })
  if (sim) sim.stop()
  if (rafId) cancelAnimationFrame(rafId)
  if (_statsRaf) {
    cancelAnimationFrame(_statsRaf)
    _statsRaf = null
  }
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
  window.removeEventListener('resize', _resize)
  window.removeEventListener('mousemove', _onMouseMove)
  window.removeEventListener('mouseup', _onMouseUp)
  canvas.remove()
  canvas = null
  ctx = null
  sim = null
  nodes = []
  edges = []
  nodeById.clear()
  neighborSets.clear()
  nsGroups.clear()
  wlGroups.clear()
  grid.clear()
  _gridStale = true
  _territories = []
  _wlLabels = []
  _nsAnchors.clear()
  _iconOverlay = false
  _lodDirty = true
  statusCache.clear()
  rafId = null
  scale = 1
  tx = 0
  ty = 0
  _cameraCentered = false
  _pendingFit = false
  _revealing = false
  _revealT0 = 0
  _revealR = 0
  hoverId = null
  dragging = null
  panning = null
  _mouseDownAt = null
  onNodeClick = null
  onBackgroundClick = null
  onStatsChange = null
}

// ===== filter helpers ======================================================
// Each helper directly toggles node.hidden / edge.hidden. Imperative
// semantics on purpose: callers in main.js apply them in a fixed order
// (search → kinds → focus) so each can mutate the prior result.

/**
 * Show/hide nodes by case-insensitive substring match on label.
 * Empty query restores all nodes/edges to visible.
 */
export function nodeVisByLabel(_g, labelQuery) {
  const q = (labelQuery || '').toLowerCase()
  if (!q) {
    for (const n of nodes) n.hidden = false
    for (const e of edges) e.hidden = false
    _invalidate('label-filter:clear')
    _emitStats()
    return nodes.length
  }
  for (const n of nodes) n.hidden = !(n.label || '').toLowerCase().includes(q)
  _propagateEdgeVisibility()
  _invalidate('label-filter')
  _emitStats()
  const matches = nodes.filter((n) => !n.hidden).length
  glog.debug('search', { query: q, matches, total: nodes.length })
  return matches
}

/** Hide nodes whose kind is in hiddenKinds. Additive — doesn't reveal anything. */
export function setKindVisibility(_g, hiddenKinds) {
  const hidden = hiddenKinds instanceof Set ? hiddenKinds : new Set(hiddenKinds || [])
  if (hidden.size === 0) return
  for (const n of nodes) {
    if (hidden.has(n.kind)) n.hidden = true
  }
  _propagateEdgeVisibility()
  _invalidate('kind-visibility')
  _emitStats()
}

/** Scope to one namespace: hide everything outside it. '' / null = no-op. */
export function setNamespaceVisibility(_g, scope) {
  if (!scope) return
  for (const n of nodes) {
    if (n.namespace !== scope) n.hidden = true
  }
  _propagateEdgeVisibility()
  _invalidate('ns-visibility')
  _emitStats()
}

/**
 * Health filter. 'unhealthy' keeps only red/grey (failed/pending/unknown)
 * nodes — the "show me what's broken" view; anything else is a no-op.
 * Additive (only hides), so it composes with the other filters.
 */
export function setHealthFilter(_g, mode) {
  if (mode !== 'unhealthy') return
  for (const n of nodes) {
    if (n.status === 'green' || n.status === '') n.hidden = true
  }
  _propagateEdgeVisibility()
  _invalidate('health-filter')
  _emitStats()
}

/** Hide nodes with no edges. Additive (only flips visible→hidden). */
export function hideOrphans(_g) {
  const connected = new Set()
  for (const e of edges) {
    connected.add(typeof e.source === 'object' ? e.source.id : e.source)
    connected.add(typeof e.target === 'object' ? e.target.id : e.target)
  }
  for (const n of nodes) {
    if (!connected.has(n.id)) n.hidden = true
  }
  _invalidate('hide-orphans')
  _emitStats()
}

/**
 * Restrict visibility to nodes within `depth` undirected hops of rootUid.
 * Overwrites visibility — focus dominates over prior search/kind filters.
 */
export function focusByDepth(_g, rootUid, depth) {
  if (nodes.length === 0) return new Set()
  if (!rootUid || !nodeById.has(rootUid)) {
    for (const n of nodes) n.hidden = false
    for (const e of edges) e.hidden = false
    _invalidate('focus-depth:reset')
    _emitStats()
    return new Set(nodeById.keys())
  }

  const adj = new Map()
  for (const id of nodeById.keys()) adj.set(id, new Set())
  for (const e of edges) {
    const s = typeof e.source === 'object' ? e.source.id : e.source
    const t = typeof e.target === 'object' ? e.target.id : e.target
    if (adj.has(s) && adj.has(t)) {
      adj.get(s).add(t)
      adj.get(t).add(s)
    }
  }

  const visible = new Set([rootUid])
  let frontier = new Set([rootUid])
  const maxDepth = Math.max(0, Math.min(5, depth | 0))
  for (let d = 0; d < maxDepth; d++) {
    const next = new Set()
    for (const id of frontier) {
      for (const nb of adj.get(id) || []) {
        if (!visible.has(nb)) {
          visible.add(nb)
          next.add(nb)
        }
      }
    }
    if (next.size === 0) break
    frontier = next
  }

  for (const n of nodes) n.hidden = !visible.has(n.id)
  for (const e of edges) {
    const s = typeof e.source === 'object' ? e.source.id : e.source
    const t = typeof e.target === 'object' ? e.target.id : e.target
    e.hidden = !(visible.has(s) && visible.has(t))
  }
  _invalidate('focus-depth')
  _emitStats()
  return visible
}

/**
 * Fit the camera to the bounding box of currently visible nodes.
 * The `_animate` arg is accepted for API compat — pan/zoom snap is
 * instant in the canvas renderer; the continuous sim provides plenty
 * of motion already.
 */
export async function fitToVisible(_g, _animate = true, padding = 60) {
  if (!canvas) return
  // width/height may be 0 if ResizeObserver hasn't fired since the
  // container became visible. Bail rather than divide by zero and
  // leave scale/tx/ty as NaN.
  if (!width || !height) return
  const visibleNodes = nodes.filter((n) => !n.hidden)
  if (visibleNodes.length === 0) return
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  let badPos = 0
  for (const n of visibleNodes) {
    // Skip non-finite coords entirely. d3-force's tick can in theory
    // produce ±Infinity if forces blow up (e.g. two nodes coincide and
    // the random jitter doesn't separate them). Reading those into the
    // bbox would propagate Infinity → NaN through the camera math and
    // paint nothing.
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) {
      badPos++
      continue
    }
    if (n.x < minX) minX = n.x
    if (n.y < minY) minY = n.y
    if (n.x > maxX) maxX = n.x
    if (n.y > maxY) maxY = n.y
  }
  if (badPos > 0) dbgWarn(`🛑 ${badPos} node(s) with non-finite x/y in fitToVisible`)
  if (!isFinite(minX)) return
  const w = maxX - minX || 1
  const h = maxY - minY || 1
  const sx = (width - padding * 2) / w
  const sy = (height - padding * 2) / h
  scale = Math.max(0.2, Math.min(sx, sy, 4))
  tx = width / 2 - ((minX + maxX) / 2) * scale
  ty = height / 2 - ((minY + maxY) / 2) * scale
  _invalidate('fit')
}

// ===== harness entry =======================================================
/**
 * Direct {nodes, edges} feed for the test harness. Bypasses Resource shape /
 * processLinks; production callers use replayResources/addResource instead.
 */
export function setData(data) {
  nodes = (data.nodes || []).map((n) => ({ ...n }))
  edges = (data.edges || []).map((e) => ({ ...e }))
  nodeById = new Map(nodes.map((n) => [n.id, n]))
  _rebuildNeighborIndex()
  _restartSim(0.8)
  _settle() // identical open path to replayResources — harness exercises this
  _invalidate('set-data')
}

// ===== resource → node ======================================================

function _makeNode(res) {
  const id = res.metadata?.uid
  if (!id) return null
  let label = res.metadata.name
  if (getConfig().shortenNames && res.metadata?.labels?.['pod-template-hash']) {
    label = label.split('-' + res.metadata.labels['pod-template-hash'])[0]
  }
  const geom = kindGeom(res.kind)
  return {
    id,
    label,
    kind: res.kind,
    namespace: res.metadata?.namespace || '(cluster)',
    groupId: _groupIdFor(res),
    shape: geom.shape,
    r: geom.radius,
    color: _colorFor(res),
    status: _statusColour(res), // 'green'|'red'|'grey'|'' — drives health filter
    ip: res.status?.podIP || res.status?.hostIP || null,
    hidden: false,
  }
}

/**
 * Walk ownerReferences up through the cache to the top-most controller and
 * return its uid — the resource's "workload group" key (e.g. a Pod groups
 * under its Deployment). Falls back to the resource's own uid for top-level
 * objects, and to the owner-ref uid (not yet cached) on a bootstrap race.
 * Depth-capped + cycle-guarded so a malformed ownerRef chain can't spin.
 * @param {any} res
 */
function _groupIdFor(res) {
  let cur = res
  const seen = new Set()
  for (let depth = 0; depth < 6; depth++) {
    const owners = cur.metadata?.ownerReferences
    if (!owners || owners.length === 0) break
    const ctrl = owners.find((o) => o.controller) || owners[0]
    if (!ctrl?.uid || seen.has(ctrl.uid)) break
    seen.add(ctrl.uid)
    const owner = getResById(ctrl.uid)
    if (!owner) {
      glog.debug('groupId owner cache miss', { kind: cur.kind, owner: ctrl.kind, uid: ctrl.uid })
      return ctrl.uid
    }
    cur = owner
  }
  return cur.metadata?.uid || res.metadata?.uid
}

/**
 * Refresh an EXISTING node's fields in place from `res`. Node creation and
 * removal are owned by _reconcile (connectivity decides whether a resource
 * becomes a node at all), so a not-yet-a-node resource is a no-op here.
 * Always returns false — the return is vestigial; callers gate _restartSim
 * on _reconcile's structural result instead.
 */
function _addOrUpdateNode(res) {
  const id = res.metadata?.uid
  if (!id) return false
  const existing = nodeById.get(id)
  if (existing) {
    existing.label = res.metadata?.name || existing.label
    existing.color = _colorFor(res)
    existing.status = _statusColour(res)
    if (existing.kind !== res.kind) {
      const geom = kindGeom(res.kind)
      existing.shape = geom.shape
      existing.r = geom.radius
    }
    existing.kind = res.kind
    existing.namespace = res.metadata?.namespace || existing.namespace || '(cluster)'
    // groupId may resolve late: the owner can land in the cache after the
    // child node was first made (SSE ordering), so recompute on every update.
    existing.groupId = _groupIdFor(res)
    existing.ip = res.status?.podIP || res.status?.hostIP || null
    return false
  }
  // Not a node (yet). Creation is _reconcile's job — it decides based on
  // connectivity + the orphan-prune mode. Nothing to do here.
  return false
}

function _colorFor(res) {
  const status = _statusColour(res)
  if (status) return STATUS_COLORS[status] || DEFAULT_COLOR
  return KIND_COLORS[res.kind] || DEFAULT_COLOR
}

function _statusColour(res) {
  const uid = res.metadata?.uid
  const rv = res.metadata?.resourceVersion || ''
  if (uid) {
    const cached = statusCache.get(uid)
    if (cached && cached.rv === rv) return cached.colour
  }
  const colour = _computeStatusColour(res)
  if (uid) statusCache.set(uid, { rv, colour })
  return colour
}

function _computeStatusColour(res) {
  try {
    if (res.kind === 'Deployment') {
      if (!res.status || !res.status.conditions) return 'grey'
      const availCond = res.status.conditions.find((c) => c.type === 'Available')
      if (availCond && availCond.status === 'True') return 'green'
      return 'red'
    }
    if (res.kind === 'ReplicaSet' || res.kind === 'StatefulSet') {
      if (res.status?.replicas === 0) return 'grey'
      if (res.status?.replicas === res.status?.readyReplicas) return 'green'
      return 'red'
    }
    if (res.kind === 'DaemonSet') {
      if (res.status?.numberReady === res.status?.desiredNumberScheduled) return 'green'
      if (res.status?.desiredNumberScheduled === 0) return 'grey'
      return 'red'
    }
    if (res.kind === 'Pod') {
      if (res.metadata?.deletionTimestamp) return 'red'
      const readyCond = res.status?.conditions?.find((c) => c.type === 'Ready')
      if (readyCond && readyCond.status === 'True') return 'green'
      if (res.status?.phase === 'Failed') return 'red'
      if (res.status?.phase === 'Succeeded') return 'green'
      return 'grey'
    }
    if (res.kind === 'PersistentVolumeClaim') {
      if (res.status?.phase === 'Bound') return 'green'
      if (res.status?.phase === 'Pending') return 'grey'
      return 'red'
    }
    if (res.kind === 'Job') {
      const backoffLimit = res.spec?.backoffLimit || 6
      const succeeded = res.status?.succeeded || 0
      const completions = res.spec?.completions || 1
      const failed = res.status?.failed || 0
      if (succeeded >= completions) return 'green'
      if (failed >= backoffLimit) return 'red'
      return 'grey'
    }
  } catch (e) {
    glog.error('💥 error calculating status colour', e)
    return ''
  }
  return ''
}

// ===== link derivation ======================================================

function _addEdge(sourceId, targetId, type, knownIds, pendingEdges) {
  if (!knownIds.has(sourceId) || !knownIds.has(targetId)) return
  const id = `${sourceId}.${targetId}.${type}`
  if (pendingEdges.has(id)) return
  pendingEdges.set(id, { id, source: sourceId, target: targetId, type })
}

function _processLinks(res, knownIds, pendingEdges) {
  if (res.metadata?.ownerReferences) {
    for (const ref of res.metadata.ownerReferences) {
      _addEdge(ref.uid, res.metadata.uid, 'owner', knownIds, pendingEdges)
    }
  }

  if (res.kind === 'Ingress') {
    if (res.spec?.rules) {
      for (const rule of res.spec.rules) {
        if (rule.http?.paths) {
          for (const path of rule.http.paths) {
            const svcName = path.backend?.service?.name
            if (svcName) {
              const svc = getResByName('Service', svcName)
              if (svc) _addEdge(res.metadata.uid, svc.metadata.uid, 'network', knownIds, pendingEdges)
            }
          }
        }
      }
    }
    const defaultBackendName = res.spec?.defaultBackend?.service?.name
    if (defaultBackendName) {
      const svc = getResByName('Service', defaultBackendName)
      if (svc) _addEdge(res.metadata.uid, svc.metadata.uid, 'network', knownIds, pendingEdges)
    }
  }

  if (res.kind === 'Service') {
    // Old-style Endpoints (k8s <1.33): one resource per Service, name-matched.
    const ep = getResByName('Endpoints', res.metadata.name)
    if (ep) {
      for (const subset of ep.subsets || []) {
        for (const addr of subset.addresses || []) {
          const pod = getResByIP(addr.ip)
          if (pod) _addEdge(res.metadata.uid, pod.metadata.uid, 'network', knownIds, pendingEdges)
          else glog.debug('endpoint resolve miss', { ip: addr.ip, kind: 'Service', name: res.metadata.name, src: 'Endpoints' })
        }
      }
    }
    // EndpointSlices (k8s ≥1.33): N slices per Service, linked via the
    // `kubernetes.io/service-name` label. Each slice's endpoints[].addresses[]
    // hold the pod IPs.
    const slices = queryRes((r) => r.kind === 'EndpointSlice' && r.metadata?.labels?.['kubernetes.io/service-name'] === res.metadata.name)
    for (const slice of slices) {
      for (const ep of slice.endpoints || []) {
        for (const addr of ep.addresses || []) {
          const pod = getResByIP(addr)
          if (pod) _addEdge(res.metadata.uid, pod.metadata.uid, 'network', knownIds, pendingEdges)
          else glog.debug('endpoint resolve miss', { ip: addr, kind: 'Service', name: res.metadata.name, src: 'EndpointSlice' })
        }
      }
    }
  }

  if (res.kind === 'Pod' && res.spec?.volumes) {
    for (const vol of res.spec.volumes) {
      if (vol.persistentVolumeClaim?.claimName) {
        const pvc = getResByName('PersistentVolumeClaim', vol.persistentVolumeClaim.claimName)
        if (pvc) _addEdge(res.metadata.uid, pvc.metadata.uid, 'mount', knownIds, pendingEdges)
      }
      if (vol.configMap?.name) {
        const cm = getResByName('ConfigMap', vol.configMap.name)
        if (cm) _addEdge(res.metadata.uid, cm.metadata.uid, 'mount', knownIds, pendingEdges)
      }
      if (vol.secret?.secretName) {
        const secret = getResByName('Secret', vol.secret.secretName)
        if (secret) _addEdge(res.metadata.uid, secret.metadata.uid, 'mount', knownIds, pendingEdges)
      }
    }
  }

  if (res.kind === 'Pod' && res.spec?.containers) {
    for (const container of res.spec.containers) {
      for (const env of container.env || []) {
        if (env.valueFrom?.secretKeyRef?.name) {
          const secret = getResByName('Secret', env.valueFrom.secretKeyRef.name)
          if (secret) _addEdge(res.metadata.uid, secret.metadata.uid, 'env-ref', knownIds, pendingEdges)
        } else if (env.valueFrom?.configMapKeyRef?.name) {
          const cm = getResByName('ConfigMap', env.valueFrom.configMapKeyRef.name)
          if (cm) _addEdge(res.metadata.uid, cm.metadata.uid, 'env-ref', knownIds, pendingEdges)
        }
      }
    }
  }

  if (res.kind === 'HorizontalPodAutoscaler' && res.spec?.scaleTargetRef) {
    const target = getResByName(res.spec.scaleTargetRef.kind, res.spec.scaleTargetRef.name)
    if (target) _addEdge(res.metadata.uid, target.metadata.uid, 'owner', knownIds, pendingEdges)
  }
}

/**
 * Single reconcile pass over the whole cache. Re-derives ALL edges (so
 * incoming edges like Service→Pod, derived in processLinks(svc) not (pod),
 * aren't dropped on a pod update) AND, when orphan-hiding is on, derives the
 * node set from connectivity exactly the way replayResources does.
 *
 * This is the fix for the no-interaction repaint storm: previously every SSE
 * add/update for a resource that replay had pruned as an orphan re-injected
 * it as a node (it was cache-resident but not in nodes[]), which set
 * wasAdded → _restartSim → the sim re-warmed and the graph re-bloomed +
 * orphans reappeared despite the toggle. Here the node set is *always*
 * derived from connectivity, so a pruned orphan stays cache-only until some
 * other resource's update actually gives it an edge — at which point it's
 * materialized here (late-materialize).
 *
 * knownIds spans the full candidate set (not just current nodes) so a
 * suppressed orphan's later edge resolves instead of being silently dropped.
 *
 * @returns {boolean} true iff the node SET changed — the caller restarts the
 *   sim only then, so topology-neutral heartbeat churn no longer re-warms it.
 */
function _reconcile() {
  const _t0 = performance.now()
  const cfg = getConfig()
  // Candidate nodes = every cached graph resource, same filter replay uses.
  const candidates = queryRes(
    (x) =>
      x &&
      x.kind &&
      x.kind !== 'Endpoints' &&
      x.kind !== 'EndpointSlice' &&
      x.kind !== 'Event' &&
      x.metadata?.uid &&
      (!cfg.resFilter || cfg.resFilter.includes(x.kind)),
  )
  const candidateIds = new Set(candidates.map((r) => r.metadata.uid))
  const pendingEdges = new Map()
  let processErrors = 0
  for (const r of candidates) {
    try {
      _processLinks(r, candidateIds, pendingEdges)
    } catch (err) {
      if (processErrors === 0) {
        glog.warn('🛑 processLinks failed (reconcile)', { kind: r?.kind, name: r?.metadata?.name, err })
      }
      processErrors++
    }
  }
  if (processErrors > 1) glog.debug('processLinks burst (reconcile)', { errors: processErrors, total: candidates.length })

  const connected = new Set()
  for (const e of pendingEdges.values()) {
    connected.add(e.source)
    connected.add(e.target)
  }
  const desired = _pruneOrphans ? connected : candidateIds

  // Does the node set differ from what's desired? Cheap size + membership
  // check before doing any array work.
  let structural = desired.size !== nodeById.size
  if (!structural) {
    for (const id of nodeById.keys()) {
      if (!desired.has(id)) {
        structural = true
        break
      }
    }
  }
  if (structural) {
    // Rebuild preserving existing node OBJECTS (their x/y/vx/vy — recreating
    // them would teleport / re-bloom the graph); materialize newly-desired
    // ids from the cache (their coords get seeded by the _restartSim the
    // caller runs because we returned true).
    const next = []
    const nextById = new Map()
    for (const n of nodes) {
      if (desired.has(n.id) && !nextById.has(n.id)) {
        next.push(n)
        nextById.set(n.id, n)
      }
    }
    for (const id of desired) {
      if (nextById.has(id)) continue
      const r = getResById(id)
      const node = r ? _makeNode(r) : null
      if (node) {
        next.push(node)
        nextById.set(id, node)
      }
    }
    nodes = next
    nodeById = nextById
  }

  // Edges always refreshed — drawing/highlight must reflect current topology
  // even when the node set didn't change. Keep only edges whose endpoints
  // both survived.
  const finalEdges = []
  for (const e of pendingEdges.values()) {
    if (nodeById.has(e.source) && nodeById.has(e.target)) finalEdges.push(e)
  }
  edges = finalEdges

  const _ms = Math.round(performance.now() - _t0)
  if (_ms > 100) glog.warn('🐌 slow reconcile', { candidates: candidates.length, nodes: nodes.length, edges: edges.length, ms: _ms })
  return structural
}

function _propagateEdgeVisibility() {
  for (const e of edges) {
    const s = typeof e.source === 'object' ? e.source : nodeById.get(e.source)
    const t = typeof e.target === 'object' ? e.target : nodeById.get(e.target)
    e.hidden = !s || !t || s.hidden || t.hidden
  }
}

// ===== sim & indices =======================================================

function _rebuildNeighborIndex() {
  neighborSets = new Map()
  for (const n of nodes) neighborSets.set(n.id, new Set())
  for (const e of edges) {
    const s = typeof e.source === 'object' ? e.source.id : e.source
    const t = typeof e.target === 'object' ? e.target.id : e.target
    neighborSets.get(s)?.add(t)
    neighborSets.get(t)?.add(s)
  }
  _rebuildGroupIndex()
}

/**
 * Namespace + workload grouping, rebuilt alongside the neighbor index on every
 * structural change. Consumed by the semantic-zoom LOD (namespace territories)
 * and the status bar's namespace count.
 */
function _rebuildGroupIndex() {
  nsGroups = new Map()
  wlGroups = new Map()
  for (const n of nodes) {
    const ns = n.namespace || '(cluster)'
    let nb = nsGroups.get(ns)
    if (!nb) {
      nb = new Set()
      nsGroups.set(ns, nb)
    }
    nb.add(n.id)
    const g = n.groupId || n.id
    let wb = wlGroups.get(g)
    if (!wb) {
      wb = new Set()
      wlGroups.set(g, wb)
    }
    wb.add(n.id)
  }
  _computeNsAnchors()
  _lodDirty = true
}

/**
 * Place each namespace on a ring so the cluster force can pull its members
 * into a distinct region (→ readable territories). Order is name-sorted so
 * anchors are stable across reopens. Ring radius grows with namespace count
 * and total node count so big clusters don't collide on the ring.
 */
function _computeNsAnchors() {
  _nsAnchors = new Map()
  const names = [...nsGroups.keys()].sort()
  const k = names.length
  if (k === 0) return
  if (k === 1) {
    _nsAnchors.set(names[0], { x: 0, y: 0 })
    return
  }
  // Gap target between adjacent anchors ≈ proportional to per-namespace size.
  const avg = nodes.length / k
  const gap = 220 + 26 * Math.sqrt(Math.max(1, avg))
  const R = Math.max(280, (gap * k) / (2 * Math.PI))
  for (let i = 0; i < k; i++) {
    const a = (2 * Math.PI * i) / k - Math.PI / 2
    _nsAnchors.set(names[i], { x: R * Math.cos(a), y: R * Math.sin(a) })
  }
}

// ---- spatial index --------------------------------------------------------

function _cellKey(x, y) {
  return Math.floor(x / GRID_CELL) + ',' + Math.floor(y / GRID_CELL)
}

/** Bucket every finite-position node into the uniform grid. Clears _gridStale. */
function _rebuildGrid() {
  grid = new Map()
  for (const n of nodes) {
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue
    const k = _cellKey(n.x, n.y)
    let bucket = grid.get(k)
    if (!bucket) {
      bucket = []
      grid.set(k, bucket)
    }
    bucket.push(n)
  }
  _gridStale = false
  _lodDirty = true // positions just settled — territories need a recompute
}

// ---- semantic-zoom LOD ----------------------------------------------------

// Stable string→hue so a namespace always tints the same colour across
// reopens (deterministic; no palette state to manage).
function _hashHue(str) {
  let h = 0
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0
  return ((h % 360) + 360) % 360
}

// Andrew's monotone chain — O(n log n) convex hull. Returns [] for < 3 pts.
function _convexHull(pts) {
  if (pts.length < 3) return pts.slice()
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lo = []
  for (const pt of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], pt) <= 0) lo.pop()
    lo.push(pt)
  }
  const hi = []
  for (let i = p.length - 1; i >= 0; i--) {
    const pt = p[i]
    while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], pt) <= 0) hi.pop()
    hi.push(pt)
  }
  lo.pop()
  hi.pop()
  return lo.concat(hi)
}

/**
 * Recompute namespace territories + workload-label anchors from the *visible*
 * node positions. Per namespace: centroid, principal axis (2×2 covariance
 * eigenvector) for label rotation, major extent for label sizing, and a
 * convex hull for the tint. Per workload group (≥2 members): the controller
 * label at the members' centroid. Cheap enough on demand; never per frame.
 */
function _computeTerritories() {
  _territories = []
  _wlLabels = []
  for (const [ns, ids] of nsGroups) {
    let sx = 0,
      sy = 0,
      m = 0
    const pts = []
    for (const id of ids) {
      const nd = nodeById.get(id)
      if (!nd || nd.hidden || !Number.isFinite(nd.x) || !Number.isFinite(nd.y)) continue
      sx += nd.x
      sy += nd.y
      m++
      pts.push([nd.x, nd.y])
    }
    if (m === 0) continue
    const cx = sx / m
    const cy = sy / m
    let axx = 0,
      ayy = 0,
      axy = 0
    for (const [x, y] of pts) {
      const dx = x - cx
      const dy = y - cy
      axx += dx * dx
      ayy += dy * dy
      axy += dx * dy
    }
    axx /= m
    ayy /= m
    axy /= m
    // Principal eigenvector of [[axx,axy],[axy,ayy]] → label baseline angle.
    const tr = axx + ayy
    const det = axx * ayy - axy * axy
    const disc = Math.max(0, (tr * tr) / 4 - det)
    const l1 = tr / 2 + Math.sqrt(disc)
    let angle = 0
    if (Math.abs(axy) > 1e-6) angle = Math.atan2(l1 - axx, axy)
    else if (axx < ayy) angle = Math.PI / 2
    // Major extent = projection span on the principal axis (label width budget).
    const ca = Math.cos(angle)
    const sa = Math.sin(angle)
    let pmin = Infinity,
      pmax = -Infinity
    for (const [x, y] of pts) {
      const proj = (x - cx) * ca + (y - cy) * sa
      if (proj < pmin) pmin = proj
      if (proj > pmax) pmax = proj
    }
    const ext = Math.max(40, pmax - pmin)
    _territories.push({ ns, cx, cy, angle, ext, hull: _convexHull(pts) })
  }
  for (const [gid, ids] of wlGroups) {
    if (ids.size < 2) continue
    const root = nodeById.get(gid)
    let sx = 0,
      sy = 0,
      m = 0
    for (const id of ids) {
      const nd = nodeById.get(id)
      if (!nd || nd.hidden || !Number.isFinite(nd.x) || !Number.isFinite(nd.y)) continue
      sx += nd.x
      sy += nd.y
      m++
    }
    if (m === 0) continue
    _wlLabels.push({ text: (root && root.label) || gid, cx: sx / m, cy: sy / m, n: m })
  }
  _lodDirty = false
}

function _restartSim(alpha = 0.6) {
  dbg('_restartSim', { alpha, nodes: nodes.length, edges: edges.length, ...camSnap() })
  if (sim) sim.stop()
  // Seed *un-positioned* nodes at their namespace's ring anchor (not d3's
  // default centre spiral). Without this the cluster force has to migrate
  // every node ~hundreds of px from the centre out to its ring slot, which
  // the bounded pre-settle can't finish — so the graph keeps visibly
  // drifting for 10-15s after open. Pre-placing makes the ring already
  // formed; the sim then only relaxes locally and settles fast. Nodes that
  // already have coords (live SSE) keep them, so updates don't teleport.
  for (const n of nodes) {
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) {
      const a = _nsAnchors.get(n.namespace) || ZERO_ANCHOR
      n.x = a.x + (Math.random() - 0.5) * 80
      n.y = a.y + (Math.random() - 0.5) * 80
    }
  }
  sim = forceSimulation(nodes)
    .alpha(alpha)
    .alphaDecay(simParams.alphaDecay)
    .velocityDecay(simParams.velocityDecay)
    .force(
      'link',
      forceLink(edges)
        .id((d) => d.id)
        .distance(simParams.linkDistance)
        .strength(simParams.linkStrength),
    )
    .force(
      'charge',
      forceManyBody()
        .strength(simParams.chargeStrength)
        .distanceMin(NODE_RADIUS + 4)
        .distanceMax(simParams.chargeDistanceMax),
    )
    .force('center', forceCenter(0, 0).strength(simParams.centerStrength))
    .force('clusterX', forceX((d) => (_nsAnchors.get(d.namespace) || ZERO_ANCHOR).x).strength(simParams.clusterStrength))
    .force('clusterY', forceY((d) => (_nsAnchors.get(d.namespace) || ZERO_ANCHOR).y).strength(simParams.clusterStrength))
    .force(
      'collide',
      // Radius accessor (was a fixed NODE_RADIUS+4) — picks up per-kind sizes
      // from NODE_GEOM via the n.r seeded on the node.
      forceCollide((d) => (d.r || NODE_RADIUS) + 4)
        .strength(simParams.collideStrength)
        .iterations(simParams.collideIterations),
    )
    .on('tick', () => {
      needsDraw = true // raw, not _invalidate(): fires per sim tick — logging here would flood the buffer
      _tickRepaints++ // counted (not logged) so the activity sampler can attribute frames to the warm sim
      // Positions moved → grid is stale. Once the sim cools below the settle
      // floor, rebuild it so the (now stable) layout gets O(1) hit-testing;
      // while hot we leave it stale and _hitTest does the old linear scan.
      _gridStale = true
      if (sim.alpha() < SETTLE_ALPHA_FLOOR) _rebuildGrid()
      sim._tickCount = (sim._tickCount || 0) + 1
      // Wall-clock delta between this tick and the previous one. d3-force ties
      // tick fires to rAF, so the delta reflects what the user sees: a delta
      // >100ms means a single tick stretched past 10fps — clearly user-visible
      // jank. Throttle by wall-clock (1s minimum between warns) — using tick
      // count for throttling would gate the warn behind the same slowness it
      // tries to surface (slow sim → few ticks → throttle never opens).
      const _now = performance.now()
      if (sim._lastTickAt) {
        const _delta = _now - sim._lastTickAt
        if (_delta > 100 && _now - (sim._lastFpsWarnAt || 0) > 1000) {
          sim._lastFpsWarnAt = _now
          glog.warn('🐌 slow sim tick', {
            delta_ms: Math.round(_delta),
            tick: sim._tickCount,
            alpha: +sim.alpha().toFixed(3),
            nodes: nodes.length,
            edges: edges.length,
          })
        }
      }
      sim._lastTickAt = _now
      if (kaLog.getLevel() === 'debug' && sim._tickCount % 30 === 0) {
        // Sample alpha + bbox + max velocity for perf/health visibility.
        // NaN should never appear under correct add/update paths; if it
        // does, the canary below fires once per sim instance.
        let nan = 0
        let maxAbsV = 0
        let maxV = null
        let minX = Infinity,
          maxX = -Infinity,
          minY = Infinity,
          maxY = -Infinity
        for (const n of nodes) {
          if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) {
            nan++
            continue
          }
          if (n.x < minX) minX = n.x
          if (n.x > maxX) maxX = n.x
          if (n.y < minY) minY = n.y
          if (n.y > maxY) maxY = n.y
          const av = Math.max(Math.abs(n.vx || 0), Math.abs(n.vy || 0))
          if (av > maxAbsV) {
            maxAbsV = av
            maxV = n
          }
        }
        dbg('tick sample', {
          t: sim._tickCount,
          alpha: +sim.alpha().toFixed(3),
          alphaTarget: +sim.alphaTarget().toFixed(3),
          nan,
          maxAbsV: +maxAbsV.toFixed(2),
          maxV_label: maxV?.label,
          bbox: nan === nodes.length ? null : [+minX.toFixed(0), +minY.toFixed(0), +maxX.toFixed(0), +maxY.toFixed(0)],
        })
      } else if (!sim._sawNan) {
        // Cheap canary (always on). Walk once; if any node went NaN,
        // log a one-line warning.
        for (const n of nodes) {
          if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) {
            sim._sawNan = true
            dbgWarn('🛑 graph-canvas: node went NaN', { id: n.id, label: n.label, kind: n.kind, t: sim._tickCount })
            break
          }
        }
      }
    })
}

/**
 * Synchronously advance the just-restarted sim so the graph opens already
 * laid-out, then arm a one-shot fit. d3-force's `tick()` does NOT dispatch the
 * 'tick' event (only the internal timer does), so this loop costs nothing in
 * render/canary overhead. We stop the internal timer first, hand-tick, then
 * resume at a low alpha so SSE bumps still animate and the open looks calm
 * rather than re-spreading on screen.
 *
 * Bounded by tick count AND wall-clock so a large cluster can't freeze the
 * open. Returns elapsed ms (also stashed on window for the harness HUD).
 */
function _settle({ maxTicks = SETTLE_MAX_TICKS, budgetMs = SETTLE_BUDGET_MS } = {}) {
  if (!sim) return 0
  sim.stop()
  const t0 = performance.now()
  let i = 0
  while (i < maxTicks && sim.alpha() > SETTLE_ALPHA_FLOOR && performance.now() - t0 < budgetMs) {
    sim.tick()
    i++
  }
  const ms = Math.round(performance.now() - t0)
  // Resume gentle live motion (drag/hover/SSE bumps still work); opens calm.
  sim.alpha(SETTLE_RESUME_ALPHA).restart()
  // Pre-tick left nodes at their settled coords — index them now so the very
  // first hover after open is already O(1) (sim is about to re-stale it as
  // alpha decays, then the tick handler rebuilds once it drops below floor).
  _rebuildGrid()
  // Arm the one-shot fit. If the canvas is already sized (re-open), fit now;
  // otherwise the first valid _resize consumes _pendingFit (first open races
  // the ResizeObserver, so width/height may still be 0 here).
  _pendingFit = true
  if (width && height) {
    fitToVisible()
    _pendingFit = false
    _armReveal()
  }
  // Warm the icon cache for the kinds on screen so the overlay doesn't
  // pop in shape-first after open.
  if (_iconOverlay) warmIcons([...new Set(nodes.map((n) => n.kind))])
  dbg('settle', { ticks: i, ms, nodes: nodes.length, fitNow: !_pendingFit })
  if (typeof window !== 'undefined') window._gcLastSettleMs = ms
  return ms
}

// ===== render loop =========================================================

function _startLoop() {
  const step = () => {
    if (!canvas) return
    if (needsDraw) {
      try {
        _draw()
      } catch (err) {
        // Never let one bad frame kill the rAF chain. The canvas would
        // freeze on its last paint until the next destroyGraph + reopen.
        // Surface the failure but keep ticking; next frame may recover.
        dbgError('🛑 _draw threw, continuing loop:', err && err.message ? err.message : String(err))
      }
      needsDraw = false
    }
    // Reveal animates on the clock, not on sim ticks — keep the frame pump
    // alive until it finishes (then normal needsDraw rules resume).
    if (_revealing) needsDraw = true // raw, not _invalidate(): per-frame reveal keepalive inside the loop
    // Aggregated activity sample. The window guard keeps the body cheap every
    // frame; it only does real work once per _ACTIVITY_MS, and only emits when
    // something actually painted (idle stays silent). One line attributes the
    // window's frames across the logged (_invalidate) and unlogged (warm sim /
    // reveal) repaint paths — so a no-interaction repaint can't hide.
    const _now = performance.now()
    if (_now - _activityLast >= _ACTIVITY_MS) {
      if (_drawCount > 0) {
        const reasons = {}
        for (const [k, v] of _invalReasons) reasons[k] = v
        const snap = {
          frames: _drawCount,
          fps: Math.round((_drawCount * 1000) / (_now - _activityLast)),
          tickRepaints: _tickRepaints,
          revealing: _revealing,
          simAlpha: sim ? +sim.alpha().toFixed(3) : null,
          simAlphaTarget: sim ? +sim.alphaTarget().toFixed(3) : null,
          invalidates: reasons,
        }
        glog.debug('render activity', snap)
        if (typeof window !== 'undefined') window._gcActivity = { t: Math.round(_now), ...snap }
      }
      _drawCount = 0
      _tickRepaints = 0
      _invalReasons.clear()
      _activityLast = _now
    }
    rafId = requestAnimationFrame(step)
  }
  _activityLast = performance.now()
  rafId = requestAnimationFrame(step)
}

function _draw() {
  _drawCount++
  // Defensive instrumentation: any non-finite camera value here means
  // the graph won't paint visibly. Surface root cause to console.
  if (!Number.isFinite(scale) || !Number.isFinite(tx) || !Number.isFinite(ty)) {
    dbgWarn('🛑 bad camera', { scale, tx, ty, width, height })
    // Recover so later frames can paint again — pick a safe default and
    // ask fitToVisible to re-frame on the next user filter pass.
    scale = 1
    tx = width / 2 || 0
    ty = height / 2 || 0
  }
  ctx.save()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = BG
  ctx.fillRect(0, 0, width, height)
  // Hold a clean blank frame until the one-shot fit lands — avoids a flash of
  // the un-revealed graph at the default-centre camera before fit + reveal.
  if (_pendingFit) {
    ctx.restore()
    return
  }
  // Open reveal: eased progress 0→1. The selected style applies its own
  // transform/clip (below, after the world transform) and returns _rMul, an
  // alpha multiplier folded into every primitive. Runs on the clock, not sim
  // ticks; clears itself at 1.
  let _rp = 1
  if (_revealing) {
    _rp = _easeOutCubic((performance.now() - _revealT0) / REVEAL_MS)
    if (_rp >= 1) {
      _rp = 1
      _revealing = false
    }
    // Cheap observability hook (mirrors window._gcLastSettleMs). Lets the
    // harness HUD show the reveal curve; null once idle.
    if (typeof window !== 'undefined') window._gcRevealP = _rp
  } else if (typeof window !== 'undefined' && window._gcRevealP != null) {
    window._gcRevealP = null
  }
  ctx.translate(tx, ty)
  ctx.scale(scale, scale)
  let _rMul = 1
  if (_rp < 1) {
    const styleFn = REVEAL_STYLES[_revealStyle] || REVEAL_STYLES[DEFAULT_REVEAL_STYLE]
    _rMul = styleFn(_rp, _revealCx, _revealCy, _revealR)
  }

  // Viewport cull rect (world coords) — skip anything fully off-screen.
  // Disabled during the open reveal: bloom/zoom/iris/rise apply extra
  // transforms after the world transform, so this plain tx/ty/scale rect
  // would be wrong; the reveal is brief and already paints the whole graph.
  // The 64-unit margin covers a node's circle + its label tail at the zoom
  // where labels are visible, so partially-on-screen items aren't clipped.
  let cull = null
  if (_rp >= 1) {
    const m = 64
    cull = {
      minX: (0 - tx) / scale - m,
      minY: (0 - ty) / scale - m,
      maxX: (width - tx) / scale + m,
      maxY: (height - ty) / scale + m,
    }
  }

  // Visual focus is hover-driven only. Selection is transient: a click
  // opens the detail pane via onNodeClick, but no sticky ring/dim sticks
  // around after the cursor leaves.
  const focusId = hoverId
  const neighbors = focusId ? neighborSets.get(focusId) : null

  // ---- semantic-zoom LOD ---------------------------------------------------
  // Three crossfading layers keyed off camera scale. _smoothstep gives soft
  // band edges so nothing pops. Caches are recomputed lazily and only while a
  // layer that needs them is actually on screen.
  const sp = simParams
  const nsAlpha = (1 - _smoothstep(sp.lodNsFadeLo, sp.lodNsFadeHi, scale)) * _rMul
  const wlAlpha = _smoothstep(sp.lodWlFadeLo, sp.lodNsFadeHi, scale) * (1 - _smoothstep(sp.lodPodFadeLo, sp.lodWlFadeHi, scale)) * _rMul
  const podAlpha = _smoothstep(sp.lodPodFadeLo, sp.lodPodFadeHi, scale)
  if ((nsAlpha > 0.01 || wlAlpha > 0.01) && _lodDirty) _computeTerritories()

  // Namespace territories: tinted convex hull + a big rotated, letter-spaced
  // label spanning the cluster (EU4 country-label feel). Drawn first so nodes
  // and edges sit on top.
  if (nsAlpha > 0.01 && _territories.length) {
    for (const terr of _territories) {
      if (terr.hull.length >= 3) {
        ctx.globalAlpha = nsAlpha * 0.1
        ctx.fillStyle = `hsl(${_hashHue(terr.ns)} 60% 55%)`
        ctx.beginPath()
        ctx.moveTo(terr.hull[0][0], terr.hull[0][1])
        for (let i = 1; i < terr.hull.length; i++) ctx.lineTo(terr.hull[i][0], terr.hull[i][1])
        ctx.closePath()
        ctx.fill()
      }
      const txt = terr.ns.toUpperCase()
      // Size the label so it spans ~the cluster's principal extent.
      ctx.font = '600 100px ui-sans-serif, system-ui, sans-serif'
      ctx.letterSpacing = '18px'
      const w100 = ctx.measureText(txt).width || 1
      const fontPx = Math.max(14, Math.min(420, (terr.ext * 0.95) / (w100 / 100)))
      // Keep text upright (never beyond ±90°).
      let ang = terr.angle
      if (ang > Math.PI / 2) ang -= Math.PI
      if (ang < -Math.PI / 2) ang += Math.PI
      ctx.save()
      ctx.translate(terr.cx, terr.cy)
      ctx.rotate(ang)
      ctx.font = `600 ${fontPx}px ui-sans-serif, system-ui, sans-serif`
      ctx.letterSpacing = `${fontPx * 0.18}px`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.globalAlpha = nsAlpha * 0.5
      ctx.fillStyle = LABEL_COLOR
      ctx.fillText(txt, 0, 0)
      ctx.restore()
    }
    ctx.letterSpacing = '0px'
  }

  for (const e of edges) {
    if (e.hidden) continue
    const s = typeof e.source === 'object' ? e.source : nodeById.get(e.source)
    const t = typeof e.target === 'object' ? e.target : nodeById.get(e.target)
    if (!s || !t || s.hidden || t.hidden) continue
    if (!Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(t.x) || !Number.isFinite(t.y)) continue
    if (
      cull &&
      (Math.max(s.x, t.x) < cull.minX || Math.min(s.x, t.x) > cull.maxX || Math.max(s.y, t.y) < cull.minY || Math.min(s.y, t.y) > cull.maxY)
    )
      continue
    const dim = focusId && !(s.id === focusId || t.id === focusId)
    ctx.globalAlpha = (dim ? DIM_ALPHA : 0.7) * _rMul
    ctx.strokeStyle = EDGE_COLORS[e.type] || EDGE_COLORS.owner
    ctx.lineWidth = 1.2 / scale
    ctx.beginPath()
    ctx.moveTo(s.x, s.y)
    ctx.lineTo(t.x, t.y)
    ctx.stroke()
  }

  if (focusId) {
    const h = nodeById.get(focusId)
    // Guard non-finite coords. Sim can briefly produce ±Infinity if forces
    // blow up; createRadialGradient throws on non-finite args, which kills
    // the rAF chain and leaves the canvas frozen until the loop is rebuilt.
    if (h && !h.hidden && Number.isFinite(h.x) && Number.isFinite(h.y)) {
      // Halo scales with the node so big shapes (Node) and small ones
      // (Secret) get a proportional glow instead of a fixed ring.
      const hr = h.r || NODE_RADIUS
      const grad = ctx.createRadialGradient(h.x, h.y, hr, h.x, h.y, hr * 2.4)
      grad.addColorStop(0, (h.color || DEFAULT_COLOR) + '88')
      grad.addColorStop(1, (h.color || DEFAULT_COLOR) + '00')
      ctx.globalAlpha = _rMul
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.arc(h.x, h.y, hr * 2.4, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // Icon overlay is opt-in AND perf-gated: only at/above iconZoomMin and below
  // iconNodeCap (decode + drawImage don't scale). When on, the K8s glyph
  // *replaces* the per-kind shape — kind reads from the icon, status from a
  // thin coloured ring. Below the gate, off, or while a glyph is still
  // decoding, it falls back to the bare status-coloured shape.
  const iconsOn = _iconOverlay && scale >= simParams.iconZoomMin && nodes.length <= simParams.iconNodeCap
  for (const n of nodes) {
    if (n.hidden) continue
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue
    if (cull && (n.x < cull.minX || n.x > cull.maxX || n.y < cull.minY || n.y > cull.maxY)) continue
    const isFocus = n.id === focusId
    const isNeighbor = neighbors?.has(n.id)
    const dim = focusId && !isFocus && !isNeighbor
    ctx.globalAlpha = (dim ? DIM_ALPHA : 1) * _rMul
    // Per-kind shape + size; hover enlarges 1.3×.
    const r = (n.r || NODE_RADIUS) * (isFocus ? 1.3 : 1)
    const col = n.color || DEFAULT_COLOR
    let drewIcon = false
    if (iconsOn) {
      const img = iconImageFor(n.kind)
      // img.naturalWidth is 0 until the SVG decodes → fall back to the shape.
      if (img && img.complete && img.naturalWidth > 0) {
        const ar = img.naturalWidth / img.naturalHeight || 1
        const ih = r * 1.4
        const iw = ih * ar
        ctx.drawImage(img, n.x - iw / 2, n.y - ih / 2, iw, ih)
        // Thin status-coloured ring around the glyph (kind=icon, status=ring).
        ctx.strokeStyle = col
        ctx.lineWidth = 2 / scale
        ctx.beginPath()
        ctx.arc(n.x, n.y, r * 1.05, 0, Math.PI * 2)
        ctx.stroke()
        drewIcon = true
      }
    }
    if (!drewIcon) {
      ctx.fillStyle = col
      _tracePath(ctx, n.shape || 'circle', n.x, n.y, r)
      ctx.fill()
    }
  }

  // Workload-layer labels: one per group (≥2 members) at its centroid. Bridges
  // the gap between "namespace territory" and "every pod named".
  if (wlAlpha > 0.05 && _wlLabels.length) {
    ctx.font = `600 ${14 / scale}px ui-sans-serif, system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.strokeStyle = BG
    ctx.lineWidth = (LABEL_OUTLINE_PX + 1) / scale
    ctx.lineJoin = 'round'
    for (const wl of _wlLabels) {
      if (cull && (wl.cx < cull.minX || wl.cx > cull.maxX || wl.cy < cull.minY || wl.cy > cull.maxY)) continue
      ctx.globalAlpha = wlAlpha
      ctx.fillStyle = LABEL_COLOR
      ctx.strokeText(wl.text, wl.cx, wl.cy)
      ctx.fillText(wl.text, wl.cx, wl.cy)
    }
  }

  // Pod-layer labels: per node, fading in only once zoomed in. Screen-space
  // de-overlap caps drawn labels to ≈1 per 76×26px cell regardless of node
  // count — keeps big clusters readable + cheap. Focus/neighbours bypass both
  // the fade and the de-overlap so a hovered node always reads.
  if (podAlpha > 0 || focusId) {
    ctx.font = `${11 / scale}px ui-sans-serif, system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillStyle = LABEL_COLOR
    // bg-coloured outline behind every label so it stays readable over
    // crossing edges and red status fills (demo-critical for the incident
    // cluster). BG is theme-derived → recolours on kaThemeChange with the
    // text. Width is scale-compensated like the font; round join avoids
    // glyph-corner spikes.
    ctx.strokeStyle = BG
    ctx.lineWidth = LABEL_OUTLINE_PX / scale
    ctx.lineJoin = 'round'
    const taken = new Set()
    for (const n of nodes) {
      if (n.hidden) continue
      if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue
      const isFocus = n.id === focusId
      const isNeighbor = neighbors?.has(n.id)
      const forceShow = focusId && (isFocus || isNeighbor)
      if (cull && !forceShow && (n.x < cull.minX || n.x > cull.maxX || n.y < cull.minY || n.y > cull.maxY)) continue
      const a = forceShow ? 1 : podAlpha
      if (a <= 0) continue
      if (!forceShow) {
        // Screen-space bucket: first node in a cell wins the label.
        const ck = ((n.x * scale + tx) / 76) | 0
        const rk = ((n.y * scale + ty) / 26) | 0
        const key = ck + ':' + rk
        if (taken.has(key)) continue
        taken.add(key)
      }
      const dim = focusId && !isFocus && !isNeighbor
      ctx.globalAlpha = (dim ? DIM_ALPHA : a) * _rMul
      const label = n.label || n.id
      const ly = n.y + (n.r || NODE_RADIUS) + 4 / scale
      ctx.strokeText(label, n.x, ly)
      ctx.fillText(label, n.x, ly)
    }
  }

  ctx.globalAlpha = 1
  ctx.restore()
}

function _smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

// Fast-out: snappy start, gentle landing — reads as a "pop into place".
function _easeOutCubic(t) {
  const c = Math.max(0, Math.min(1, t))
  return 1 - (1 - c) ** 3
}

// Reveal styles. Each is called once per frame *after* the world transform
// (translate(tx,ty) → scale(scale)) while progress p (eased, 0..1) is < 1.
// A style may apply extra ctx transforms/clips (cleaned up by _draw's outer
// save/restore) and returns a global-alpha multiplier folded into every
// primitive. Contract: at p→1 the net effect must be identity (no transform,
// alpha 1) so the graph lands exactly on the fitted frame. 'none' is handled
// in _armReveal (no animation at all), so it has no entry here.
const REVEAL_STYLES = {
  // Pure cross-fade, no movement — calmest option.
  fade: (p) => p,
  // Scale up from the layout centroid (≤1, so it grows into frame) + fade.
  bloom: (p, cx, cy) => {
    const s = REVEAL_SCALE_MIN + (1 - REVEAL_SCALE_MIN) * p
    ctx.translate(cx, cy)
    ctx.scale(s, s)
    ctx.translate(-cx, -cy)
    return p
  },
  // Dolly back from an over-zoom (>1 → 1) about the centroid + fade. Feels
  // like the camera rushing in and settling.
  zoom: (p, cx, cy) => {
    const s = REVEAL_ZOOM_FROM + (1 - REVEAL_ZOOM_FROM) * p
    ctx.translate(cx, cy)
    ctx.scale(s, s)
    ctx.translate(-cx, -cy)
    return p
  },
  // Expanding circular clip from the centroid — nodes "develop" as the iris
  // passes them. Radius reaches the full extent by p≈1 (clip = no-op then).
  iris: (p, cx, cy, r) => {
    const rad = (r + NODE_RADIUS * 2) * (0.05 + 0.95 * p)
    ctx.beginPath()
    ctx.arc(cx, cy, rad, 0, Math.PI * 2)
    ctx.clip()
    return Math.min(1, 0.3 + p) // soft tail so the iris edge isn't a hard cut
  },
  // Slide up into place from below + fade.
  rise: (p) => {
    const off = (1 - p) * (height / (scale || 1)) * REVEAL_RISE_FRAC
    ctx.translate(0, off)
    return p
  },
}

// 'none' (instant, no animation) + every animated style. Stable order for a
// future config UI to enumerate.
const REVEAL_STYLE_NAMES = ['none', 'fade', 'bloom', 'zoom', 'iris', 'rise']

/**
 * Select the open-reveal style. Accepts any name in REVEAL_STYLE_NAMES;
 * unknown names are ignored (current style kept). Persists across graph
 * re-opens. User-configurability wiring is layered on top of this later.
 * @param {string} name
 */
export function setRevealStyle(name) {
  if (name !== 'none' && !REVEAL_STYLES[name]) {
    glog.warn('unknown reveal style', { name, known: REVEAL_STYLE_NAMES })
    return
  }
  _revealStyle = name
  dbg('reveal style set', { style: name })
}

export { REVEAL_STYLE_NAMES }

/**
 * Arm the open-reveal. Called *after* the one-shot fit so the reveal plays on
 * the correctly-framed graph. Pivot is the centroid of the visible, finite
 * nodes (world coords) — the same set fitToVisible just framed, so the effect
 * stays centred in view; _revealR is the max node distance from it (for the
 * 'iris' clip). 'none' ⇒ no animation; no valid nodes ⇒ skip.
 */
function _armReveal() {
  if (_revealStyle === 'none') {
    _revealing = false
    return
  }
  let sx = 0,
    sy = 0,
    n = 0
  for (const nd of nodes) {
    if (nd.hidden || !Number.isFinite(nd.x) || !Number.isFinite(nd.y)) continue
    sx += nd.x
    sy += nd.y
    n++
  }
  if (n === 0) {
    _revealing = false
    return
  }
  _revealCx = sx / n
  _revealCy = sy / n
  let maxD2 = 0
  for (const nd of nodes) {
    if (nd.hidden || !Number.isFinite(nd.x) || !Number.isFinite(nd.y)) continue
    const dx = nd.x - _revealCx
    const dy = nd.y - _revealCy
    const d2 = dx * dx + dy * dy
    if (d2 > maxD2) maxD2 = d2
  }
  _revealR = Math.sqrt(maxD2)
  _revealT0 = performance.now()
  _revealing = true
  _invalidate('reveal-armed')
  dbg('reveal armed', { style: _revealStyle, pivot: [Math.round(_revealCx), Math.round(_revealCy)], r: Math.round(_revealR), nodes: n })
}

// ===== input ===============================================================

function _resize() {
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) {
    dbg('_resize SKIP zero-rect', { rectW: rect.width, rectH: rect.height })
    return
  }
  dpr = window.devicePixelRatio || 1
  const oldW = width,
    oldH = height
  width = rect.width
  height = rect.height
  const bufW = Math.round(width * dpr)
  const bufH = Math.round(height * dpr)
  let bufChanged = false
  if (canvas.width !== bufW) {
    canvas.width = bufW
    bufChanged = true
  }
  if (canvas.height !== bufH) {
    canvas.height = bufH
    bufChanged = true
  }
  if (!_cameraCentered) {
    tx = width / 2
    ty = height / 2
    _cameraCentered = true
    dbg('_resize INITIAL center', camSnap())
  } else if (oldW !== width || oldH !== height) {
    dbg('_resize dim change', { oldW, oldH, newW: width, newH: height, bufChanged })
  }
  // First valid size after a _settle: frame the pre-ticked layout. Overrides
  // the canvas-centre seed above with a real bounding-box fit.
  if (_pendingFit && width && height) {
    fitToVisible()
    _pendingFit = false
    _armReveal()
    dbg('_resize consumed pendingFit', camSnap())
  }
  _invalidate('resize')
}

function _screenToWorld(sx, sy) {
  return { x: (sx - tx) / scale, y: (sy - ty) / scale }
}

function _hitTest(sx, sy) {
  const _t0 = performance.now()
  const w = _screenToWorld(sx, sy)
  let best = null
  let bestDist = Infinity
  const consider = (n) => {
    if (n.hidden) return
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) return
    const dx = n.x - w.x
    const dy = n.y - w.y
    const d = dx * dx + dy * dy
    // Per-node hit radius (matches the 1.3× hover-enlarged shape + slack);
    // still nearest-wins among everything the pointer is actually over.
    const hitR = (n.r || NODE_RADIUS) * 1.3 + 3
    if (d <= hitR * hitR && d < bestDist) {
      bestDist = d
      best = n
    }
  }
  if (grid.size && !_gridStale) {
    // GRID_CELL > the hit radius, so any node within range lands in the
    // point's cell or one of its 8 neighbors — a 3×3 sweep is exhaustive.
    const cx = Math.floor(w.x / GRID_CELL)
    const cy = Math.floor(w.y / GRID_CELL)
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const bucket = grid.get(gx + ',' + gy)
        if (bucket) for (const n of bucket) consider(n)
      }
    }
  } else {
    for (const n of nodes) consider(n)
  }
  if (typeof window !== 'undefined') window._gcLastHitMs = +(performance.now() - _t0).toFixed(3)
  return best
}

function _onWheel(ev) {
  ev.preventDefault()
  const rect = canvas.getBoundingClientRect()
  const sx = ev.clientX - rect.left
  const sy = ev.clientY - rect.top
  const before = _screenToWorld(sx, sy)
  const factor = Math.exp(-ev.deltaY * 0.0015)
  const oldScale = scale
  scale = Math.max(0.1, Math.min(8, scale * factor))
  const after = _screenToWorld(sx, sy)
  tx += (after.x - before.x) * scale
  ty += (after.y - before.y) * scale
  dbg('_onWheel', { deltaY: ev.deltaY, factor: +factor.toFixed(3), oldScale, ...camSnap() })
  needsDraw = true // raw: self-logged by the dbg('_onWheel') above
  // Refresh the status bar only when the zoom crossed a LOD band boundary
  // (cheap guard — _emitStats itself recomputes counts).
  const band = (s) => (s < simParams.lodNsFadeHi ? 0 : s < simParams.lodPodFadeLo ? 1 : 2)
  if (band(oldScale) !== band(scale)) _emitStats()
}

function _onMouseDown(ev) {
  const rect = canvas.getBoundingClientRect()
  const sx = ev.clientX - rect.left
  const sy = ev.clientY - rect.top
  const hit = _hitTest(sx, sy)
  _mouseDownAt = { x: ev.clientX, y: ev.clientY, hitId: hit ? hit.id : null }
  // Release any leftover pinned node from a previous drag whose mouseup
  // we missed (browser blur, focus change). Otherwise its fx/fy stays
  // set forever and the sim runs indefinitely with alphaTarget bumped.
  if (dragging && dragging.node && dragging.node !== hit) {
    dragging.node.fx = null
    dragging.node.fy = null
    dragging = null
  }
  if (hit) {
    const w = _screenToWorld(sx, sy)
    hit.fx = hit.x
    hit.fy = hit.y
    dragging = { node: hit, dx: w.x - hit.x, dy: w.y - hit.y }
    if (sim) sim.alphaTarget(0.3).restart()
    canvas.style.cursor = 'grabbing'
    dbg('_onMouseDown hit', {
      id: hit.id,
      label: hit.label,
      hx: +hit.x.toFixed(1),
      hy: +hit.y.toFixed(1),
      wx: +w.x.toFixed(1),
      wy: +w.y.toFixed(1),
      ...camSnap(),
    })
  } else {
    panning = { x: ev.clientX, y: ev.clientY }
    canvas.style.cursor = 'grabbing'
    dbg('_onMouseDown empty', { sx, sy, ...camSnap() })
  }
  needsDraw = true // raw: self-logged by the dbg('_onMouseDown …') above
}

function _onMouseMove(ev) {
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const sx = ev.clientX - rect.left
  const sy = ev.clientY - rect.top
  if (dragging) {
    const w = _screenToWorld(sx, sy)
    dragging.node.fx = w.x - dragging.dx
    dragging.node.fy = w.y - dragging.dy
    needsDraw = true // raw, not _invalidate(): per-mousemove drag
    return
  }
  if (panning) {
    tx += ev.clientX - panning.x
    ty += ev.clientY - panning.y
    panning.x = ev.clientX
    panning.y = ev.clientY
    needsDraw = true // raw, not _invalidate(): per-mousemove pan
    return
  }
  const hit = _hitTest(sx, sy)
  const id = hit ? hit.id : null
  if (id !== hoverId) {
    hoverId = id
    canvas.style.cursor = id ? 'pointer' : 'grab'
    needsDraw = true // raw, not _invalidate(): per-mousemove hover
  }
}

function _onMouseUp(ev) {
  // Click vs drag: if mouse barely moved between down and up, treat as a
  // click. On a node → fire the registered handler. On empty canvas →
  // clear the current selection (so the white ring + neighborhood dim
  // doesn't stick until the next node click).
  if (_mouseDownAt && ev) {
    const dx = ev.clientX - _mouseDownAt.x
    const dy = ev.clientY - _mouseDownAt.y
    // 5px tolerance: tight enough that intentional pans/drags don't fire
    // click, forgiving enough that natural mouse drift during a click
    // still counts. On a node → inspector; on empty canvas → clear it.
    if (dx * dx + dy * dy < 25) {
      if (_mouseDownAt.hitId && onNodeClick) onNodeClick(_mouseDownAt.hitId)
      else if (!_mouseDownAt.hitId && onBackgroundClick) onBackgroundClick()
    }
  }
  _mouseDownAt = null
  if (dragging) {
    dbg('_onMouseUp drag end', { id: dragging.node?.id, fx: dragging.node?.fx, fy: dragging.node?.fy })
    dragging.node.fx = null
    dragging.node.fy = null
    if (sim) sim.alphaTarget(0)
    dragging = null
  }
  if (panning) {
    dbg('_onMouseUp pan end', camSnap())
  }
  panning = null
  if (canvas) canvas.style.cursor = hoverId ? 'pointer' : 'grab'
}
