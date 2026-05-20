// ================================================================
// Small JavaScript loader for dynamic HTML components & fragments
// ================================================================

import { log } from './log.js'

const slog = log.ns('loader')
const PATH = 'public/fragments'

window.addEventListener('DOMContentLoaded', () => {
  // Find all divs with data-fragment attribute and load their HTML content
  document.querySelectorAll('div[data-fragment]').forEach(async (el) => {
    const frag = el.getAttribute('data-fragment')
    if (frag) {
      const res = await fetch(`${PATH}/${frag}.html?_=${Date.now()}`)
      if (!res.ok) {
        slog.error(`failed to load HTML fragment: ${frag}`, res.statusText)
        return
      }
      const html = await res.text()
      el.innerHTML = html
    }
  })
})
