/**
 * Deciding when a connection needs proving.
 *
 * A WebSocket that is dead can still look alive: Android freezes the page
 * before the close event runs, and a Wi-Fi link can vanish without sending a
 * FIN. In both cases `readyState` stays `1` and writes disappear silently, so
 * the only evidence left is the absence of traffic.
 *
 * The policy here is deliberately lazy. Probing on a timer regardless of
 * traffic would wake the radio for nothing; most of the time a live session is
 * already streaming frames, which proves the link more cheaply than any ping.
 * A probe is only due when the tunnel has been quiet for longer than a healthy
 * one ever is.
 */

/**
 * Quiet for this long and the link is worth checking.
 *
 * Tuned against the alternative it replaces: a request deadline of 20 s. A
 * probe is only useful if the whole "quiet → probe → timeout" path is shorter
 * than that, otherwise the user waits longer than before and the change is
 * worse than doing nothing. Ten seconds of silence never happens on a healthy
 * tunnel (a session streams frames continuously), so this costs no extra
 * traffic, and the total detection time lands near thirteen seconds.
 */
export const IDLE_PROBE_MS = 8_000

/**
 * Deadline for the probe itself.
 *
 * Much shorter than a normal request: a healthy desktop answers `/api/herdr/info`
 * from memory in well under a second, on a local or relayed path alike, so
 * waiting the usual 20 s only delays telling the user the link is gone. Three
 * seconds still leaves room for a slow cellular round trip, and keeps the
 * total detection time under the deadline this replaces.
 */
export const PROBE_TIMEOUT_MS = 3_000

/**
 * How often the quiet check runs. Must be well under IDLE_PROBE_MS, or the
 * tick interval, not the threshold, decides how late a dead link is noticed.
 */
export const LIVENESS_TICK_MS = 3_000

export interface LivenessInput {
  /** The runtime believes it is online. */
  online: boolean
  /** `Date.now()` of the last inbound frame, 0 when the link was never used. */
  lastInboundAt: number
  /** A probe is already in flight; never stack them. */
  probeInFlight: boolean
  /** Now, in `Date.now()` terms. */
  now: number
  /**
   * The app is on screen. A hidden page cannot act on the answer and should
   * not spend radio time asking, so it waits for the return-to-foreground
   * check instead.
   */
  foreground: boolean
}

/**
 * Whether to send a liveness probe now.
 *
 * `lastInboundAt === 0` means nothing has arrived since the handshake — which
 * is normal for a freshly opened tunnel, so the clock starts at the connect
 * time rather than at zero (callers pass that value in as `lastInboundAt`).
 */
export function shouldProbe(input: LivenessInput): boolean {
  if (!input.online || input.probeInFlight || !input.foreground) return false
  if (!input.lastInboundAt) return false
  return input.now - input.lastInboundAt >= IDLE_PROBE_MS
}
