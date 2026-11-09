/**
 * Giving up on a path that keeps failing.
 *
 * A direct address that cannot be reached costs two seconds on every connect:
 * the dial waits, gives up, and falls back to the relay. On a phone that is
 * away from home — the normal case — that is two seconds added to every
 * reconnect, for a path that has not worked once today.
 *
 * So a few consecutive failures suspend the path briefly. The point is not
 * punishment: the address may become reachable again the moment the phone
 * comes home, the Wi-Fi finishes re-associating, or the router stops dropping
 * client-to-client traffic. The suspension is therefore short, and it lives in
 * memory only.
 *
 * Both of those are deliberate, and both were learned the hard way. A verdict
 * that outlived the process meant a phone that failed to reach its own desk
 * while the Wi-Fi was still waking up stayed on the relay after a restart; and
 * a half-hour cooldown, combined with a cached address that suppressed every
 * new search, is what kept a session on `relay` for the rest of the day.
 */

/** Consecutive connection failures that suspend the path. */
export const BREAKER_THRESHOLD = 2

/**
 * How long a suspended path stays suspended.
 *
 * Short on purpose: a wrong verdict here costs latency, and the failures that
 * cause it are usually transient (a handover, a busy Wi-Fi radio, a desktop
 * whose listener had not come back yet).
 */
export const BREAKER_COOLDOWN_MS = 3 * 60_000

interface BreakerState {
  failures: number
  /** When the suspension began, 0 when not suspended. */
  suspendedAt: number
}

/**
 * Per-desktop verdicts, for this process only.
 *
 * Not persisted: see the note at the top. A fresh launch is a fresh opinion,
 * because the conditions that produced the old one may not exist any more and
 * nothing outside this module can tell the difference.
 */
const states = new Map<string, BreakerState>()

function read(key: string): BreakerState {
  const state = states.get(key)
  return state ? { ...state } : { failures: 0, suspendedAt: 0 }
}

function write(key: string, state: BreakerState) {
  states.set(key, state)
}

/** Whether the direct path for this host may be tried right now. */
export function directAllowed(hostId: string, now = Date.now()): boolean {
  const state = read(hostId)
  if (!state.suspendedAt) return true
  if (now - state.suspendedAt >= BREAKER_COOLDOWN_MS) {
    // The cooldown expired: forget the suspension and start clean.
    write(hostId, { failures: 0, suspendedAt: 0 })
    return true
  }
  return false
}

/** Records the outcome of using the direct path. */
export function recordDirect(hostId: string, reached: boolean, now = Date.now()) {
  if (reached) {
    // One success is enough: the address works, whatever happened before.
    write(hostId, { failures: 0, suspendedAt: 0 })
    return
  }
  const state = read(hostId)
  const failures = state.failures + 1
  if (failures >= BREAKER_THRESHOLD) write(hostId, { failures: 0, suspendedAt: now })
  else write(hostId, { failures, suspendedAt: 0 })
}

/**
 * Clears every suspension.
 *
 * A network change is exactly the event that can make an unreachable address
 * reachable, so a suspension decided on one network must not survive onto
 * another — that is how "it stopped working at home" happens.
 */
export function clearAllBreakers() {
  states.clear()
}

