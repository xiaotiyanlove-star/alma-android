/**
 * Finding the paired desktop on the local network.
 *
 * The desktop cannot be asked where it is: the handshake carries no address,
 * and the phone has no other channel to it except the relay. Without a change
 * on the desktop's side, the only way to learn its local address is to look
 * for it on the subnet the phone is attached to.
 *
 * What makes that safe is not the scan — it is what happens after. Every
 * address that answers is put through a complete handshake with the saved
 * pairing code, and only a desktop that computes the matching confirmation is
 * accepted. Two machines with the same hostname, the same address on different
 * networks, or a neighbour's Alma install all fail that check, because none of
 * them holds this pairing's code.
 *
 * A scan is deliberately rare and bounded: only while the app is on screen,
 * only when there is no cached answer, only on a subnet small enough to be a
 * home or office network, and only when the user has left discovery on. It does
 * not wait for the relay: a dead public path is exactly when the local one
 * matters most.
 */
import { base64url, constantTimeEqual, createKeyPair, deriveSessionKeys, fromBase64url } from './crypto'
import { DEFAULT_LAN_PORT, isLanHost, probeTargets, scannableSubnet, type DeviceSubnet, type LanAddress } from './lan'

/** How long one candidate gets to accept a connection. */
const CONNECT_TIMEOUT_MS = 900
/** How long it gets to answer the handshake once connected. */
const IDENTITY_TIMEOUT_MS = 1_400
/** Candidates probed at once. High enough to finish a /24 quickly, low enough
 *  that a phone's radio is not saturated and a corporate IDS sees a drizzle. */
const CONCURRENCY = 24

export interface DiscoverOptions {
  connectCode: string
  subnets: readonly DeviceSubnet[]
  port?: number
  signal?: { aborted: boolean }
  onProgress?: (scanned: number, total: number) => void
}

/**
 * Whether a candidate holds this pairing.
 *
 * This is the whole security property of the scan: the answer does not depend
 * on the address, the hostname or anything the peer claims, only on whether it
 * can produce the confirmation that the connect code derives.
 */
export async function identifiesAs(url: string, connectCode: string, timeoutMs = IDENTITY_TIMEOUT_MS): Promise<boolean> {
  const pair = await createKeyPair()
  const nonce = crypto.getRandomValues(new Uint8Array(16))
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (answer: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.close() } catch { /* already gone */ }
      resolve(answer)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch {
      clearTimeout(timer)
      resolve(false)
      return
    }
    socket.binaryType = 'arraybuffer'
    socket.onopen = () => {
      void (async () => {
        try {
          socket.send(JSON.stringify({ t: 'hi', epk: base64url(pair.publicKey), n: base64url(nonce) }))
        } catch { finish(false) }
      })()
    }
    socket.onmessage = (event) => {
      void (async () => {
        try {
          if (typeof event.data !== 'string') return finish(false)
          const hello = JSON.parse(event.data)
          if (hello?.t !== 'hi' || typeof hello.epk !== 'string' || typeof hello.n !== 'string' || typeof hello.cr !== 'string') return finish(false)
          const peer = fromBase64url(hello.epk)
          const peerNonce = fromBase64url(hello.n)
          if (peer.length !== 65 || peerNonce.length !== 16) return finish(false)
          const keys = await deriveSessionKeys({
            connectCode,
            myPrivateKey: pair.privateKey,
            peerPublic: peer,
            initiatorPublic: pair.publicKey,
            responderPublic: peer,
            initiatorNonce: nonce,
            responderNonce: peerNonce,
          })
          // Compared in constant time for the same reason the tunnel does:
          // this is the same secret, checked the same way.
          finish(constantTimeEqual(fromBase64url(hello.cr), keys.confirmResponder))
        } catch { finish(false) }
      })()
    }
    socket.onerror = () => finish(false)
    socket.onclose = () => finish(false)
  })
}

/**
 * Scans the phone's own subnets for the desktop this pairing belongs to.
 *
 * Returns the address of the desktop, or null. Every candidate is identified
 * by handshake, so a wrong answer is impossible to reach: a machine that does
 * not hold the code is simply not the desktop.
 */
export async function discoverDesktop(options: DiscoverOptions): Promise<LanAddress | null> {
  const port = options.port ?? DEFAULT_LAN_PORT
  const subnets = options.subnets.filter(scannableSubnet)
  if (!subnets.length || !options.connectCode) return null

  const targets: string[] = []
  for (const subnet of subnets.slice(0, 2)) targets.push(...probeTargets(subnet))
  if (!targets.length) return null

  let scanned = 0
  for (let index = 0; index < targets.length; index += CONCURRENCY) {
    if (options.signal?.aborted) return null
    const batch = targets.slice(index, index + CONCURRENCY)
    const results = await Promise.all(batch.map(async (host) => {
      if (options.signal?.aborted) return null
      const found = await identifiesAs(`ws://${host}:${port}/__alma_e2e__`, options.connectCode, CONNECT_TIMEOUT_MS + IDENTITY_TIMEOUT_MS)
      scanned++
      options.onProgress?.(scanned, targets.length)
      return found ? { host, port } : null
    }))
    const hit = results.find((result): result is LanAddress => result !== null)
    if (hit && isLanHost(hit.host)) return hit
    // Scanning is a background chore; yielding keeps the UI responsive.
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return null
}
