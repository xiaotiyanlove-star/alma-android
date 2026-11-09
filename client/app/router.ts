/**
 * One place that answers "where does Back go?".
 *
 * The native shell calls into the page before falling back to the OS, so every
 * screen must be able to consume Back. Keeping the stack here (instead of in
 * App state) means the hardware button, the in-app arrow and an overlay all
 * agree on the same order:
 *
 *   overlay (dialog / sheet) -> session -> node picker -> settings -> exit
 */
import { useSyncExternalStore } from 'react'

export type Route =
  | { name: 'sessions' }
  | { name: 'session'; hostId: string; paneId: string }
  | { name: 'settings' }
  | { name: 'pickHost' }
  | { name: 'addHost' }

type Overlay =
  | { kind: 'scan' }
  /** A desktop's own sheet: rename, pairing link, delete, reconnect. */
  | { kind: 'editHost' }
  | { kind: 'forget' }
  | { kind: 'share' }
  /**
   * A picture opened full-screen from the transcript.
   *
   * `scope` says which transcript it came from. The viewer swipes through that
   * transcript's pictures in reading order, and the subagent sheet draws its
   * own — so the list has to follow where the tap happened rather than
   * "whatever is on screen".
   */
  | { kind: 'image'; src: string; scope?: 'session' | 'subagent' }
  /** The sheet listing agents still running in this session. */
  | { kind: 'agents' }
  /** A dispatched subagent's own transcript. */
  | { kind: 'subagent' }
  /** The desktop chooser on the session list. */
  | { kind: 'pickHost' }
  /** The new-session form. */
  | { kind: 'newSession' }
  /** The rename-session form. */
  | { kind: 'renamePane' }
  /** Confirmation for closing a session's tab. */
  | { kind: 'deletePane' }

let route: Route = { name: 'sessions' }
/** Screens the user came from, so Back retraces their path. */
let history: Route[] = []
let overlay: Overlay | null = null
const listeners = new Set<() => void>()

function emit() { for (const listener of listeners) listener() }

export function getRoute(): Route { return route }
export function getOverlay(): Overlay | null { return overlay }

export function subscribeRoute(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribeRoute, getRoute, getRoute)
}
export function useOverlay(): Overlay | null {
  return useSyncExternalStore(subscribeRoute, getOverlay, getOverlay)
}

/** Navigate forward, remembering where we came from. */
export function push(next: Route) {
  if (sameRoute(next, route)) return
  history = [...history, route].slice(-12)
  route = next
  overlay = null
  emit()
}

/**
 * Replace the current entry (used when a desktop disappears or a session is
 * closed). A replacement means the previous screen no longer applies, so the
 * history that pointed at it is dropped rather than left to surprise Back.
 */
export function replace(next: Route) {
  route = next
  // The overlay is deliberately left alone: opening a session from a sheet
  // closes that sheet itself, while a swipe between a tab's panes must not
  // dismiss a picture the user is looking at. Anything that truly belongs to
  // the old screen is cleared by the screen that owned it.
  if (next.name === 'sessions') overlay = null
  history = history.filter((item) => {
    if (next.name === 'sessions') return false
    if (next.name === 'session' && item.name === 'session' && item.hostId === next.hostId) return false
    return true
  })
  emit()
}

/** Clears any open overlay without touching the route. */
export function dismissOverlay(): boolean {
  if (!overlay) return false
  overlay = null
  emit()
  return true
}

/** Go back one step. Returns false when there is nowhere left to go. */
export function back(): boolean {
  if (dismissOverlay()) return true
  const previous = history.at(-1)
  if (!previous) {
    // A session and settings both need somewhere to land; the list is home.
    if (route.name !== 'sessions') { route = { name: 'sessions' }; history = []; emit(); return true }
    return false
  }
  history = history.slice(0, -1)
  route = previous
  emit()
  return true
}

export function openOverlay(next: Overlay) { overlay = next; emit() }
export function closeOverlay() { if (overlay) { overlay = null; emit() } }

export function sameRoute(a: Route, b: Route): boolean {
  if (a.name !== b.name) return false
  if (a.name === 'session' && b.name === 'session') return a.hostId === b.hostId && a.paneId === b.paneId
  return true
}

/** Test hook: forget navigation state. */
export function resetForTests() { route = { name: 'sessions' }; history = []; overlay = null }
