//@ts-check

// ==========================================================================================
// Canvas-drawable cache of the official Kubernetes icon pack.
//
// The shared icons.js serves SVG `<use href>` references for the DOM. Canvas2D
// can't draw a sprite symbol directly, so this module fetches the K8s sprite
// once, slices each requested `<symbol>` into a standalone SVG, and rasterizes
// it to an Image keyed by kind. The graph's optional icon overlay draws those
// images on top of the status-coloured shapes.
//
// K8s pack ONLY (KIND_TO_K8S) — never the Lucide line set, and independent of
// the user's kaIconStyle. Kinds with no K8s glyph (e.g. Event) return null and
// the caller keeps the bare shape.
// ==========================================================================================

import { KIND_TO_K8S } from './icons.js'
import { log } from './log.js'

const glog = log.ns('graph-icons')
const K8S_SPRITE = '/public/ext/icons/sprite-k8s.svg'

// The sprite's symbols carry Inkscape/sodipodi/RDF cruft. Declaring those
// prefixes on the standalone root keeps the XML well-formed (SVG-as-image is
// parsed strictly); the renderer just ignores the unknown-namespace nodes.
const NS_DECL =
  'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
  'xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.0.dtd" ' +
  'xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" ' +
  'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" ' +
  'xmlns:cc="http://creativecommons.org/ns#" ' +
  'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:svg="http://www.w3.org/2000/svg"'

let _spriteDoc = null // parsed sprite XML document (null until loaded)
let _loading = null // in-flight load promise (dedupes concurrent warms)
const _cache = new Map() // kind → HTMLImageElement | null (null = no glyph)

/** Kick the one-time sprite fetch. Safe to call repeatedly. */
function _ensureSprite() {
  if (_spriteDoc || _loading) return _loading || Promise.resolve()
  _loading = fetch(K8S_SPRITE)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.text()
    })
    .then((txt) => {
      // Parse as text/html, NOT image/svg+xml: the sprite carries Inkscape/
      // sodipodi attributes with undeclared namespace prefixes that make the
      // strict XML parser bail after the first symbol. The HTML parser is
      // lenient and still resolves #k-<id> + viewBox correctly.
      _spriteDoc = new DOMParser().parseFromString(txt, 'text/html')
      glog.debug('k8s sprite loaded')
    })
    .catch((err) => {
      glog.warn('🛑 k8s sprite load failed; icon overlay disabled', { err: err?.message || String(err) })
      _spriteDoc = null
    })
    .finally(() => {
      _loading = null
    })
  return _loading
}

/**
 * Get a canvas-drawable Image for a kind, building + caching it on first ask.
 * Returns null when the sprite isn't loaded yet or the kind has no K8s glyph;
 * the returned Image may not be decoded yet (caller checks .complete /
 * naturalWidth and falls back to the bare shape until then).
 * @param {string} kind
 * @returns {HTMLImageElement | null}
 */
export function iconImageFor(kind) {
  if (_cache.has(kind)) return _cache.get(kind)
  const id = KIND_TO_K8S[kind]
  if (!id) {
    _cache.set(kind, null)
    return null
  }
  if (!_spriteDoc) {
    _ensureSprite()
    return null // try again on a later frame once loaded
  }
  const sym = _spriteDoc.querySelector('#k-' + id)
  if (!sym) {
    glog.debug('no k8s symbol', { kind, id })
    _cache.set(kind, null)
    return null
  }
  const vb = sym.getAttribute('viewBox') || '0 0 24 24'
  // Element children only (skips whitespace text nodes). NS_DECL on the root
  // keeps the Inkscape/sodipodi attributes well-formed for the SVG decoder.
  let inner = ''
  for (const child of sym.children) inner += child.outerHTML
  const svg = `<svg ${NS_DECL} viewBox="${vb}">${inner}</svg>`
  const img = new Image()
  img.decoding = 'async'
  // SVG decode is async. Whoever's drawing (the graph) may already be idle
  // (sim settled, no rAF) by the time it lands, so nudge a repaint — else
  // icons only appear on the next unrelated interaction.
  img.addEventListener('load', () => window.dispatchEvent(new Event('kaGraphIconReady')))
  img.addEventListener('error', () => glog.debug('icon decode failed', { kind }))
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  _cache.set(kind, img)
  return img
}

/** Pre-build images for the kinds about to be drawn (called during settle). */
export function warmIcons(kinds) {
  _ensureSprite().then(() => {
    for (const k of kinds) iconImageFor(k)
  })
}

/** Drop the cache (theme change — cheap; K8s glyphs are theme-independent). */
export function clearIconCache() {
  _cache.clear()
}
