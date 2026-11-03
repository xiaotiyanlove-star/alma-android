/**
 * The phone's current subnets, as the operating system reports them.
 *
 * Used to decide whether a desktop's local address is reachable over plain
 * text. Cached briefly: the answer only changes on a link handover, and a
 * reconnect usually follows one closely enough that a few seconds of staleness
 * is harmless, while asking the OS on every dial is not.
 */
import { Capacitor, registerPlugin } from '@capacitor/core'
import type { DeviceSubnet } from './lan'

interface LocalNetworkPlugin {
  subnets(): Promise<{ subnets: DeviceSubnet[] }>
}
const plugin = registerPlugin<LocalNetworkPlugin>('LocalNetwork')

/** Short enough to follow a handover, long enough to stop asking per dial. */
const CACHE_MS = 30_000

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
  inFlight = plugin.subnets()
    .then((result) => {
      const subnets = Array.isArray(result?.subnets) ? result.subnets : []
      // A handover during the call makes this answer belong to the old link.
      if (startedAt === generation) cached = { at: Date.now(), subnets }
      return subnets
    })
    .catch(() => [] as DeviceSubnet[])
    .finally(() => { inFlight = undefined })
  return inFlight
}

/** Drops the cache, so the next check sees the new link. */
export function forgetSubnets() {
  cached = undefined
  generation++
}

/** Test hook. */
export function resetForTests() {
  cached = undefined
  inFlight = undefined
  generation++
}
