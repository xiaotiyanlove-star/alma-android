/**
 * Background behaviour.
 *
 * Leaving the app must not cost a reconnect: the socket and the transcript
 * subscriptions stay up while the user is briefly away. Only after a long
 * absence is the link dropped, so a phone left in a pocket overnight is not
 * holding a relay connection (and its radio) open all night.
 */

/** Stay connected this long after the app goes to the background. */
export const KEEP_WARM_MS = 5 * 60_000
/** After this absence, assume the user is gone and release the connection. */
export const DROP_AFTER_MS = 30 * 60_000

export type BackgroundAction = 'none' | 'suspend' | 'resume'

export interface LifecycleState {
  hiddenAt: number | null
  suspended: boolean
}

export function initialState(): LifecycleState {
  return { hiddenAt: null, suspended: false }
}

/**
 * Pure decision step, so the policy can be tested without a browser.
 *
 * - visible again after a short absence: resume without reconnecting
 * - hidden past KEEP_WARM_MS: nothing to do yet, the socket stays
 * - hidden past DROP_AFTER_MS: suspend, releasing sockets
 */
export function step(state: LifecycleState, event: 'hidden' | 'visible' | 'tick', now: number): { state: LifecycleState; action: BackgroundAction } {
  if (event === 'hidden') {
    return { state: { hiddenAt: now, suspended: state.suspended }, action: 'none' }
  }
  if (event === 'visible') {
    // Coming back after a suspend needs a reconnect; otherwise just resume.
    const action: BackgroundAction = state.suspended ? 'resume' : 'none'
    return { state: { hiddenAt: null, suspended: false }, action }
  }
  // tick: only meaningful while hidden
  if (state.hiddenAt === null || state.suspended) return { state, action: 'none' }
  if (now - state.hiddenAt >= DROP_AFTER_MS) {
    return { state: { ...state, suspended: true }, action: 'suspend' }
  }
  return { state, action: 'none' }
}
