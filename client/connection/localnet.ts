/**
 * The phone's current subnets, as the operating system reports them.
 *
 * Used to decide whether a desktop's local address is reachable over plain
 * text. Cached briefly: the answer only changes on a link handover, and a
 * reconnect usually follows one closely enough that a few seconds of staleness
 * is harmless, while asking the OS on every dial is not.
 */
import { Capacitor, registerPlugin } from '@capacitor/core'
import { withDeadline } from './deadline'
import type { DeviceSubnet } from './lan'

interface LocalNetworkPlugin {
  subnets(): Promise<{ subnets: DeviceSubnet[] }>
}
const plugin = registerPlugin<LocalNetworkPlugin>('LocalNetwork')

/** Short enough to follow a handover, long enough to stop asking per dial. */
const CACHE_MS = 30_000

/**
 * How long a bridge answer may take before it is treated as "no local network".
 *
 * The call runs on the WebView's own bridge, and a callback can be lost —
 * most easily when the page is frozen or resumed while it is outstanding. A
 * promise that never settles is not a slow answer, it is a dead one: every
 * later caller would receive the same pending future, and the dial that awaits
 * it would sit there until its own timeout, on *every* reconnect, with the
 * relay never even attempted. One and a half seconds is far longer than the
 * platform needs for a synchronous lookup and short enough to be invisible in
 * a dial that already waits two seconds for a direct socket.
 */
export const SUBNETS_TIMEOUT_MS = 1_500

let cached: { at: number; subnets: DeviceSubnet[] } | undefined
let inFlight: Promise<DeviceSubnet[]> | undefined
/** Bumped whenever the cache is invalidated, so a stale in-flight answer loses. */
let generation = 0

/** The current subnets, or none when the platform cannot report them. */
export async function deviceSubnets(now = Date.now()): Promise<DeviceSubnet[]> {
  if (!Capacitor.isNativePlatform()) return []
  if (cached && now - cached.at < CACHE_MS) return cached.subnets
  if (inFlight) return inFlight
  const startedAt = generation
  const answered = plugin.subnets()
    .then((result) => {
      const subnets = Array.isArray(result?.subnets) ? result.subnets : []
      // A handover during the call makes this answer belong to the old link.
      if (startedAt === generation) cached = { at: Date.now(), subnets }
      return subnets
    })
    .catch(() => [] as DeviceSubnet[])

  // The deadline is part of the shared promise, not a per-caller race, so a
  // bridge that never answers is remembered as `[]` instead of as a pending
  // future. The slot is released either way, which is what lets the next dial
  // ask again rather than inherit this one's silence.
  let pending: Promise<DeviceSubnet[]>
  pending = withDeadline(answered, SUBNETS_TIMEOUT_MS, []).finally(() => {
    // Release the slot even when the answer was the deadline's, so the next
    // dial asks again instead of inheriting this one's silence.
    if (inFlight === pending) inFlight = undefined
  })
  inFlight = pending
  return pending
}

/** Drops the cache, so the next check sees the new link. */
export function forgetSubnets() {
  cached = undefined
  generation++
}
