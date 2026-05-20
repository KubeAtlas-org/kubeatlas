//@ts-check

// ==========================================================================================
// Event streaming for Kubernetes resources
// Handles SSE events from the server and dispatches them as window CustomEvents
// These are *not* the same as Kubernetes events, which are handled in events-dialog.js
// ==========================================================================================
import { log } from './log.js'

const slog = log.ns('sse')

let state = 'connecting' // 'connecting', 'connected', 'disconnected', 'paused'

/** @type {EventSource | null} */
let currentStream = null
let reconnectDelay = 2000
/** @type {ReturnType<typeof setTimeout> | null} */
let reconnectTimer = null

/**
 * Get a unique client ID for this session, stored in localStorage.
 * If no ID exists, generate a new one and store it.
 * @returns {string} The client ID
 */
export function getClientId() {
  let clientID = localStorage.getItem('clientId')

  if (!clientID || clientID === 'undefined' || clientID === 'null') {
    slog.warn('🆔 no client ID found, generating a new one', clientID)
    clientID = Math.random().toString(36).substring(2, 15)
    localStorage.setItem('clientId', clientID)
    return clientID
  }

  return clientID
}

/**
 * Set up the event streaming connection to receive live updates
 * from the server for Kubernetes resources
 */
export function initEventStreaming() {
  _connect()
}

/**
 * Open the SSE connection, registering all event handlers.
 * Closes any existing stream before opening a new one.
 */
function _connect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (currentStream) {
    currentStream.close()
    currentStream = null
  }

  slog.info('🌐 opening event stream')
  const sseUrl = `updates?clientID=${getClientId()}`
  const stream = new EventSource(sseUrl, {})
  currentStream = stream
  state = 'connecting'
  notifyStateChange()

  // Handle resource add events from the server
  stream.addEventListener('add', function (event) {
    if (state === 'paused') return

    /** @type {Resource} */
    let res
    try {
      res = JSON.parse(event.data)
    } catch (err) {
      slog.error('💥 error parsing add event', err)
      return
    }

    slog.debug('⬆️ add resource', res.kind, res.metadata.name)

    window.dispatchEvent(new CustomEvent('kubeEvent', { detail: { type: 'add', resource: res } }))
  })

  // Handle resource delete events from the server
  stream.addEventListener('delete', function (event) {
    if (state === 'paused') return

    /** @type {Resource} */
    let res
    try {
      res = JSON.parse(event.data)
    } catch (err) {
      slog.error('💥 error parsing delete event', err)
      return
    }

    slog.debug('☠️ delete resource', res.kind, res.metadata.name)

    window.dispatchEvent(new CustomEvent('kubeEvent', { detail: { type: 'delete', resource: res } }))
  })

  // Handle resource update events from the server
  stream.addEventListener('update', function (event) {
    if (state === 'paused') return

    /** @type {Resource} */
    let res
    try {
      res = JSON.parse(event.data)
    } catch (err) {
      slog.error('💥 error parsing update event', err)
      return
    }

    slog.debug('⬆️ update resource', res.kind, res.metadata.name)

    window.dispatchEvent(new CustomEvent('kubeEvent', { detail: { type: 'update', resource: res } }))
  })

  // Notify when the stream is connected
  stream.onopen = function () {
    slog.info('✅ event stream ready', stream.readyState === 1)
    reconnectDelay = 2000 // reset backoff on successful connection

    if (stream.readyState === 1) {
      state = 'connected'
    }

    notifyStateChange()
  }

  stream.onerror = function (event) {
    slog.error('‼️ event stream error', event)
    stream.close()
    currentStream = null
    state = 'disconnected'
    notifyStateChange()
    _scheduleReconnect()
  }
}

/**
 * Schedule a reconnect attempt with exponential backoff, capped at 30s.
 */
function _scheduleReconnect() {
  if (reconnectTimer) return
  slog.info(`🔄 reconnecting in ${reconnectDelay / 1000}s`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    reconnectDelay = Math.min(reconnectDelay * 2, 30000)
    _connect()
  }, reconnectDelay)
}

/**
 * Toggle the paused state of the event stream.
 */
export function togglePaused() {
  if (state === 'paused') {
    state = 'connected'
  } else if (state === 'connected') {
    state = 'paused'
  } else {
    return
  }

  notifyStateChange()
}

let _lastNotifiedState = null
function notifyStateChange() {
  if (state !== _lastNotifiedState) {
    slog.info('state', { from: _lastNotifiedState, to: state })
    _lastNotifiedState = state
  }

  const stateEvent = new CustomEvent('connectionStateChange', {
    detail: { state },
  })

  window.dispatchEvent(stateEvent)
}
