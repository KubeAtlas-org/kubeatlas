//@ts-check

// ==========================================================================================
// Pod exec client — WebSocket + xterm.js terminal lifecycle for the exec view
// ==========================================================================================

import { log } from './log.js'

const slog = log.ns('exec')

/**
 * Create an exec client bound to a terminal element. Call `connect()` to open the
 * WebSocket and start streaming; `teardown()` closes the socket and disposes xterm.
 *
 * @param {object} opts
 * @param {string} opts.namespace
 * @param {string} opts.pod
 * @param {string} opts.container
 * @param {HTMLElement} opts.termElement
 */
export function createExecClient({ namespace, pod, container, termElement }) {
  /** @type {any | null} */
  let ws = null
  /** @type {any | null} */
  let term = null
  /** @type {any | null} */
  let fitAddon = null
  /** @type {ResizeObserver | null} */
  let resizeObs = null

  function teardown() {
    slog.debug('teardown', { namespace, pod, container })
    if (ws) {
      ws.close()
      ws = null
    }
    if (resizeObs) {
      resizeObs.disconnect()
      resizeObs = null
    }
    if (term) {
      term.dispose()
      term = null
      fitAddon = null
    }
  }

  function connect() {
    slog.info('connect', { namespace, pod, container })
    term = new window.Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'Courier New', monospace",
      theme: { background: '#0a0e14', foreground: '#d4d4d4', cursor: '#569cd6' },
    })
    fitAddon = new window.FitAddon.FitAddon()
    term.loadAddon(fitAddon)
    term.open(termElement)
    fitAddon.fit()

    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${wsProto}//${location.host}/ws/exec/${namespace}/${pod}?container=${encodeURIComponent(container)}`
    ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'

    const socket = ws
    const localTerm = term
    const localFit = fitAddon

    ws.onopen = () => {
      slog.debug('ws open')
      localFit.fit()
    }

    ws.onmessage = (ev) => {
      const buf = new Uint8Array(ev.data)
      if (!buf.length) return
      if (buf[0] === 0) {
        // frameData — write PTY output to terminal
        localTerm.write(buf.slice(1))
      } else if (buf[0] === 2) {
        // frameError
        const text = new TextDecoder().decode(buf.slice(1))
        slog.warn('💥 server frame error', text)
        localTerm.writeln(`\r\n\x1b[31m${text}\x1b[0m`)
      }
    }

    ws.onclose = (ev) => {
      slog.info('ws close', { code: ev.code, reason: ev.reason, wasClean: ev.wasClean })
      if (term === localTerm) localTerm.writeln('\r\n\x1b[90m[session closed]\x1b[0m')
    }

    ws.onerror = (ev) => {
      slog.error('💥 ws error', ev)
      if (term === localTerm) localTerm.writeln('\r\n\x1b[31m[connection error]\x1b[0m')
    }

    // PTY input: forward keystrokes to backend
    localTerm.onData((data) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return
      const encoded = new TextEncoder().encode(data)
      const msg = new Uint8Array(1 + encoded.length)
      msg[0] = 0 // frameData
      msg.set(encoded, 1)
      socket.send(msg)
    })

    // Terminal resize: send resize frame to backend
    localTerm.onResize(({ cols, rows }) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return
      const msg = new Uint8Array(5)
      msg[0] = 1 // frameResize
      new DataView(msg.buffer).setUint16(1, cols, true) // cols LE
      new DataView(msg.buffer).setUint16(3, rows, true) // rows LE
      socket.send(msg)
    })

    // Resize observer to keep terminal sized to container
    resizeObs = new ResizeObserver(() => {
      if (fitAddon === localFit) localFit.fit()
    })
    resizeObs.observe(termElement)
  }

  return { connect, teardown }
}
