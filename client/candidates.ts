/**
 * Asking a desktop where it can be reached locally.
 *
 * Alma's desktop serves `GET /__alma_lan__` over the authenticated tunnel and
 * answers with the addresses its own LAN listener is bound to:
 *
 *     { "port": 23019, "hosts": ["192.168.1.20", "macbook.local"] }
 *
 * A 404 means "no listener, or too old to have one" and is a normal answer.
 * That is the whole point of this path: one round trip tells the phone where to
 * look, where scanning the subnet costs a /24 of handshakes and only guesses.
 *
 * Nothing here is trusted. An address is used only after the caller has checked
 * that it is reachable from this phone *and* that a full handshake with the
 * saved pairing code succeeds — the same bar a scanned address has to clear.
 * A candidate list is a hint about where to aim, never a statement about who
 * answers.
 */

/** Where the desktop reports its LAN listener. */
export const LAN_CANDIDATE_PATH = '/__alma_lan__'

export interface LanCandidate {
  port: number
  /** Addresses as the desktop reported them, in its own preference order. */
  hosts: string[]
}

/**
 * Parses what `/__alma_lan__` returned, or null when it is not usable.
 *
 * Deliberately strict: a malformed answer is treated exactly like a 404, so a
 * desktop with a bug in this route cannot make the app dial something odd. The
 * per-host filtering is left to the caller, which knows the phone's subnets —
 * `.local` names in particular are reported by some desktops but cannot be
 * resolved by an Android WebView, so they must not become the primary guess.
 */
export function parseLanCandidate(value: unknown): LanCandidate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const port = Number(record.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  if (!Array.isArray(record.hosts)) return null
  const hosts = record.hosts
    .filter((host): host is string => typeof host === 'string')
    .map((host) => host.trim())
    .filter((host) => host.length > 0 && host.length <= 253)
  if (!hosts.length) return null
  return { port, hosts: [...new Set(hosts)] }
}

/**
 * The candidate addresses worth trying, in order.
 *
 * IPv4 literals first, because they are what the phone can resolve and compare
 * against its own subnets. `.local` names are dropped: Android's WebView does
 * not resolve mDNS, so an address like `macbook.local` is a guess that can only
 * fail — and it would sit in front of the working one for a full timeout.
 */
export function usableCandidateHosts(candidate: LanCandidate): string[] {
  return candidate.hosts.filter((host) => !host.toLowerCase().endsWith('.local'))
}

/**
 * A stable identity for one candidate address.
 *
 * Two desktops on the same network can report the same port; the address is
 * what tells them apart, and it is what a discovered route is remembered by.
 */
export function candidateKey(host: string, port: number): string {
  return `${host.toLowerCase()}:${port}`
}
