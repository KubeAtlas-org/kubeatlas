//@ts-check
/// <reference path="./types/custom.d.ts" />

// ==========================================================================================
// Cache module for Kubernetes resources and events
// This module provides functions to query, save, and manage resources and events
// It maintains a map of resources and events, allowing for efficient access and updates
// ==========================================================================================

import { log } from './log.js'

const slog = log.ns('cache')

const resMap = {}

// Secondary indexes for O(1) lookup instead of O(n) full scan
const nameIndex = {} // "kind/name" → resource
const ipIndex = {} // "ip" → resource

// Events are stored in a separate map just for ease of access
const eventMap = {}

/**
 * Save & cache a resource object
 * @param {Resource} res The resource object to save
 */
export const store = (res) => {
  const id = res.metadata.uid

  // If it's an event, store it in the event map
  if (res.kind === 'Event') {
    eventMap[id] = res
    return
  }

  // Remove stale index entries if the resource already exists
  const existing = resMap[id]
  if (existing) {
    delete nameIndex[`${existing.kind}/${existing.metadata.name}`]
    const ip = existing.status?.podIP || existing.status?.clusterIP
    if (ip) delete ipIndex[ip]
  }

  // Store the resource in the resource map
  resMap[id] = res

  // Update secondary indexes
  nameIndex[`${res.kind}/${res.metadata.name}`] = res
  const ip = res.status?.podIP || res.status?.clusterIP
  if (ip) ipIndex[ip] = res
}

/**
 * Remove a resource or event from the cache by its ID
 * @param {string} id The unique identifier of the resource or event to remove
 */
export const remove = (id) => {
  const res = resMap[id]
  if (res) {
    delete nameIndex[`${res.kind}/${res.metadata.name}`]
    const ip = res.status?.podIP || res.status?.clusterIP
    if (ip) delete ipIndex[ip]
    delete resMap[id]
  }
  if (eventMap[id]) {
    delete eventMap[id]
  }
}

/**
 * Query the resource map with a filter function
 * @param {any} filterFn A function that takes a Resource and returns true if it should be included
 * @returns {any[]} An array of resources that match the filter function
 */
export const queryRes = (filterFn) => Object.values(resMap).filter(filterFn)

/**
 * Get a resource by kind and name in O(1) via the name index
 * @param {string} kind
 * @param {string} name
 * @returns {Resource | null} The resource, or null if not found
 */
export const getResByName = (kind, name) => nameIndex[`${kind}/${name}`] || null

/**
 * Get a resource by its IP address in O(1) via the IP index
 * @param {string} ip
 * @returns {Resource | null} The resource, or null if not found
 */
export const getResByIP = (ip) => ipIndex[ip] || null

/**
 * Get a cached resource by its ID
 * @param {string} id
 * @returns {Resource | null} The resource object or null if not found
 */
export const getResById = (id) => resMap[id] || null

/**
 * Get events from the cache for a specific resource by its UID
 * @param {string} uid The UID of the resource to get events for
 * @param {number} [count=50] The maximum number of events to return, defaults to 50
 * @returns {Resource[]} Events for that resource, newest first
 */
export const getEventsForResource = (uid, count = 50) =>
  Object.values(eventMap)
    .filter((ev) => ev.involvedObject?.uid === uid)
    .sort((a, b) => Date.parse(getTimestamp(b)) - Date.parse(getTimestamp(a)))
    .slice(0, count)

/**
 * Get events from the cache
 * @param {number} [count=100] The maximum number of events to return, defaults to 100
 * @return {Resource[]} An array of all events in the event map
 */
export const getEvents = (count = 100) =>
  Object.values(eventMap)
    .sort((a, b) => Date.parse(getTimestamp(b)) - Date.parse(getTimestamp(a)))
    .slice(0, count)

/**
 * Clear the resource and event cache
 * This is used to reset the graph state, e.g. when switching namespaces
 * @returns {void}
 */
export function clearCache() {
  const before = { resources: Object.keys(resMap).length, events: Object.keys(eventMap).length }
  Object.keys(resMap).forEach((key) => delete resMap[key])
  Object.keys(eventMap).forEach((key) => delete eventMap[key])
  Object.keys(nameIndex).forEach((key) => delete nameIndex[key])
  Object.keys(ipIndex).forEach((key) => delete ipIndex[key])
  slog.debug('clear', before)
}

/**
 * Get the timestamp of an event resource
 * @param {EventResource} event The event resource
 * @returns {string} The event timestamp, either from eventTime or lastTimestamp
 */
export function getTimestamp(event) {
  // Use eventTime if available, otherwise fall back to lastTimestamp
  return event.eventTime || event.lastTimestamp || event.metadata.creationTimestamp || ''
}
