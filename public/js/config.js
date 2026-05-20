//@ts-check
/// <reference path="./types/custom.d.ts" />

// ==========================================================================================
// Client-side configuration management for KubeAtlas using local storage
// ==========================================================================================

import { log } from './log.js'

const slog = log.ns('config')

/** @type {Config | null}*/
let config = null

/** @type {Config}*/
const defaultConfig = {
  debug: false,
  shortenNames: true,
  spacing: 100,
  // Kinds hidden from the sidebar (empty = show all). Deselecting a kind in
  // the Filters tab adds it here; empty default preserves existing behavior
  // for users with older saved configs.
  hiddenKinds: [],
  // Height of the detail pane content area (px) when not expanded. Users can
  // drag the top handle to adjust; persisted across reloads. Retained as a
  // legacy single value for back-compat; per-tab overrides live in
  // detailHeights below.
  detailHeight: 320,
  // Per-tab collapsed content height. Yaml/events often benefit from a
  // taller collapsed pane than info, so each tab remembers its own.
  detailHeights: { info: 320, yaml: 320, events: 320 },
  // When true, per-tab expansion preference (collapsed vs expanded) carries
  // over across different resources instead of resetting on each open.
  persistDetailExpansion: true,
  // When true, the last-opened detail tab (info/yaml/events) carries over
  // across different resources instead of resetting to info on each open.
  persistDetailTab: true,
  // Last-active detail tab, persisted across refreshes. Restored on load
  // so the user's chosen tab survives reload (gated by persistDetailTab
  // at read time so an off toggle doesn't hydrate it).
  detailTab: 'info',
  // Per-tab explicit expand/collapse preference, persisted across refreshes.
  // null = no user choice yet (defaults apply). Mirrors mainApp._tabExpanded.
  detailTabExpanded: { info: null, yaml: null, events: null },
  // Graph view: BFS depth from the selected resource when focus mode is on.
  graphDepth: 2,
  // Graph view: whether focus-on-selected is enabled.
  graphFocusEnabled: false,
  // Graph view: show orphan nodes (no edges). Hidden by default because
  // namespaces with hundreds of unreferenced Secrets/ConfigMaps would
  // otherwise drown the meaningful clusters.
  graphShowOrphans: false,
  // Graph view: overlay the official K8s icons on nodes (opt-in). Auto-
  // suppressed when zoomed out or on very large clusters for perf.
  graphIconOverlay: false,
  // Graph view: simulation config-panel overrides (partial of SIM_DEFAULTS
  // in graph-canvas.js). Empty = use the tuned defaults.
  graphSim: {},
  // Graph view: open-reveal animation style (see REVEAL_STYLE_NAMES).
  graphRevealStyle: 'bloom',
}

/**
 * Gets the configuration object from local storage.
 * @returns {Config} The configuration object.
 */
export function getConfig() {
  if (config !== null) return config

  // Set the default client ID to a random value
  if (!localStorage.getItem('kubeatlasConfig')) {
    localStorage.setItem('kubeatlasConfig', JSON.stringify(defaultConfig))

    config = defaultConfig
    return config
  }

  // Get the config from local storage. Corrupted JSON (manual edit, browser
  // glitch, partial write) would otherwise throw uncaught here and brick the
  // page on load. Fall back to defaults and surface the corruption.
  let cfg = null
  try {
    cfg = JSON.parse(localStorage.getItem('kubeatlasConfig') || 'null')
  } catch (err) {
    slog.error('💥 corrupt config in localStorage; resetting to defaults', err)
    localStorage.setItem('kubeatlasConfig', JSON.stringify(defaultConfig))
    config = defaultConfig
    return config
  }
  config = cfg
  // Forward-migration: older saved configs may be missing newer keys
  if (config && !Array.isArray(config.hiddenKinds)) config.hiddenKinds = []
  if (config && typeof config.detailHeight !== 'number') config.detailHeight = 320
  if (config && (!config.detailHeights || typeof config.detailHeights !== 'object')) {
    const seed = config.detailHeight
    config.detailHeights = { info: seed, yaml: seed, events: seed }
  }
  if (config && typeof config.persistDetailExpansion !== 'boolean') config.persistDetailExpansion = true
  if (config && typeof config.persistDetailTab !== 'boolean') config.persistDetailTab = true
  if (config && config.detailTab !== 'info' && config.detailTab !== 'yaml' && config.detailTab !== 'events') {
    config.detailTab = 'info'
  }
  if (config && (!config.detailTabExpanded || typeof config.detailTabExpanded !== 'object')) {
    config.detailTabExpanded = { info: null, yaml: null, events: null }
  }
  if (config && (typeof config.graphDepth !== 'number' || config.graphDepth < 1 || config.graphDepth > 5)) config.graphDepth = 2
  if (config && typeof config.graphFocusEnabled !== 'boolean') config.graphFocusEnabled = false
  if (config && typeof config.graphShowOrphans !== 'boolean') config.graphShowOrphans = false
  if (config && typeof config.graphIconOverlay !== 'boolean') config.graphIconOverlay = false
  if (config && (!config.graphSim || typeof config.graphSim !== 'object')) config.graphSim = {}
  if (config && typeof config.graphRevealStyle !== 'string') config.graphRevealStyle = 'bloom'
  return config || defaultConfig
}

export async function saveConfig(newConfig) {
  // Weird bug where spacing is a string instead of a number
  newConfig.spacing = parseInt(newConfig.spacing) || 100

  // Surface which keys actually changed so the buffer ties later behavior
  // back to the toggle that caused it. Diffing JSON-serialized values
  // handles primitives, arrays (hiddenKinds), and nested objects
  // (detailHeights, detailTabExpanded) without bespoke per-key handling.
  const prev = config || {}
  const changed = []
  for (const k of new Set([...Object.keys(prev), ...Object.keys(newConfig)])) {
    if (JSON.stringify(prev[k]) !== JSON.stringify(newConfig[k])) {
      changed.push(k)
    }
  }
  if (changed.length > 0) slog.info('config save', { changed })

  // Set the config in local storage
  localStorage.setItem('kubeatlasConfig', JSON.stringify(newConfig))
  config = newConfig
}
