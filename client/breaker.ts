/**
 * Giving up on a path that keeps failing.
 *
 * A direct address that cannot be reached costs two seconds on every connect:
 * the dial waits, gives up, and falls back to the relay. On a phone that is
 * away from home — the normal case — that is two seconds added to every
 * reconnect, for a path that has not worked once today.
 *
 * So a few consecutive failures suspend the path for a while. The point is not
 * punishment: the address may become reachable again the moment the phone
 * comes home, which is why the suspension is short and why a network change
 * clears it immediately.
 */

/** Consecutive connection failures that suspend the path. */
export const BREAKER_THRESHOLD = 2

/** How long a suspended path stays suspended. */
export const BREAKER_COOLDOWN_MS = 30 * 60_000

interface BreakerState {
  failures: number
  /** When the suspension began, 0 when not suspended. */
  suspendedAt: number
}

const KEY_PREFIX = 'herdr.lan.breaker.'

function read(key: string): BreakerState {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return { failures: 0, suspendedAt: 0 }
    const parsed = JSON.parse(raw) as Partial<BreakerState>
    return {
      failures: Number(parsed.failures) || 0,
      suspendedAt: Number(parsed.suspendedAt) || 0,
    }
  } catch { return { failures: 0, suspendedAt: 0 } }
}

function write(key: string, state: BreakerState) {
  try { localStorage.setItem(key, JSON.stringify(state)) } catch { /* storage blocked */ }
}

/** Whether the direct path for this host may be tried right now. */
export function directAllowed(hostId: string, now = Date.now()): boolean {
  const state = read(KEY_PREFIX + hostId)
  if (!state.suspendedAt) return true
  if (now - state.suspendedAt >= BREAKER_COOLDOWN_MS) {
    // The cooldown expired: forget the suspension and start clean.
    write(KEY_PREFIX + hostId, { failures: 0, suspendedAt: 0 })
    return true
  }
  return false
}

/** Records the outcome of using the direct path. */
export function recordDirect(hostId: string, reached: boolean, now = Date.now()) {
  const key = KEY_PREFIX + hostId
  if (reached) {
    // One success is enough: the address works, whatever happened before.
    write(key, { failures: 0, suspendedAt: 0 })
    return
  }
  const state = read(key)
  const failures = state.failures + 1
  if (failures >= BREAKER_THRESHOLD) write(key, { failures: 0, suspendedAt: now })
  else write(key, { failures, suspendedAt: 0 })
}

/**
 * Clears every suspension.
 *
 * A network change is exactly the event that can make an unreachable address
 * reachable, so a suspension decided on one network must not survive onto
 * another — that is how "it stopped working at home" happens.
 */
export function clearAllBreakers() {
  try {
    const keys: string[] = []
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (key?.startsWith(KEY_PREFIX)) keys.push(key)
    }
    for (const key of keys) localStorage.removeItem(key)
  } catch { /* storage blocked */ }
}

/** Test hook. */
export function resetForTests() { clearAllBreakers() }
