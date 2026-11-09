/**
 * Background behaviour.
 *
 * Leaving the app must not cost a reconnect: the socket and the transcript
 * subscriptions stay up while the user is briefly away. Only after a long
 * absence is the link dropped, so a phone left in a pocket overnight is not
 * holding a relay connection (and its radio) open all night.
 */

/** After this absence, assume the user is gone and release the connection. */
export const DROP_AFTER_MS = 30 * 60_000
/**
 * A return checks the connection rather than replacing it.
 *
 * A socket can be dead while the page believes it is open: the close event
 * never ran because the page was frozen. A short read proves the tunnel works
 * end to end, and answers far faster than waiting for a request to time out.
 * Anything shorter than this is a permission dialog or the file picker coming
 * back, where the connection was never at risk.
 */
export const VERIFY_AFTER_MS = 2_000

export type BackgroundAction = 'none' | 'verify' | 'suspend' | 'resume'

export interface LifecycleState {
  hiddenAt: number | null
  suspended: boolean
}

export interface LifecycleResult {
  state: LifecycleState
  action: BackgroundAction
  /** How long the app was hidden, which decides whether to rebuild the tunnel. */
  awayMs: number
}

export function initialState(): LifecycleState {
  return { hiddenAt: null, suspended: false }
}

/**
 * Pure decision step, so the policy can be tested without a browser.
 *
 * - visible again almost at once: nothing, the connection was never at risk
 * - visible again after VERIFY_AFTER_MS: check the socket still answers
 * - visible again after a suspend: resume, dialling from scratch
 * - hidden past DROP_AFTER_MS: suspend, releasing sockets
 *
 * The absence is measured by a read, not by the clock. A time threshold cannot
 * tell "the socket died while the page was frozen" from "the socket is fine",
 * and guessing in the safe direction — replace it — meant every return after a
 * minute tore down a working connection: the route fell back to the relay, the
 * session reloaded, and an in-flight reply could be missed. One short read
 * answers the actual question, and only a read that fails rebuilds anything.
 * `awayMs` is 0 for anything but a return.
 */
export function returnAction(awayMs: number, suspended: boolean): BackgroundAction {
  if (suspended) return 'resume'
  return awayMs >= VERIFY_AFTER_MS ? 'verify' : 'none'
}

export function step(state: LifecycleState, event: 'hidden' | 'visible' | 'tick', now: number): LifecycleResult {
  if (event === 'hidden') {
    return { state: { hiddenAt: now, suspended: state.suspended }, action: 'none', awayMs: 0 }
  }
  if (event === 'visible') {
    const awayMs = state.hiddenAt === null ? 0 : Math.max(0, now - state.hiddenAt)
    return { state: { hiddenAt: null, suspended: false }, action: returnAction(awayMs, state.suspended), awayMs }
  }
  // tick: only meaningful while hidden
  if (state.hiddenAt === null || state.suspended) return { state, action: 'none', awayMs: 0 }
  if (now - state.hiddenAt >= DROP_AFTER_MS) {
    return { state: { ...state, suspended: true }, action: 'suspend', awayMs: 0 }
  }
  return { state, action: 'none', awayMs: 0 }
}
