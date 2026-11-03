/**
 * Talking to a desktop over the local network instead of the relay.
 *
 * The relay is a public host on the far side of the internet: measured from a
 * Mac, one request costs about 400 ms through it and about 1.5 ms over the
 * LAN. For a tool where every tap is a round trip — approving a prompt,
 * switching panes, typing — that difference is the difference between usable
 * and not.
 *
 * The catch is transport security. Alma's direct listener speaks plain `ws://`
 * and has no TLS port, so using it means traffic that the relay would have
 * wrapped in TLS now travels unencrypted on the wire. The payload is still
 * sealed end to end and the desktop still has to prove it holds the pairing
 * code, so the *content* is safe — but an on-path attacker on a shared network
 * could still disrupt it. That is acceptable on a home or office network and
 * not acceptable in a café. This module is where "is this a network we are
 * willing to do that on" is decided.
 */

/** A desktop's direct listener, as the user or the desktop reported it. */
export interface LanAddress {
  host: string
  port: number
}

/** The port Alma listens on for direct connections. */
export const DEFAULT_LAN_PORT = 23019

/**
 * Whether an address is on the local network.
 *
 * Only the ranges reserved for private use count. A "public" address here
 * would mean the desktop is reachable from the internet over plain text —
 * exactly the case this feature must never create — and a hostname is rejected
 * because resolving it is a lookup we cannot vet.
 */
export function isLanHost(host: string): boolean {
  const ip = host.trim()
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])]
    if ([a, b, Number(v4[3]), Number(v4[4])].some((part) => part > 255)) return false
    if (a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    // 169.254/16 is link-local: a desktop can legitimately appear here when a
    // router is down, and it never leaves the segment.
    if (a === 169 && b === 254) return true
    return false
  }
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10). Only the
  // bracketed form is accepted, so nothing else can slip through.
  const v6 = /^\[([0-9a-f:]+)\]$/i.exec(ip)
  if (v6) {
    const value = v6[1].toLowerCase()
    return value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')
  }
  return false
}

/**
 * Parses what a user typed into an address, or explains why it cannot be used.
 *
 * Accepts `192.168.1.10`, `192.168.1.10:23019`, and the same in brackets for
 * IPv6. A bare address gets the default port. A hostname is refused rather than
 * resolved: "localhost" would point at the phone, and `alma-e2e.local` could
 * resolve anywhere.
 */
export function parseLanAddress(input: string): { address?: LanAddress; error?: 'empty' | 'invalid' | 'not-lan' } {
  const text = input.trim()
  if (!text) return { error: 'empty' }
  let host = text
  let port = DEFAULT_LAN_PORT
  const bracketed = /^(\[[0-9a-fA-F:]+\])(?::(\d{1,5}))?$/.exec(text)
  if (bracketed) {
    host = bracketed[1]
    if (bracketed[2]) port = Number(bracketed[2])
  } else {
    const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(text)
    if (!match) return { error: 'invalid' }
    host = match[1]
    if (match[2]) port = Number(match[2])
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'invalid' }
  if (!isLanHost(host)) return { error: 'not-lan' }
  return { address: { host, port } }
}

/** The URL the tunnel dials for a direct connection. */
export function lanUrl(address: LanAddress, path: string): string {
  return `ws://${address.host}:${address.port}${path}`
}

/** Whether a candidate should be tried at all: private address, sane port. */
export function usableLanAddress(address: LanAddress | undefined): address is LanAddress {
  return Boolean(address && isLanHost(address.host) && Number.isInteger(address.port) && address.port > 0 && address.port < 65_536)
}

/**
 * One interface the phone is attached to.
 *
 * `address` is the device's own address and `prefixLength` its mask, which
 * together define the subnet the desktop has to share to be reachable locally.
 */
export interface DeviceSubnet {
  address: string
  prefixLength: number
}

/** Dotted-quad to a 32-bit integer, or null when it is not one. */
export function ipv4ToInt(address: string): number | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address.trim())
  if (!match) return null
  const parts = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])]
  if (parts.some((part) => part > 255)) return null
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}

/** The network mask for a prefix length, as a 32-bit integer. */
export function prefixMask(prefixLength: number): number {
  if (prefixLength <= 0) return 0
  if (prefixLength >= 32) return 0xffffffff
  return (0xffffffff << (32 - prefixLength)) >>> 0
}

/**
 * Whether `target` sits on the same subnet as `subnet`.
 *
 * This is the whole access-control decision for the plain-text path. The phone
 * knows its own address and mask, so "the desktop is on my network" is an
 * exact question, not a guess — far tighter than allowing every private range,
 * which would also permit a stranger's host on a different private network the
 * phone happens to route to.
 *
 * Deliberately excludes the network and broadcast addresses: on a /24 those are
 * the gateway's subnet marker and the broadcast address, never a desktop.
 */
export function isSameSubnet(target: string, subnet: DeviceSubnet): boolean {
  const targetInt = ipv4ToInt(target)
  const localInt = ipv4ToInt(subnet.address)
  if (targetInt === null || localInt === null) return false
  if (!Number.isInteger(subnet.prefixLength) || subnet.prefixLength < 1 || subnet.prefixLength > 32) return false
  const mask = prefixMask(subnet.prefixLength)
  if ((targetInt & mask) !== (localInt & mask)) return false
  // A /31 and /32 have no reserved host addresses, so nothing to exclude.
  if (subnet.prefixLength >= 31) return true
  const hostBits = ~mask >>> 0
  const offset = targetInt & hostBits
  return offset !== 0 && offset !== hostBits
}

/** Whether any of the phone's interfaces shares a subnet with `target`. */
export function isOnLocalNetwork(target: string, subnets: readonly DeviceSubnet[]): boolean {
  if (!isLanHost(target)) return false
  return subnets.some((subnet) => isSameSubnet(target, subnet))
}

/**
 * Which addresses are worth probing on a subnet.
 *
 * Deliberately excludes the network and broadcast addresses, and starts at
 * .1 so the gateway is included — a desktop is never the gateway, but probing
 * it costs one handshake and rules it out for certain.
 */
export function probeTargets(subnet: DeviceSubnet, limit = 254): string[] {
  const base = ipv4ToInt(subnet.address)
  if (base === null) return []
  if (!Number.isInteger(subnet.prefixLength) || subnet.prefixLength < 16 || subnet.prefixLength > 30) return []
  const mask = prefixMask(subnet.prefixLength)
  const network = (base & mask) >>> 0
  const size = (~mask >>> 0) + 1
  // A /16 is 65 534 hosts: far too many to probe. Only /24 and narrower are
  // considered, which is what every home and office network actually uses.
  if (size > 256) return []
  const out: string[] = []
  for (let offset = 1; offset < size - 1 && out.length < limit; offset++) {
    const value = (network + offset) >>> 0
    out.push([value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.'))
  }
  return out
}

/** Whether a subnet is small enough to be worth scanning at all. */
export function scannableSubnet(subnet: DeviceSubnet): boolean {
  return ipv4ToInt(subnet.address) !== null && subnet.prefixLength >= 24 && subnet.prefixLength <= 30
}
