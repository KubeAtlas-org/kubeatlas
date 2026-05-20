//@ts-check
/// <reference path="./types/custom.d.ts" />

import { showToast } from '../ext/toast.js'
import { getEvents, getTimestamp } from './cache.js'
import { log } from './log.js'

const slog = log.ns('events')

// ==========================================================================================
// Events dialog component for displaying Kubernetes events
// Note this is very different from the SSE events handled by events.js
// ==========================================================================================

export default () => ({
  /** @type {Resource[]} */
  events: [],

  init() {
    this.$watch('showEventsDialog', (showEventsDialog) => {
      if (showEventsDialog) {
        this.updateEvents()
      }
    })

    // Listen for events as they are added to the cache
    window.addEventListener('kubeEventAdded', (event) => {
      if (this.showEventsDialog) {
        /** @type {Resource} */
        const newEvent = /** @type {CustomEvent} */ (event).detail

        // Add the new event to the top of the list without re-fetching everything
        this.events.unshift(newEvent)

        // Keep the list from growing indefinitely
        if (this.events.length > 100) {
          this.events.pop()
        }
      }
    })

    // Listen for events as they are updated in the cache
    window.addEventListener('eventsUpdated', (event) => {
      if (this.showEventsDialog) {
        /** @type {Resource} */
        const updatedEvent = /** @type {CustomEvent} */ (event).detail

        // Find and replace in-place to avoid a full re-fetch
        const index = this.events.findIndex((e) => e.metadata.uid === updatedEvent.metadata.uid)
        if (index !== -1) {
          this.events[index] = updatedEvent
        }
      }
    })
  },

  // Update the list of events in our UI state, from the cache
  updateEvents() {
    // Note this fetches ALL the events, but we're only talking about ~100 events at a time
    // And we're just copying the data from one array to another
    this.events = getEvents()

    if (this.events.length === 0) {
      slog.warn('events dialog opened with no events in cache')
      this.$nextTick(() => {
        showToast('No events found in namespace', 3000, 'top-center', 'warning')
      })

      this.showEventsDialog = false
      return
    }

    slog.info('events dialog open', { count: this.events.length })
  },

  // Warning events are red, Normal events are green
  // See https://kubernetes.io/docs/reference/kubernetes-api/cluster-resources/event-v1/
  rowClass(event) {
    return event.type === 'Warning' ? 'is-warning' : 'is-normal'
  },

  // Format the event message for display
  niceDate(event) {
    const date = new Date(getTimestamp(event))
    return date.toLocaleString()
  },
})
