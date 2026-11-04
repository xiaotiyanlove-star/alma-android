/**
 * Where a desktop was last reached over the local network.
 *
 * Discovering an address costs one round trip on the fast path and a subnet
 * scan on the slow one, and both happen again on every launch because a
 * discovered route lives only in memory. Remembering the last address that
 * actually answered turns the common case — the same phone, the same desk, the
 * same network as yesterday — into a single dial.
 *
 * It is a hint, not a setting, and it is treated as one: an address from here
 * is dialled only after the same checks a fresh answer gets (on this phone's
 * subnet, not claimed by another desktop, handshake with this pairing's code),
 * and it is forgotten the moment it stops answering or the network changes.
 * Nothing here is ever shown to the user as a saved preference.
 */

const KEY_PREFIX = 'herdr.lan.last.'

export interface LastRoute { host: string; port: number }

/**
 * The remembered address for one desktop, if it is still plausible.
 *
 * Scoped by host id, so two paired desktops never see each other's address.
 * Anything unreadable is treated as "nothing remembered" rather than an error:
 * a corrupted entry should cost a scan, not a broken connection.
 */
export function lastRoute(hostId: string): LastRoute | undefined {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + hostId)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as Partial<LastRoute>
    if (typeof parsed.host !== 'string' || !parsed.host) return undefined
    if (typeof parsed.port !== 'number' || !Number.isInteger(parsed.port) || parsed.port < 1 || parsed.port > 65535) return undefined
    return { host: parsed.host, port: parsed.port }
  } catch { return undefined }
}

/** Records an address that answered, replacing whatever was there. */
export function rememberRoute(hostId: string, route: LastRoute) {
  try { localStorage.setItem(KEY_PREFIX + hostId, JSON.stringify(route)) } catch { /* storage blocked */ }
}

/** Forgets it: the address stopped answering, or the network moved. */
export function forgetRoute(hostId: string) {
  try { localStorage.removeItem(KEY_PREFIX + hostId) } catch { /* storage blocked */ }
}

/** Forgets every desktop's address, for a network change. */
export function forgetAllRoutes(ids: readonly string[]) {
  for (const id of ids) forgetRoute(id)
}
