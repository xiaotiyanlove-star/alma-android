import type { AgentSettings, AppState, ChatItem, Host, Mutes, Pane, SessionState, Snapshot, TranscriptGap } from './model'
import { parsePairing } from './pairing'
import { t, tWith } from './i18n'
import { isOnLocalNetwork, lanUrl, usableLanAddress, type LanAddress } from './lan'
import { deviceSubnets } from './localnet'
import { directAllowed, recordDirect } from './breaker'
import { discoverDesktop, identifiesAs } from './discovery'
import { LAN_CANDIDATE_PATH, candidateKey, parseLanCandidate, usableCandidateHosts, type LanCandidate } from './candidates'
import { forgetAllRoutes, forgetRoute, lastRoute, rememberRoute } from './lastroute'
import { lanDiscoveryEnabled } from './lanprefs'
import { forgetSubnets } from './localnet'
import { clearAllBreakers } from './breaker'
import { MAX_RETRIES, isPermanentFailure, nextDelay, retriesLeft, sessionDelay, type RetryContext } from './backoff'
import { metrics } from './metrics'
import { imageRequestPath, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_MB, uploadRoute, type UploadResponse, type UploadedFile } from './attachments'
import { moveKeys, needsSpace, optionForIntent, parsePrompt, promptFingerprint, samePrompt, stripAnsi, type Prompt } from './prompt'

/** How often a desktop with no known local address is looked for. */
const DISCOVERY_INTERVAL_MS = 10 * 60_000
/**
 * How long to leave a desktop alone after it reported addresses and then did
 * not answer on any of them.
 *
 * Longer than the ordinary interval: that desktop is reachable over the relay
 * and will still be there in half an hour, while re-probing it every ten
 * minutes is a handshake per address for an answer that is not going to change
 * until the phone or the desktop moves.
 */
const DISCOVERY_MISS_MS = 30 * 60_000
/** Deadline for the foreground liveness read; a healthy desktop answers at once. */
const VERIFY_TIMEOUT_MS = 5_000
import { hostStorage, type HostStorage } from './storage'
import { EncryptedTunnel, OperationUncertainError, RejectedError, type BinaryResponse, type Transport, type TunnelError, type TunnelSocket } from './transport'

/**
 * One page of a transcript.
 *
 * `settings` is the model and effort the desktop read from the transcript
 * itself. It is the only authoritative source: the terminal prints a model name
 * only sometimes, and what it prints is what the agent chose to draw.
 */
type Page = {
  session_id?: string
  page?: { items?: ChatItem[]; start?: number; end?: number }
  queued?: { id: string; text: string }[]
  settings?: { model?: string | null; effort?: string | null }
  error?: { code?: string; message?: string }
}
const message = (error: unknown) => error instanceof Error ? error.message : t('请求失败')

/** Narrows the desktop's `settings`, which may be missing or partial. */
function readSettings(value: Page['settings']): AgentSettings | undefined {
  if (!value) return undefined
  const model = typeof value.model === 'string' && value.model ? value.model : null
  const effort = typeof value.effort === 'string' && value.effort ? value.effort : null
  return { model, effort }
}

/** True when the desktop's answer changes what the header shows. */
function settingsChanged(current: AgentSettings | undefined, next: AgentSettings | undefined): boolean {
  if (!next) return false
  return (current?.model ?? null) !== next.model || (current?.effort ?? null) !== next.effort
}

/**
 * The argv Herdr should start for a new session.
 *
 * A login shell resolves the agent through the user's own PATH (Homebrew and
 * version managers are usually configured in a login profile). The agent is
 * not `exec`ed: when it exits — or a binary is missing — the trailing
 * interactive login shell takes over, so the pane stays a usable terminal
 * instead of closing (Herdr removes a pane whose process exits).
 */
export function agentLaunchCommand(kind: string): string[] {
  const executable = /^[a-z][a-z0-9-]{0,31}$/.test(kind) ? kind : 'claude'
  return ['/bin/sh', '-lc', `${executable}; exec "\${SHELL:-/bin/sh}" -il`]
}

/**
 * Why a pane has no transcript, given the error Alma reported for it.
 *
 * The two codes say different things, which is the whole point of telling
 * them apart:
 *
 * - `no_agent_session` means Herdr has no session id for the pane — which is
 *   also what a plain shell reports, so the pane itself decides whether an
 *   agent is there. A missing id is normal for a moment after an agent starts,
 *   because its integration reports the id when the session begins. It is only
 *   the integration's fault once the agent has been given work — it is
 *   working, or finished, or blocked — and still no id ever arrived.
 * - `transcript_not_found` means the id exists but the transcript is not where
 *   Alma looks. That is not an install problem either: it is typically a CLI
 *   whose session lives elsewhere, such as one behind SSH or in a container.
 * - `unsupported_agent` means Alma has no reader for that agent at all, which
 *   is never something the user can install their way out of.
 */
export function transcriptGap(code: string, pane: Pane | undefined, sentMessage: boolean): TranscriptGap {
  if (code === 'unsupported_agent') return 'unsupported'
  if (code === 'transcript_not_found') return 'transcript'
  // Without a snapshot there is no way to tell a shell from an agent, so say
  // the harmless thing; the next refresh classifies it once the list arrives.
  if (!pane) return 'waiting'
  if (!pane.agent && !pane.agent_session?.agent) return 'terminal'
  const worked = sentMessage || ['working', 'done', 'blocked'].includes(pane.agent_status ?? '')
  return worked ? 'integration' : 'waiting'
}

/**
 * Whether a failure means "this desktop does not know the method" rather than
 * "the method ran and refused". Herdr reports the former as a request error
 * naming the method, and a desktop too old for it may not answer at all.
 */
function isUnknownMethod(error: unknown): boolean {
  // Alma refuses methods the phone may not call with 403 "… is not available
  // from the phone". That is the same situation as an older desktop not
  // knowing the method: another path has to be used instead.
  if (error instanceof RejectedError && error.status === 403) return true
  const text = error instanceof Error ? error.message : String(error)
  return /unknown variant|unknown method|unsupported|not_implemented|invalid_request|not available from the phone/i.test(text)
}

/**
 * Starting an agent is not a read: Herdr launches a process and waits for it
 * to become interactive before answering. A cold start on a loaded machine
 * outlives the read deadline, and the user then sees "may have run" for a
 * create that actually succeeded.
 */
const CREATE_TIMEOUT_MS = 75_000

function merge(current: ChatItem[], incoming: ChatItem[], prepend = false): ChatItem[] {
  const all = new Map(current.map((item) => [item.id, item]))
  for (const item of incoming) all.set(item.id, item)
  const order = prepend ? [...incoming, ...current] : [...current, ...incoming]
  return [...new Set(order.map((item) => item.id))].map((id) => all.get(id)!)
}
interface Runtime {
  transport: Transport
  epoch: number
  hub?: TunnelSocket
  retry?: ReturnType<typeof setTimeout>
  attempts: number
  stopped?: 'exhausted' | 'auth' | 'unknown-host'
  /** Stops the idle probe when this runtime is replaced or closed. */
  stopHeartbeat?: () => void
}
export class Controller {
  private state: AppState = { hosts: [], loading: true, foreground: true }
  private listeners = new Set<() => void>()
  private runtimes = new Map<string, Runtime>()
  private sessionEpoch = 0
  /** Bumped whenever the transcript identity changes, so stale history pages cannot merge. */
  private sessionIdentity = 0
  private sessionSockets: TunnelSocket[] = []
  private sessionTimers = new Set<ReturnType<typeof setTimeout>>()
  private initialized?: Promise<void>
  private openingHost = false
  private initializedStorage = false
  private sessionRefresh?: Promise<void>
  /** Consecutive failed session loads, which pace the refresh retries. */
  private sessionFailures = 0
  constructor(private storage: HostStorage = hostStorage, private createTransport = (host: Host, status: (state: 'connecting' | 'online' | 'offline', error?: string, code?: TunnelError['code']) => void): Transport => new EncryptedTunnel(host, status)) {}
  getState = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(patch: Partial<AppState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener() }
  private patchHost(id: string, patch: Partial<AppState['hosts'][number]>) { this.publish({ hosts: this.state.hosts.map((item) => item.host.id === id ? { ...item, ...patch } : item) }) }
  private patchSession(epoch: number, patch: Partial<SessionState>) { if (epoch === this.sessionEpoch && this.state.session) this.publish({ session: { ...this.state.session, ...patch } }) }
  initialize = () => this.initialized ??= this.load()
  private async load() {
    try {
      const hosts = await this.storage.load()
      const remembered = this.storage.loadSelection ? await this.storage.loadSelection() : null
      this.initializedStorage = true
      // Reopen the desktop the user was last on; fall back to a single pairing
      // rather than silently picking the first of several.
      const selected = remembered && hosts.some((host) => host.id === remembered)
        ? remembered
        : hosts.length === 1 ? hosts[0].id : undefined
      // A desktop the user switched off is reported as such, and never dialled:
      // the point of the switch is not spending a connection on it.
      this.publish({
        hosts: hosts.map((host) => ({ host, status: host.enabled === false ? 'disabled' as const : 'offline' as const, herdrOnline: false })),
        loading: false,
        selectedHostId: selected,
        storageWarning: this.storage.persistent ? undefined : t('浏览器预览仅在内存中保存节点；关闭页面后需要重新配对。'),
      })
      for (const host of hosts) if (host.enabled !== false) this.attach(host)
    } catch { this.publish({ loading: false, error: t('无法读取安全存储，未覆盖已有节点。请重新打开应用。') }) }
  }
  /** Builds a runtime with a fresh transport; a closed transport never reopens. */
  private makeRuntime(host: Host): Runtime {
    const runtime: Runtime = { transport: undefined as unknown as Transport, epoch: 0, attempts: 0 }
    runtime.transport = this.createTransport(host, (status, error, code) => {
      if (this.runtimes.get(host.id) !== runtime) return
      if (status === 'offline') {
        // The transport calls this synchronously when its idle probe gives up.
        // The last inbound frame is the last point the UI knows the tunnel was
        // carrying traffic, so the gap to this callback is the observed stale
        // detection time. Ordinary successful writes are deliberately not
        // counted as outages.
        const last = runtime.transport.lastInboundAt()
        if (last) metrics.record({ staleDetectMs: Math.max(0, Date.now() - last) })
      }
      this.patchHost(host.id, { status, ...(status === 'online' ? {} : { herdrOnline: false }), error })
      if (status === 'offline') this.scheduleHost(host.id, runtime, code)
    })
    // Score the direct path so a dead address stops costing its two-second
    // wait, and surface which path a connection actually took.
    const scored = runtime.transport as Transport & {
      onRoute?: (route: 'direct' | 'relay') => void
      onDirectFailed?: () => void
    }
    scored.onRoute = (route) => {
      if (this.runtimes.get(host.id) !== runtime) return
      if (route === 'direct') {
        recordDirect(host.id, true)
        // It answered, so it is worth trying first next time. Only a direct
        // route is remembered: the relay address is already in the pairing.
        const used = this.state.hosts.find((item) => item.host.id === host.id)?.discoveredLan
        if (used) rememberRoute(host.id, used)
      }
      this.patchHost(host.id, { route })
    }
    scored.onDirectFailed = () => {
      if (this.runtimes.get(host.id) !== runtime) return
      recordDirect(host.id, false)
      // A discovered address that has stopped answering is not worth keeping:
      // left in place it is skipped by `maybeDiscover` forever, so the app
      // would keep dialling a dead address (and paying the breaker cooldown)
      // until the phone changes networks. A user-entered address is a setting
      // and is kept; only observation is discarded.
      if (this.discoveredLanFor(host.id)) this.patchHost(host.id, { discoveredLan: undefined })
      // The remembered address is the one that just failed, so it must not be
      // tried again on the next launch either.
      forgetRoute(host.id)
    }
    // The local address is an observation, never a setting: it is found by
    // asking the desktop or by scanning, and never written into the stored
    // host. The transport still falls back to the relay whenever it does not
    // answer. A launch starts from the address that answered last time, so the
    // common case does not pay for discovery at all.
    this.applyLan(runtime, host.id, this.discoveredLanFor(host.id) ?? lastRoute(host.id))
    return runtime
  }

  /** The address a scan found earlier, if it is still remembered. */
  private discoveredLanFor(id: string): LanAddress | undefined {
    return this.state.hosts.find((item) => item.host.id === id)?.discoveredLan
  }

  /**
   * Hands a discovered local address to a transport, when it supports one.
   *
   * The gate travels with it: plain text is only dialled once the platform
   * confirms the address shares a subnet with this phone. A transport that
   * cannot ask the platform keeps its own default, which is to refuse.
   */
  private applyLan(runtime: Runtime, hostId: string, lan: LanAddress | undefined) {
    const transport = runtime.transport as Transport & {
      useDirect?(address: LanAddress | undefined, allow?: (address: LanAddress) => Promise<boolean>): void
    }
    transport.useDirect?.(lan, async (address) => {
      if (!usableLanAddress(address) || !lanDiscoveryEnabled()) return false
      // A path that keeps failing is not offered the two-second wait again
      // until the cooldown lapses or the network changes.
      if (!directAllowed(hostId)) return false
      const subnets = await deviceSubnets()
      return isOnLocalNetwork(address.host, subnets)
    })
  }

  /** Drops addresses discovered on a previous network, preserving user input. */
  clearDiscoveredLan = () => {
    const hosts = this.state.hosts.map((item) => {
      if (!item.discoveredLan) return item
      const { discoveredLan: _discarded, ...remaining } = item
      return remaining
    })
    this.publish({ hosts })
  }

  /** Applies the user's discovery switch to already-open tunnels. */
  lanDiscoveryChanged = (enabled: boolean) => {
    this.discoveryEpoch++
    this.abortScans()
    this.lastDiscover.clear()
    this.lastMiss.clear()
    if (!enabled) this.clearDiscoveredLan()
    // Snapshot first: `rebuild` deletes and re-inserts the same key, and a Map
    // re-visits a key deleted and re-added during iteration — the loop would
    // never drain and would dial without bound. See `networkChanged`.
    for (const [id, runtime] of [...this.runtimes]) {
      const host = this.state.hosts.find((item) => item.host.id === id)
      if (!host || host.host.enabled === false) continue
      this.rebuild(id, runtime)
      if (enabled) this.maybeDiscover(id)
    }
  }

  /**
   * Rebinds every enabled node to the new network.
   *
   * `window.online` only reports offline → online; a Wi-Fi/cellular handover
   * stays "online" while every existing socket belongs to the old route.
   * Rebuild rather than retrying stopped runtimes, because a healthy-looking
   * old WebSocket is exactly what the event tells us is stale. Any scan that
   * was in progress belongs to the old subnet and is discarded.
   */
  networkChanged = () => {
    this.discoveryEpoch++
    this.abortScans()
    this.lastDiscover.clear()
    this.lastMiss.clear()
    this.clearDiscoveredLan()
    forgetAllRoutes(this.state.hosts.map((item) => item.host.id))
    forgetSubnets()
    clearAllBreakers()
    // Snapshot first: `rebuild` deletes and re-inserts the same key while this
    // loop runs, and JavaScript re-visits such a key at the end of the map.
    // Iterating the live map therefore never terminates: the UI thread hangs
    // and a new transport is dialled on every pass. A handover is exactly the
    // event that runs this.
    for (const [id, runtime] of [...this.runtimes]) {
      const host = this.state.hosts.find((item) => item.host.id === id)
      if (!host || host.host.enabled === false) continue
      this.rebuild(id, runtime)
    }
  }

  /**
   * Releases one runtime: probe, hub, retry timer and transport.
   *
   * Kept in one place because every teardown path (suspend, disable, forget,
   * rebuild, dispose) has to do the same four things, and a missed probe keeps
   * a timer alive against a socket that no longer exists.
   */
  private closeRuntime(runtime: Runtime) {
    runtime.stopHeartbeat?.()
    runtime.stopHeartbeat = undefined
    clearTimeout(runtime.retry)
    runtime.hub?.close()
    runtime.transport.close()
  }

  private attach(host: Host) {
    const runtime = this.makeRuntime(host)
    this.runtimes.set(host.id, runtime)
    void this.connectHost(host.id, runtime)
    // Discovery does not depend on the relay. If the public path is the broken
    // one and the phone is at home, this is what lets the app find the desktop
    // without waiting for a relay connection that will never complete.
    this.maybeDiscover(host.id)
  }
  /**
   * Bounded retry: three attempts, at most 30 s apart, then stop. Automatic
   * retrying only resumes when the app is foregrounded, the network returns,
   * or the user asks — nothing else resets the ladder.
   */
  private scheduleHost(id: string, runtime: Runtime, code?: TunnelError['code']) {
    if (runtime.retry || this.runtimes.get(id) !== runtime) return
    const permanent = isPermanentFailure(code)
    // The patient stage only runs while the app is on screen: a phone in a
    // pocket must not keep waking its radio. `retryStopped` picks it back up
    // when the user returns, and the network-change listener when a link
    // comes back.
    const delay = permanent ? null : nextDelay(runtime.attempts, this.retryContext())
    if (delay === null) {
      // Not permanent but paused: keep the host recoverable without a tap.
      runtime.stopped = permanent ?? 'exhausted'
      this.patchHost(id, { retriesLeft: retriesLeft(runtime.attempts), stopReason: runtime.stopped })
      return
    }
    runtime.attempts++
    metrics.countRetry()
    this.patchHost(id, { retriesLeft: retriesLeft(runtime.attempts) })
    runtime.retry = setTimeout(() => {
      runtime.retry = undefined
      if (this.runtimes.get(id) !== runtime) return
      void this.connectHost(id, runtime)
    }, delay)
  }

  /** Whether the app is on screen right now. */
  private retryContext(): RetryContext {
    return { foreground: this.state.foreground ?? true }
  }

  /**
   * Marks the app as visible or hidden.
   *
   * Retry pacing depends on it: the patient stage exists so a user staring at
   * a red banner gets recovery, and disappears when nobody is looking.
   */
  setForeground = (foreground?: boolean) => {
    if (foreground === undefined) return
    if (this.state.foreground === foreground) return
    this.publish({ foreground })
    if (foreground) this.retryStopped()
    // The idle probe costs a round trip every few seconds. It only exists to
    // catch a link that died while the user is looking at the app; a hidden
    // phone should not keep waking its radio to ask.
    if (foreground) {
      for (const runtime of this.runtimes.values()) {
        const transport = runtime.transport as Partial<{ startHeartbeat(): () => void }>
        if (typeof transport.startHeartbeat !== 'function') continue
        runtime.stopHeartbeat?.()
        runtime.stopHeartbeat = transport.startHeartbeat()
      }
      return
    }
    for (const runtime of this.runtimes.values()) {
      runtime.stopHeartbeat?.()
      runtime.stopHeartbeat = undefined
    }
  }

  /**
   * Looks for this desktop on the local network, in the background.
   *
   * Only when it is worth the radio time: the app is on screen, there is no
   * cached answer, and the last look was a while ago. It does not depend on the
   * relay — a dead public route is exactly when the local path matters most.
   * A phone on cellular has no Wi-Fi/Ethernet subnets from the native plugin,
   * so nothing is scanned there.
   */
  private discovering = new Set<string>()
  /** Scans still running, so a network change can stop them early. */
  private scans = new Set<{ aborted: boolean }>()
  private discoveryEpoch = 0
  private lastDiscover = new Map<string, number>()
  /** Why the last search for this desktop failed, which sets the next wait. */
  private lastMiss = new Map<string, 'unreachable' | 'none'>()
  /**
   * Asks a desktop where it can be reached, over its own tunnel.
   *
   * One round trip instead of a subnet scan, and the answer comes from the
   * machine itself, so it is right even when the phone's idea of its subnets is
   * wrong (a VPN, a second interface, a bridged VM). A desktop that does not
   * serve the route answers 404, which the transport turns into a rejection —
   * a normal outcome, not an error, and the caller falls back to scanning.
   */
  private async candidateAddresses(id: string): Promise<LanAddress[]> {
    const runtime = this.runtimes.get(id)
    if (!runtime) return []
    // Only ask a desktop that is already reachable. `request` dials on demand,
    // so asking an offline one would spend the full request deadline inside a
    // search — and the case this search exists for is precisely the one where
    // the relay is the broken path. An offline desktop is found by scanning.
    const state = this.state.hosts.find((item) => item.host.id === id)
    if (state?.status !== 'online' || state.herdrOnline !== true) return []
    let answer: unknown
    try {
      answer = await runtime.transport.request<unknown>(LAN_CANDIDATE_PATH, undefined, { kind: 'read', timeoutMs: 5_000 })
    } catch { return [] }
    const candidate: LanCandidate | null = parseLanCandidate(answer)
    if (!candidate || this.runtimes.get(id) !== runtime) return []
    return usableCandidateHosts(candidate).map((host) => ({ host, port: candidate.port }))
  }

  /**
   * Whether an address already belongs to a different paired desktop.
   *
   * Two Alma desktops on one network is the normal case in an office, and the
   * scan cannot tell them apart by address — it can only ask each one to prove
   * it holds the pairing code. What it must never do is hand the same address
   * to two desktops: whichever pairing is checked second would fail, and the
   * two would keep overwriting each other's route. An address claimed by one
   * desktop is therefore not offered to any other.
   */
  private claimedBy(host: string, port: number, exceptId: string): boolean {
    const key = candidateKey(host, port)
    return this.state.hosts.some((item) => item.host.id !== exceptId
      && Boolean(item.discoveredLan)
      && candidateKey(item.discoveredLan!.host, item.discoveredLan!.port) === key)
  }

  /**
   * Picks the address this desktop actually answers on.
   *
   * Every candidate goes through the same check a scanned one does: it must sit
   * on a subnet this phone is attached to, it must not already belong to
   * another paired desktop, and it must complete a handshake with *this*
   * pairing's code. The first that does is the answer; the rest are not worth
   * the radio time.
   *
   * Racing them would be faster but would not be correct here: two desktops can
   * answer on the same subnet, so "the first to reply" is not necessarily "the
   * one this pairing belongs to".
   */
  private async identifyCandidate(id: string, connectCode: string, addresses: readonly LanAddress[], subnets: Awaited<ReturnType<typeof deviceSubnets>>, scan: { aborted: boolean }, epoch: number): Promise<LanAddress | null> {
    for (const address of addresses) {
      if (scan.aborted || this.discoveryEpoch !== epoch) return null
      if (!usableLanAddress(address)) continue
      // The phone must be on the same network — the rule that makes plain text
      // acceptable at all — and no other desktop may already own this address.
      if (!isOnLocalNetwork(address.host, subnets)) continue
      if (this.claimedBy(address.host, address.port, id)) continue
      if (await identifiesAs(lanUrl(address, '/__alma_e2e__'), connectCode)) return address
    }
    return null
  }

  private maybeDiscover(id: string) {
    // Discovery does not wait for a relay connection: if the public path is
    // broken, the LAN path is precisely how this phone can still reach home.
    // It remains background work and only runs while the app is visible.
    if (!lanDiscoveryEnabled()) return
    if (!this.state.foreground) return
    if (this.discovering.has(id)) return
    const hostState = this.state.hosts.find((item) => item.host.id === id)
    const host = hostState?.host
    if (!host || host.enabled === false) return

    // Once an address is known, the breaker decides whether to dial it. Do not
    // rescan the same subnet just because that address is in its cooldown —
    // the cooldown exists precisely to stop spending time on this path. A
    // network change clears the discovered address and the breaker before the
    // next scan.
    if (hostState?.discoveredLan) return
    const at = this.lastDiscover.get(id) ?? 0
    const now = Date.now()
    // A desktop that answered with a candidate list but did not answer on any
    // address is out of reach for a reason — asleep, on a different VLAN — and
    // retrying a minute later only spends radio on the same answer. A desktop
    // that reported nothing gets the ordinary interval: it may simply have been
    // started with its listener off and be switched on shortly.
    const wait = this.lastMiss.get(id) === 'unreachable' ? DISCOVERY_MISS_MS : DISCOVERY_INTERVAL_MS
    if (now - at < wait) return
    this.lastDiscover.set(id, now)
    this.discovering.add(id)
    const startedAt = this.discoveryEpoch
    // Signalled when the network changes, so a scan of the old subnet stops
    // probing instead of running all 254 addresses to no purpose. The epoch
    // alone cannot do that: it only discards the answer after the fact.
    const scan = { aborted: false }
    this.scans.add(scan)
    void (async () => {
      try {
        const subnets = await deviceSubnets()
        // The desktop's own answer first: one round trip, and it is right even
        // when this phone's idea of its subnets is wrong. Only when it has
        // nothing to say — an older build, or a listener that is off — is the
        // subnet scanned, because that costs a /24 of handshakes.
        const candidates = await this.candidateAddresses(id)
        const found = candidates.length
          ? await this.identifyCandidate(id, host.connectCode, candidates, subnets, scan, startedAt)
          : await discoverDesktop({ connectCode: host.connectCode, subnets, signal: scan })
        if (!found && !scan.aborted && startedAt === this.discoveryEpoch) {
          this.lastMiss.set(id, candidates.length ? 'unreachable' : 'none')
        }
        // A network switch during the search invalidates both its subnet and
        // any answer found there. Do not cache an address from the link we left.
        if (found && startedAt === this.discoveryEpoch && this.state.foreground && lanDiscoveryEnabled()) {
          this.lastMiss.delete(id)
          await this.adoptLan(id, found)
        }
      } catch { /* discovery is best effort; the relay still works */ }
      finally {
        this.scans.delete(scan)
        this.discovering.delete(id)
      }
    })()
  }

  /** Stops every scan in flight; the caller has already bumped the epoch. */
  private abortScans() {
    for (const scan of this.scans) scan.aborted = true
    this.scans.clear()
    this.discovering.clear()
  }

  /** Remembers a discovered address and lets the next connection use it. */
  private async adoptLan(id: string, address: LanAddress) {
    // The desktop may have been forgotten or switched off while the scan ran;
    // writing the address onto it afterwards would leave state that nothing
    // reads and nothing clears.
    const host = this.state.hosts.find((item) => item.host.id === id)
    if (!host || host.host.enabled === false) return
    // Two desktops on one network search at the same time, and both finish by
    // writing an address. The check here is the last word: whichever adopts
    // second sees the first one's claim and gives the address up rather than
    // routing two pairings at one listener. It is re-read from the state, not
    // remembered, so it cannot go stale between the search and this call.
    if (this.claimedBy(address.host, address.port, id)) {
      this.lastMiss.set(id, 'unreachable')
      return
    }
    // Cached, but not persisted as a user setting: it was found, not chosen.
    // Store it before rebuilding so the new runtime receives it immediately;
    // this switches an existing relay connection to LAN as soon as discovery
    // succeeds, rather than making the user wait for the next reconnect.
    this.patchHost(id, { discoveredLan: address })
    const runtime = this.runtimes.get(id)
    if (runtime) this.rebuild(id, runtime)
  }

  /** Clears any pending retry so a manual reconnect happens immediately. */
  private cancelRetry(runtime: Runtime) {
    if (!runtime.retry) return
    clearTimeout(runtime.retry)
    runtime.retry = undefined
  }
  /**
   * Why Herdr is not answering, in the desktop's own words.
   *
   * `online: false` alone cannot tell "Herdr was never started" from "the
   * socket is there but the desktop's own client is not connected". The
   * desktop sends `offline_reason` for that; showing it turns an opaque
   * "offline" badge into something the user can act on.
   */
  private herdrOffline(info: { online?: boolean; offline_reason?: unknown; herdr_error?: unknown }): string | undefined {
    if (info.online === true) return undefined
    for (const value of [info.offline_reason, info.herdr_error]) {
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return t('Alma 已连接，但 Herdr 未运行或不可用')
  }

  private async connectHost(id: string, runtime: Runtime) {
    const epoch = ++runtime.epoch
    runtime.hub?.close()
    try {
      await runtime.transport.connect()
      const info = await runtime.transport.request<{ online: boolean; offline_reason?: string; herdr_error?: string }>('/api/herdr/info')
      if (this.runtimes.get(id) !== runtime || epoch !== runtime.epoch) return
      this.patchHost(id, {
        status: 'online',
        herdrOnline: info.online === true,
        error: this.herdrOffline(info),
        offlineReason: info.online === true ? undefined : (typeof info.offline_reason === 'string' ? info.offline_reason : undefined),
      })
      runtime.hub = runtime.transport.subscribe('/ws/herdr', (event) => {
        if (epoch !== runtime.epoch || this.runtimes.get(id) !== runtime) return
        if (event.type === 'snapshot' && Array.isArray(event.snapshot?.panes) && Array.isArray(event.snapshot?.workspaces)) this.patchHost(id, { snapshot: event.snapshot as Snapshot, herdrOnline: true, error: undefined, offlineReason: undefined })
        if (event.type === 'herdr') {
          const reason = typeof event.reason === 'string' && event.reason.trim() ? event.reason.trim() : undefined
          this.patchHost(id, {
            herdrOnline: event.online === true,
            error: event.online === true ? undefined : (reason || t('Herdr 暂时不可用')),
            offlineReason: event.online === true ? undefined : reason,
          })
        }
        if (event.type === 'status' && event.change) {
          const current = this.state.hosts.find((item) => item.host.id === id)?.snapshot
          if (current) this.patchHost(id, { snapshot: { ...current, panes: current.panes.map((pane) => pane.pane_id === event.change.pane_id ? { ...pane, agent_status: event.change.to } : pane) } })
        }
      }, () => { if (epoch === runtime.epoch) this.scheduleHost(id, runtime) })
      runtime.attempts = 0
      runtime.stopped = undefined
      this.patchHost(id, { retriesLeft: MAX_RETRIES, stopReason: undefined })
      // A tunnel that dies without delivering `close` — the page was frozen
      // when the relay dropped it — would otherwise look healthy until the
      // next request timed out. The probe turns that into a real reconnect.
      runtime.stopHeartbeat?.()
      // Only while the app is on screen: the probe is a round trip every few
      // seconds, and a hidden page has nobody to show the result to.
      const transport = runtime.transport as Partial<{ startHeartbeat(): () => void }>
      runtime.stopHeartbeat = this.state.foreground !== false && typeof transport.startHeartbeat === 'function'
        ? transport.startHeartbeat()
        : undefined
      // Muting is stored on the desktop, so it has to be read back rather than
      // assumed; a failure here must not make the desktop look offline.
      void this.refreshMutes(id).catch(() => undefined)
      if (this.state.session?.hostId === id) void this.refreshSession()
      // The relay is up and working; that is the moment to look for the same
      // desktop on the local network, so the next connection can skip it.
      this.maybeDiscover(id)
    } catch (error) {
      if (this.runtimes.get(id) !== runtime || epoch !== runtime.epoch) return
      this.patchHost(id, { status: 'error', herdrOnline: false, error: message(error) })
      this.scheduleHost(id, runtime)
    }
  }
  private storageQueue: Promise<unknown> = Promise.resolve()
  /** Serialize pairing writes so two concurrent removes cannot resurrect a host. */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.storageQueue.then(task, task)
    this.storageQueue = next.catch(() => undefined)
    return next
  }
  addHost = async (name: string, link: string) => {
    if (!this.initializedStorage) throw new Error(t('安全存储尚未就绪，未覆盖已有节点'))
    if (this.openingHost) throw new Error(t('正在保存节点'))
    this.openingHost = true
    try { await this.serialize(async () => this.addHostNow(name, link)) } finally { this.openingHost = false }
  }
  private async addHostNow(name: string, link: string) {
    const host = await parsePairing(name, link)
    const old = this.state.hosts.find((item) => item.host.id === host.id)?.host
    if (old) {
      host.addedAt = old.addedAt
      // Pairing again updates the credential, not the user's switch. Keeping
      // it off also keeps the code path below from dialling a disabled desktop.
      if (old.enabled === false) host.enabled = false
    }
    const hosts = [...this.state.hosts.filter((item) => item.host.id !== host.id).map((item) => item.host), host]
    await this.storage.save(hosts)
    const previous = this.runtimes.get(host.id)
    this.runtimes.delete(host.id)
    if (previous) this.closeRuntime(previous)
    // Always close the open session: the selected host changes, so an old pane must not stay as the mutation target.
    if (this.state.session) this.stopSession()
    this.publish({
      hosts: hosts.map((item) => item.id === host.id ? { host, status: host.enabled === false ? 'disabled' as const : 'offline' as const, herdrOnline: false } : this.state.hosts.find((state) => state.host.id === item.id)!),
      selectedHostId: host.id, selectedPaneId: undefined, session: undefined, error: undefined,
    })
    if (host.enabled !== false) this.attach(host)
  }
  /**
   * Uploads one file to the desktop and returns its absolute path.
   * The desktop stores it under a content-hash name, so the returned path is
   * authoritative rather than the name the user picked.
   */
  uploadAttachment = async (hostId: string, file: { name: string; type: string; bytes: Uint8Array }): Promise<UploadedFile> => {
    const runtime = this.runtimes.get(hostId)
    if (!runtime) throw new Error(t('节点不存在'))
    if (!file.bytes.length) throw new Error(t('文件内容为空'))
    if (file.bytes.length > MAX_ATTACHMENT_BYTES) throw new Error(tWith('文件超过 {size} MB', { size: MAX_ATTACHMENT_MB }))
    const route = uploadRoute(file.type)
    const response = await runtime.transport.request<UploadResponse>(route, undefined, {
      kind: 'mutation',
      raw: file.bytes,
      headers: {
        'content-type': file.type || 'application/octet-stream',
        'x-alma-filename': encodeURIComponent(file.name),
      },
    })
    if (!response?.filePath) throw new Error(response?.error || t('上传失败'))
    return {
      path: response.filePath,
      name: response.filename || file.name,
      size: response.size ?? file.bytes.length,
      renamed: Boolean(response.filename && response.filename !== file.name),
    }
  }

  /**
   * Creates a session.
   *
   * Two ways in, and the order between them is deliberate.
   *
   * `tab.create` + `agent.start` is the path Alma's phone bridge actually
   * offers: its `/api/herdr/rpc` allowlist names both, and neither is refused.
   * `agent.start` types `cd …` and then the agent name into the shell, so the
   * tab ends up with the agent's own argv in the foreground and a shell behind
   * it — which is also what a desktop user gets from the Herdr UI.
   *
   * `layout.apply` would be better still, because it starts the process with
   * its argv directly and so avoids a shell whose rc files may still be
   * printing a prompt (the swallowed first letter: `laude` instead of
   * `claude`). It is not on that allowlist, so a stock desktop answers 403.
   * It is therefore tried only after the allowlisted path has actually failed
   * — not before it, which would spend a refused round trip on every create.
   */
  newSession = async (hostId: string, options: { kind: string; cwd?: string; workspaceId?: string; label?: string }): Promise<{ paneId: string; workspaceId: string }> => {
    if (!this.runtimes.has(hostId)) throw new Error(t('节点不存在'))
    try {
      return await this.tabNewSession(hostId, options)
    } catch (error) {
      // `layout.apply` is the fallback for a desktop whose bridge refuses
      // `agent.start` — the inverse of the older build this used to target.
      if (!isUnknownMethod(error)) throw error
      return this.layoutNewSession(hostId, options)
    }
  }

  /**
   * The allowlisted path: a tab, then the agent typed into it the way the
   * desktop's own UI does it. The tab is created in the target directory, so
   * the `cd` is a no-op there in the common case and a correction otherwise.
   */
  private async tabNewSession(hostId: string, options: { kind: string; cwd?: string; workspaceId?: string; label?: string }) {
    const created = await this.rpc<{ tab?: { tab_id?: string; workspace_id?: string }; root_pane?: { pane_id?: string; workspace_id?: string } }>(
      hostId, 'tab.create', { ...(options.workspaceId ? { workspace_id: options.workspaceId } : {}), ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.label ? { label: options.label } : {}), focus: false }, CREATE_TIMEOUT_MS,
    )
    const paneId = created?.root_pane?.pane_id
    const tabId = created?.tab?.tab_id
    const workspaceId = created?.root_pane?.workspace_id ?? created?.tab?.workspace_id ?? options.workspaceId ?? ''
    if (!paneId) return this.layoutNewSession(hostId, { ...options, tabId })

    let lastError: unknown
    let retriedSwallowedLetter = false
    let swallowedLetterTwice = false
    // A freshly created shell is not instantly able to accept input: it has to
    // fork, read its rc files and reach a prompt. `agent.start` reports that
    // window as "not an available shell", so it is retried rather than
    // surfaced.
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        // No `cwd` here: `agent.start` reads only `kind`, `args`, `name` and
        // `timeout_ms` and types the command into the pane's shell, which
        // started in the directory `tab.create` was given. Passing a directory
        // it does not read would only suggest the agent starts somewhere else.
        await this.rpc<{ session_id?: string }>(hostId, 'agent.start', {
          name: `${options.kind}-${Math.random().toString(16).slice(2, 8)}`,
          kind: options.kind,
          pane_id: paneId,
          timeout_ms: 60_000,
        }, CREATE_TIMEOUT_MS)
        // `agent.start` can answer 200 after typing the command even when a
        // shell rc prompt (oh-my-zsh's update question, for example) consumed
        // its first character. That was the original `claude` -> `laude` bug.
        // The return value alone is therefore not proof the process started:
        // inspect the visible terminal for the exact command-not-found that
        // this failure produces, then retry once the rc prompt has completed.
        if (!retriedSwallowedLetter && await this.commandWasLostToShell(hostId, paneId, options.kind)) {
          retriedSwallowedLetter = true
          lastError = new Error(t('终端启动提示吞掉了命令首字母，正在重试'))
          await new Promise((resolve) => setTimeout(resolve, 400))
          continue
        }
        if (retriedSwallowedLetter && await this.commandWasLostToShell(hostId, paneId, options.kind)) {
          swallowedLetterTwice = true
          throw new Error(t('终端启动提示重复吞掉了命令首字母'))
        }
        this.rememberTabAddress(hostId, paneId, tabId)
        return { paneId, workspaceId }
      } catch (error) {
        lastError = error
        if (!/not an available shell/i.test(String(error))) break
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
    }
    // If the shell twice proves it ate the command, don't make a second tab
    // as a fallback: the first one still exists and the user needs the failure
    // surfaced, not another process in another pane.
    if (swallowedLetterTwice) throw lastError instanceof Error ? lastError : new Error(t('无法创建会话'))
    // The tab exists; only the agent did not start. Trying the other path in
    // that same tab is better than reporting a create that half-worked.
    try { return await this.layoutNewSession(hostId, { ...options, paneId, tabId }) } catch { /* report the agent failure */ }
    throw lastError instanceof Error ? lastError : new Error(t('无法创建会话'))
  }

  /**
   * A cache of "which tab does this pane belong to" for the panes this app
   * created, read by `paneOfTab`.
   *
   * `layout.apply` reports the tab it made but not, sometimes, the pane, and
   * `tab.get` does not exist on every desktop. The snapshot can answer, but
   * only after the desktop publishes another one — which on an idle desktop
   * can be a long time. The pane this client just created is known locally, so
   * the fallback is almost never needed.
   */
  private tabAddress = new Map<string, string>()

  private rememberTabAddress(hostId: string, paneId: string, tabId?: string) {
    if (!tabId) return
    this.tabAddress.set(`${hostId}:${paneId}`, tabId)
    // Bounded: these are only ever looked up for the pane being created, and a
    // long-running session must not accumulate one entry per pane forever.
    if (this.tabAddress.size > 200) {
      const oldest = this.tabAddress.keys().next().value
      if (oldest !== undefined) this.tabAddress.delete(oldest)
    }
  }

  /**
   * Detects the specific failure where an rc prompt consumes the first key
   * typed by `agent.start`. The call can return 200 in that case, so its
   * acknowledgement is not enough; the terminal has to confirm it did not run
   * the truncated command. Restrict the check to the shell's explicit
   * "command not found" response, so normal agent output cannot trigger a
   * duplicate launch.
   */
  private async commandWasLostToShell(hostId: string, paneId: string, kind: string): Promise<boolean> {
    if (kind.length < 2) return false
    try {
      const result = await this.rpc<{ read?: { text?: string } }>(hostId, 'pane.read', {
        pane_id: paneId, source: 'visible', format: 'text',
      })
      const screen = result.read?.text ?? ''
      // zsh: command not found: laude
      // bash: laude: command not found
      const lost = kind.slice(1)
      return screen.includes(`command not found: ${lost}`) || screen.includes(`${lost}: command not found`)
    } catch { return false }
  }

  /**
   * Starts the agent with its own argv in a tab's root pane.
   *
   * Nothing is typed into a shell, so a prompt written by an rc file cannot
   * swallow the first character of the command. `paneId` reuses a tab that
   * `tab.create` already made.
   */
  private async layoutNewSession(hostId: string, options: { kind: string; cwd?: string; workspaceId?: string; label?: string; paneId?: string; tabId?: string }) {
    const command = agentLaunchCommand(options.kind)
    const created = await this.rpc<{
      type?: string; tab_id?: string; workspace_id?: string; focused_pane_id?: string
      layout?: { tab_id?: string; workspace_id?: string; focused_pane_id?: string; root?: unknown }
    }>(hostId, 'layout.apply', {
      ...(options.tabId ? { tab_id: options.tabId } : {}),
      ...(options.workspaceId ? { workspace_id: options.workspaceId } : {}),
      ...(options.label ? { tab_label: options.label } : {}),
      focus: false,
      root: { type: 'pane', ...(options.cwd ? { cwd: options.cwd } : {}), command },
    }, CREATE_TIMEOUT_MS)
    const paneId = created?.focused_pane_id ?? created?.layout?.focused_pane_id ?? options.paneId
    const workspaceId = created?.workspace_id ?? created?.layout?.workspace_id ?? options.workspaceId ?? ''
    const tabId = created?.tab_id ?? created?.layout?.tab_id
    if (paneId) this.rememberTabAddress(hostId, paneId, tabId)
    if (!paneId) {
      const found = await this.paneOfTab(hostId, tabId)
      if (!found) throw new Error(t('无法创建会话'))
      return { paneId: found, workspaceId }
    }
    return { paneId, workspaceId }
  }

  /**
   * Alerts the desktop is not sending because the user silenced them.
   *
   * The list belongs to the desktop (`/api/herdr/mutes`), so muting a session
   * here also mutes it there and on every other device — muting is a statement
   * about the work, not about this phone. The local notification diff reads the
   * same list, so the two agree without a second source of truth.
   */
  refreshMutes = async (hostId: string): Promise<Mutes> => {
    const runtime = this.runtimes.get(hostId)
    const empty: Mutes = { workspaces: [], tabs: [] }
    if (!runtime) return empty
    const answer = await runtime.transport.request<Partial<Mutes> | null>('/api/herdr/mutes', undefined, { kind: 'read' })
    const clean = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
    const mutes = { workspaces: clean(answer?.workspaces), tabs: clean(answer?.tabs) }
    // A reconnect during the round trip makes this answer belong to a runtime
    // that no longer exists; publishing it would overwrite the fresh list with
    // the previous generation's and flip mute buttons back.
    if (this.runtimes.get(hostId) !== runtime) return mutes
    this.patchHost(hostId, { mutes })
    return mutes
  }

  /**
   * Silences or unsilences one tab (a session) or one workspace.
   *
   * Exactly one of the two identifiers is sent: the desktop refuses a request
   * naming neither, and naming both would be ambiguous.
   */
  setMuted = async (hostId: string, target: { tab?: string; workspace?: string }, muted: boolean) => {
    const runtime = this.runtimes.get(hostId)
    if (!runtime) throw new Error(t('节点不存在'))
    const body = target.tab ? { tab: target.tab, muted } : target.workspace ? { workspace: target.workspace, muted } : null
    if (!body) throw new Error(t('找不到会话'))
    const answer = await runtime.transport.request<Partial<Mutes> | null>('/api/herdr/mutes', body, { kind: 'mutation' })
    const clean = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
    // The desktop answers with the whole list, so the local copy cannot drift
    // from what it will actually honour.
    const mutes = { workspaces: clean(answer?.workspaces), tabs: clean(answer?.tabs) }
    this.patchHost(hostId, { mutes })
    return mutes
  }

  /** True when either the tab or its workspace is silenced on that desktop. */
  isMuted = (hostId: string, pane: { tab_id?: string; workspace_id?: string }): boolean => {
    const mutes = this.state.hosts.find((item) => item.host.id === hostId)?.mutes
    if (!mutes) return false
    return Boolean(pane.tab_id && mutes.tabs.includes(pane.tab_id)) || Boolean(pane.workspace_id && mutes.workspaces.includes(pane.workspace_id))
  }

  /**
   * Restarts a stuck agent in its own pane.
   *
   * The desktop quits the process tree, starts the same agent again and can
   * hand it a prompt to continue with — all in the pane the user is looking
   * at, which a phone could not do by sending keys. Errors are the desktop's
   * own codes: `pane_not_found`, `unsupported_agent`, `no_agent_session`,
   * `quit_timeout`.
   */
  restartAgent = async (hostId: string, paneId: string, thenPrompt?: string): Promise<{ session_id?: string } | null> => {
    const runtime = this.runtimes.get(hostId)
    if (!runtime) throw new Error(t('节点不存在'))
    const body = { pane_id: paneId, ...(thenPrompt?.trim() ? { then_prompt: thenPrompt.trim() } : {}) }
    const answer = await runtime.transport.request<{ result?: { session_id?: string }; error?: { code?: string; message?: string } }>(
      '/api/herdr/restart-agent', body, { kind: 'mutation', timeoutMs: CREATE_TIMEOUT_MS },
    )
    if (answer?.error) throw new Error(answer.error.message || t('重启失败'))
    // Herdr replaces the session id; anything already loaded belongs to the
    // process that is gone, so the transcript is reloaded from scratch.
    const open = this.state.session
    if (open?.hostId === hostId && open.paneId === paneId) {
      this.stopSession()
      // The screen and the model/effort chips described the process that was
      // just killed, so they are cleared with the transcript rather than shown
      // as if the restarted agent were already running that way.
      this.publish({ selectedPaneId: paneId, session: { ...open, items: [], start: -1, end: 0, queued: [], sessionId: undefined, loading: true, unsupported: false, gap: undefined, uncertain: undefined, screen: '', settings: undefined, sentMessage: false } })
      void this.refreshSession()
    }
    return answer?.result ?? null
  }

  /**
   * One subagent's own transcript.
   *
   * The desktop keeps each dispatched agent in `<session>/subagents/*.jsonl`
   * and will page it by the tool-use id that dispatched it. This is the only
   * way to read what a background agent actually did; the parent transcript
   * holds one row for it.
   *
   * `limit` is the desktop's own default (400). The previous 200 quietly cut
   * long dispatches in half: the route takes no cursor, so there was nothing
   * to page with and the missing part was not even detectable.
   */
  loadSubagent = async (hostId: string, paneId: string, toolId: string, limit = 400): Promise<{
    agent: { type?: string; description?: string; finished?: boolean }
    items: ChatItem[]
  }> => {
    const runtime = this.runtimes.get(hostId)
    if (!runtime) throw new Error(t('节点不存在'))
    const query = new URLSearchParams({ pane: paneId, tool: toolId, limit: String(limit) })
    const answer = await runtime.transport.request<{
      agent?: { type?: string; description?: string; finished?: boolean }
      page?: { items?: ChatItem[] }
      error?: { code?: string; message?: string }
    }>(`/api/herdr/subagent?${query}`, undefined, { kind: 'read' })
    if (answer?.error) {
      if (answer.error.code === 'subagent_not_found') throw new Error(t('子 agent 的记录不存在或已被清理'))
      throw new Error(answer.error.message || t('无法读取子 agent'))
    }
    return { agent: answer?.agent ?? {}, items: answer?.page?.items ?? [] }
  }

  /**
   * Fetches one transcript image through the tunnel.
   *
   * Deliberately not an <img src="…">: the path is only meaningful inside the
   * encrypted tunnel, and a message must never be able to make the WebView
   * issue a request of its choosing. The bytes come back here and the caller
   * turns them into a blob URL it owns.
   */
  fetchImage = async (hostId: string, url: string): Promise<{ bytes: Uint8Array; contentType: string }> => {
    const runtime = this.runtimes.get(hostId)
    if (!runtime) throw new Error(t('节点不存在'))
    const answer = await runtime.transport.request<BinaryResponse>(imageRequestPath(url), undefined, { kind: 'read', responseType: 'bytes', timeoutMs: 30_000 })
    if (!answer.bytes.length) throw new Error(t('图片为空'))
    return { bytes: answer.bytes, contentType: answer.contentType }
  }

  /**
   * Renames a session. The label lives on the Herdr tab, so the desktop shows
   * it too, and the pane keeps its own label untouched.
   */
  renameSession = async (hostId: string, paneId: string, label: string) => {
    const trimmed = label.trim().slice(0, 80)
    const pane = this.state.hosts.find((item) => item.host.id === hostId)?.snapshot?.panes.find((item) => item.pane_id === paneId)
    if (!pane?.tab_id) throw new Error(t('找不到会话'))
    // An empty name clears the label, which restores Herdr's own title.
    if (label.trim() && !trimmed) throw new Error(t('名称不能为空'))
    await this.rpc(hostId, 'tab.rename', { tab_id: pane.tab_id, label: trimmed })
    // Herdr pushes a fresh snapshot after a rename, but the list must not look
    // unchanged while that round trip is in flight.
    const snapshot = this.state.hosts.find((item) => item.host.id === hostId)?.snapshot
    if (snapshot) {
      this.patchHost(hostId, {
        snapshot: { ...snapshot, tabs: (snapshot.tabs ?? []).map((tab) => tab.tab_id === pane.tab_id ? { ...tab, label: trimmed } : tab) },
      })
    }
  }

  /**
   * Turns connection attempts for one desktop on or off.
   *
   * This is the user's own decision, saved with the pairing: a desktop that is
   * off, or one they do not want on mobile data, stops being dialled and stops
   * scheduling retries until they turn it back on. Nothing else re-enables it,
   * so it cannot quietly undo the choice.
   */
  setHostEnabled = async (id: string, enabled: boolean) => {
    if (!this.initializedStorage) throw new Error(t('安全存储尚未就绪'))
    await this.serialize(async () => {
      const target = this.state.hosts.find((item) => item.host.id === id)
      if (!target) throw new Error(t('节点不存在'))
      const hosts = this.state.hosts.map((item) => item.host.id === id ? { ...item.host, enabled } : item.host)
      await this.storage.save(hosts)
      this.publish({ hosts: this.state.hosts.map((item) => item.host.id === id ? { ...item, host: { ...item.host, enabled } } : item) })
      if (!enabled) {
        this.stopHost(id)
        this.patchHost(id, { status: 'disabled', herdrOnline: false, error: undefined, retriesLeft: undefined, stopReason: undefined })
      } else {
        this.attach(this.state.hosts.find((item) => item.host.id === id)!.host)
      }
    })
  }

  /** Releases one desktop: sockets, retries and any session open on it. */
  private stopHost(id: string) {
    const runtime = this.runtimes.get(id)
    if (this.state.session?.hostId === id) this.stopSession()
    this.publish({ ...(this.state.session?.hostId === id ? { session: undefined, selectedPaneId: undefined } : {}) })
    if (!runtime) return
    // Drop it before closing, so the close's 'offline' cannot schedule a retry.
    this.cancelRetry(runtime)
    this.runtimes.delete(id)
    this.closeRuntime(runtime)
  }

  /** Renames a paired desktop. The credential and connection are untouched. */
  renameHost = async (id: string, name: string) => {
    if (!this.initializedStorage) throw new Error(t('安全存储尚未就绪'))
    const trimmed = name.trim().slice(0, 80)
    if (!trimmed) throw new Error(t('名称不能为空'))
    await this.serialize(async () => {
      const hosts = this.state.hosts.map((item) => item.host.id === id ? { ...item.host, name: trimmed } : item.host)
      if (!hosts.some((host) => host.id === id)) throw new Error(t('节点不存在'))
      await this.storage.save(hosts)
      this.publish({
        hosts: this.state.hosts.map((item) => item.host.id === id ? { ...item, host: { ...item.host, name: trimmed } } : item),
      })
    })
  }
  forgetHost = async (id: string) => {
    if (!this.initializedStorage) throw new Error(t('安全存储尚未就绪'))
    await this.serialize(async () => {
      const hosts = this.state.hosts.filter((item) => item.host.id !== id)
      await this.storage.save(hosts.map((item) => item.host))
      const runtime = this.runtimes.get(id)
      this.runtimes.delete(id)
      if (runtime) this.closeRuntime(runtime)
      if (this.state.session?.hostId === id) this.stopSession()
      this.publish({ hosts, ...(this.state.selectedHostId === id ? { selectedHostId: undefined, selectedPaneId: undefined, session: undefined } : {}) })
    })
  }
  selectHost = (id: string) => {
    if (id === this.state.selectedHostId) return
    this.stopSession()
    this.publish({ selectedHostId: id, selectedPaneId: undefined, session: undefined })
    void this.storage.saveSelection?.(id).catch(() => undefined)
  }
  /** Manual retry: the user's explicit fallback, always allowed. */
  retryHost = (id: string) => {
    const runtime = this.runtimes.get(id)
    if (!runtime) return
    this.cancelRetry(runtime)
    runtime.attempts = 0
    runtime.stopped = undefined
    this.patchHost(id, { retriesLeft: MAX_RETRIES, stopReason: undefined, error: undefined })
    void this.connectHost(id, runtime)
  }

  /**
   * Checks that every open tunnel still carries traffic.
   *
   * A socket can be dead while both ends' state says it is fine, because the
   * close event never ran — the page was frozen when the relay dropped it. One
   * short read settles it; a transport that cannot answer rebuilds itself and
   * reports offline, which starts the usual retry ladder.
   */
  /**
   * Checks that every open tunnel still carries traffic.
   *
   * The idle probe lives in the transport, where it can see pending requests
   * and queued sends; this only answers "is it alive right now", for the
   * moment the app comes back to the foreground after a brief absence.
   */
  verify = async () => {
    // Snapshot: `rebuild` below replaces the map entry, and a key re-added
    // during iteration is visited again.
    for (const [id, runtime] of [...this.runtimes]) {
      if (runtime.stopped) continue
      const status = this.state.hosts.find((item) => item.host.id === id)?.status
      if (status !== 'online') continue
      try {
        await runtime.transport.request<{ online: boolean }>('/api/herdr/info', undefined, { kind: 'read', timeoutMs: VERIFY_TIMEOUT_MS })
      } catch { /* the transport has already reported the failure */ }
      if (this.runtimes.get(id) !== runtime) continue
      if (this.state.hosts.find((item) => item.host.id === id)?.status !== 'online') this.rebuild(id, runtime)
    }
  }
  /** Replaces a runtime whose transport is known to be dead. */
  private rebuild(id: string, runtime: Runtime) {
    if (this.runtimes.get(id) !== runtime) return
    const host = this.state.hosts.find((item) => item.host.id === id)?.host
    if (!host) return
    this.cancelRetry(runtime)
    // Drop it first: closing reports offline, and a replaced runtime must not
    // schedule a retry of its own.
    this.runtimes.delete(id)
    this.closeRuntime(runtime)
    const fresh = this.makeRuntime(host)
    this.runtimes.set(id, fresh)
    this.patchHost(id, { retriesLeft: MAX_RETRIES, stopReason: undefined, error: undefined })
    void this.connectHost(id, fresh)
  }

  /**
   * Retry everything that gave up, without disturbing the ones that are fine.
   * Used when the app returns to the foreground or the network comes back.
   */
  retryStopped = () => {
    for (const [id, runtime] of this.runtimes) {
      const status = this.state.hosts.find((item) => item.host.id === id)?.status
      // Only a desktop that is not already connected needs anything. A host in
      // the middle of the ladder is redialled now rather than at its scheduled
      // moment: whatever caused the failure — a tunnel, a handover — has just
      // been reported as over, so waiting out the remaining delay only makes
      // the user sit on a red banner.
      if (status === 'online' && !runtime.stopped) continue
      this.cancelRetry(runtime)
      runtime.attempts = 0
      runtime.stopped = undefined
      this.patchHost(id, { retriesLeft: MAX_RETRIES, stopReason: undefined })
      void this.connectHost(id, runtime)
    }
  }

  /** Releases every socket when the app has been away long enough. */
  /**
   * Releases every socket when the app has been away long enough.
   *
   * The transport is single-use: closing it marks it stopped and `connect()`
   * refuses forever after. So the runtime is dropped rather than reused, and
   * `resume` builds a new one — otherwise the desktop would stay offline for
   * the rest of the process's life.
   */
  suspend = () => {
    this.stopSession()
    for (const [id, runtime] of [...this.runtimes]) {
      // Drop it before closing, like every other teardown path: `close` reports
      // 'offline' synchronously and the scheduler arms a retry for whatever is
      // still current, which would leave a timer waking a suspended phone.
      this.cancelRetry(runtime)
      this.runtimes.delete(id)
      this.closeRuntime(runtime)
      this.patchHost(id, { status: 'offline', herdrOnline: false })
    }
  }

  /**
   * Coming back to the app reconnects on a fresh ladder.
   *
   * `rebuild` replaces the transports even when they look open. Android
   * freezes the page in the background, so after a real absence the socket in
   * hand is one the relay has already dropped, and only a new one will do.
   * Without `rebuild`, only a suspended runtime is rebuilt; a quick app switch
   * keeps the live socket.
   */
  resume = (rebuild: boolean) => {
    for (const state of this.state.hosts) {
      // A switched-off desktop was never released, so there is nothing to
      // resume — and bringing it back would defeat the switch.
      if (state.host.enabled === false) continue
      const id = state.host.id
      const existing = this.runtimes.get(id)
      if (existing && !rebuild) continue
      // Drop the runtime before closing it: closing reports 'offline', and a
      // runtime that is no longer current must not schedule a retry of its own.
      if (existing) {
        this.cancelRetry(existing)
        this.runtimes.delete(id)
        this.closeRuntime(existing)
      }
      const runtime = this.makeRuntime(state.host)
      this.runtimes.set(id, runtime)
      this.patchHost(id, { retriesLeft: MAX_RETRIES, stopReason: undefined, error: undefined })
      void this.connectHost(id, runtime)
    }
  }
  backToSessions = () => { this.stopSession(); this.publish({ selectedPaneId: undefined, session: undefined }) }
  private stopSession() {
    ++this.sessionEpoch
    ++this.sessionIdentity
    this.sessionRefresh = undefined
    for (const timer of this.sessionTimers) clearTimeout(timer)
    this.sessionTimers.clear()
    for (const socket of this.sessionSockets.splice(0)) socket.close()
  }
  selectPane = async (paneId: string) => {
    const hostId = this.state.selectedHostId
    // Report the failure rather than returning silently: a caller that opens a
    // session (a notification tap, a new session) would otherwise believe it
    // succeeded and act on whatever session was open before — which is how a
    // notification reply ended up in a different conversation.
    if (!hostId || !this.runtimes.has(hostId)) throw new Error(t('节点未连接，无法打开会话'))
    this.stopSession()
    this.publish({ selectedPaneId: paneId, session: { hostId, paneId, items: [], start: -1, end: 0, queued: [], loading: true, loadingOlder: false, screen: '', unsupported: false, sentMessage: false, sending: false } })
    await this.refreshSession()
  }
  /** Manual retry: drop any scheduled attempt and reload now. */
  reloadSession = async () => {
    for (const timer of this.sessionTimers) clearTimeout(timer)
    this.sessionTimers.clear()
    this.sessionRefresh = undefined
    await this.refreshSession()
  }
  private refreshSession(): Promise<void> {
    if (this.sessionRefresh) return this.sessionRefresh
    const epoch = this.sessionEpoch
    const promise = this.loadSession(epoch).finally(() => { if (epoch === this.sessionEpoch && this.sessionRefresh === promise) this.sessionRefresh = undefined })
    this.sessionRefresh = promise
    return promise
  }
  /**
   * Schedules the next session refresh, backing off on repeated failures.
   *
   * The old fixed 1.8 s meant a session screen with the desktop unreachable
   * made a failed request every 1.8 seconds, forever. Each failure is now
   * spaced further apart, capped at 30 s, and a successful load resets the
   * count. `fixed` is for the deliberate "come back later" cases, such as an
   * agent that has not reported its session id yet.
   */
  private later(epoch: number, fixed?: number) {
    const delay = fixed ?? sessionDelay(this.sessionFailures)
    if (fixed === undefined) this.sessionFailures++
    const timer = setTimeout(() => { this.sessionTimers.delete(timer); if (epoch === this.sessionEpoch) void this.refreshSession() }, delay)
    this.sessionTimers.add(timer)
  }
  private async loadSession(epoch: number) {
    const session = this.state.session
    // Abandoning this load must not leave the spinner running: the caller may
    // have switched panes, or the runtime may be gone after a suspend. Clearing
    // here keeps the next screen from inheriting a permanent "loading".
    if (!session || epoch !== this.sessionEpoch) return
    const runtime = this.runtimes.get(session.hostId)
    if (!runtime) { this.patchSession(epoch, { loading: false }); return }
    for (const socket of this.sessionSockets.splice(0)) socket.close()
    // Only show a spinner while the first page is in flight; an empty
    // transcript is a valid end state, not a permanent load.
    this.patchSession(epoch, { loading: session.items.length === 0, error: undefined })
    try {
      const page = await runtime.transport.request<Page>(`/api/herdr/chat?pane=${encodeURIComponent(session.paneId)}&limit=60`)
      if (epoch !== this.sessionEpoch) return
      if (page.error) {
        // Alma reports both `no_session` and `no_agent_session`. Two different situations
        // land here: a plain terminal (nothing to show) and an agent whose integration has
        // not reported its native session id yet, where a transcript will appear shortly.
        // Neither is an error, and the second one must keep retrying.
        const code = page.error.code || ''
        if (['unsupported_agent', 'no_session', 'no_agent_session', 'transcript_not_found'].includes(code)) {
          const pane = this.state.hosts.find((item) => item.host.id === session.hostId)?.snapshot?.panes.find((item) => item.pane_id === session.paneId)
          const gap = transcriptGap(code, pane, session.sentMessage)
          this.patchSession(epoch, { unsupported: true, gap, loading: false, error: undefined })
          // An agent can still report its id, or its transcript can appear, so
          // keep asking; nothing changes on its own for a shell, so look rarely.
          this.later(epoch, gap === 'terminal' || gap === 'unsupported' ? 15_000 : 4000)
        } else throw new Error(page.error.message || t('无法读取会话'))
      } else {
        // A page arrived, so the next failure starts the ladder from the top.
        this.sessionFailures = 0
        const same = session.sessionId === page.session_id
        const items = same ? session.items : merge([], page.page?.items ?? [])
        const cursor = same ? session.end : page.page?.end ?? 0
        const settings = readSettings(page.settings)
        this.patchSession(epoch, {
          items, sessionId: page.session_id,
          start: same && session.start >= 0 ? session.start : page.page?.start ?? 0,
          end: cursor, queued: page.queued ?? [], loading: false, unsupported: false, gap: undefined,
          ...(settings ? { settings } : {}),
        })
        const chat = runtime.transport.subscribe(`/ws/herdr/chat?pane=${encodeURIComponent(session.paneId)}&from=${cursor}`, (event) => {
          if (epoch !== this.sessionEpoch || !this.state.session) return
          if (event.type === 'items' && Array.isArray(event.items)) this.patchSession(epoch, { items: merge(this.state.session.items, event.items), end: Number(event.end) || this.state.session.end })
          if (event.type === 'queued' && Array.isArray(event.queued)) this.patchSession(epoch, { queued: event.queued })
          // The socket pushes `settings` whenever the transcript's model or
          // effort changes mid-session, which is exactly when the header chip
          // would otherwise go stale.
          if (event.type === 'settings') {
            const next = readSettings(event.settings)
            const session = this.state.session
            if (session && next && (!session.settings || settingsChanged(session.settings, next))) this.patchSession(epoch, { settings: next })
          }
          if (event.type === 'session_changed') { ++this.sessionIdentity; this.patchSession(epoch, { items: [], queued: [], sessionId: undefined, end: 0, start: -1, loading: true, uncertain: undefined, settings: undefined }); this.later(epoch) }
        }, () => { if (epoch === this.sessionEpoch) this.later(epoch) })
        this.sessionSockets.push(chat)
      }
      this.sessionSockets.push(runtime.transport.subscribe(`/ws/herdr/screen?pane=${encodeURIComponent(session.paneId)}`, (event) => {
        if (event.type === 'screen') this.patchSession(epoch, { screen: typeof event.read?.text === 'string' ? event.read.text : this.state.session?.screen ?? '' })
      }, () => { if (epoch === this.sessionEpoch) this.later(epoch) }))
      await this.readScreen()
    } catch (error) { this.patchSession(epoch, { loading: false, error: message(error) }); if (epoch === this.sessionEpoch) this.later(epoch) }
  }
  loadOlder = async () => {
    const session = this.state.session, epoch = this.sessionEpoch, identity = this.sessionIdentity
    if (!session || session.loadingOlder || session.start <= 0) return
    this.patchSession(epoch, { loadingOlder: true })
    try {
      const page = await this.runtimes.get(session.hostId)!.transport.request<Page>(`/api/herdr/chat?pane=${encodeURIComponent(session.paneId)}&before=${session.start}&limit=60`)
      if (page.error) throw new Error(page.error.message || t('历史读取失败'))
      // A late page from the previous session must not splice into the current transcript.
      if (epoch !== this.sessionEpoch || identity !== this.sessionIdentity || page.session_id !== this.state.session?.sessionId) return
      this.patchSession(epoch, { items: merge(this.state.session!.items, page.page?.items ?? [], true), start: page.page?.start ?? 0 })
    } catch (error) { if (identity === this.sessionIdentity) this.patchSession(epoch, { error: message(error) }) } finally { this.patchSession(epoch, { loadingOlder: false }) }
  }
  /**
   * Answers a numbered agent prompt.
   *
   * The screen shown when the user tapped may already be stale, so this
   * re-reads the terminal and requires the parsed menu to match exactly
   * (same question, same labels, same highlighted row) before sending keys.
   * On drift it aborts and refreshes instead of guessing.
   */
  answerPrompt = async (expected: Prompt, optionNumber: number) => {
    const session = this.state.session, epoch = this.sessionEpoch
    if (!session) throw new Error(t('没有打开的会话'))
    if (session.sending) return
    if (session.uncertain) throw new Error(session.uncertain)
    const option = expected.options.find((item) => item.number === optionNumber)
    if (!option) throw new Error(t('选项不存在'))

    const fresh = await this.rpc<{ read?: { text?: string } }>(session.hostId, 'pane.read', { pane_id: session.paneId, source: 'visible', format: 'text' })
    if (epoch !== this.sessionEpoch) return
    const screen = fresh.read?.text ?? ''
    const current = parsePrompt(screen)
    this.patchSession(epoch, { screen })
    if (!samePrompt(current, expected) || !current) {
      this.patchSession(epoch, { error: t('终端内容已变化，已取消本次选择。请确认最新问题后再点。') })
      return
    }
    const target = current.options.findIndex((item) => item.number === optionNumber)
    if (target < 0) { this.patchSession(epoch, { error: t('选项已不存在，请刷新后重试。') }); return }

    this.patchSession(epoch, { sending: true, error: undefined })
    try {
      const keys: string[] = []
      const multiSelect = needsSpace(current.options[target])
      if (current.cursor >= 0 && current.cursor !== target) {
        const moves = moveKeys(current.cursor, target)
        if (!moves) throw new Error(t('无法确定光标位置'))
        keys.push(...moves)
      }
      // In a multi-select menu Enter *submits* the whole form, so it must never
      // be sent for a plain row: only Space toggles. Single-choice menus commit
      // by moving the cursor and pressing Enter, which is why the two cases are
      // kept apart instead of sharing one fallback.
      if (multiSelect) keys.push(' ')
      else if (current.cursor >= 0 && current.cursor !== target) keys.push('enter')
      else keys.push(String(optionNumber))
      await this.rpc(session.hostId, 'pane.send_keys', { pane_id: session.paneId, keys: keys.map((key) => key === ' ' ? 'space' : key) })
      if (epoch === this.sessionEpoch) await this.readScreen()
    } catch (error) {
      this.patchSession(epoch, { error: message(error), ...(error instanceof OperationUncertainError ? { uncertain: message(error) } : {}) })
      throw error
    } finally { this.patchSession(epoch, { sending: false }) }
  }
  /**
   * The pane a tab holds, asked of Herdr rather than assumed.
   *
   * `layout.apply` normally names the pane it focused, but a reply without one
   * must not turn a created session into a reported failure.
   */
  private async paneOfTab(hostId: string, tabId?: string): Promise<string | undefined> {
    if (!tabId) return undefined
    const runtime = this.runtimes.get(hostId)
    if (!runtime) return undefined
    // A tab is created for one pane at a time, and this app is what created it,
    // so the association is already known. Asking the desktop first would cost
    // a round trip on a path that exists to recover from a missing one.
    for (const [key, known] of this.tabAddress) {
      if (known === tabId && key.startsWith(`${hostId}:`)) return key.slice(hostId.length + 1)
    }
    try {
      const pane = await this.rpc<{ pane?: { pane_id?: string } }>(hostId, 'tab.get', { tab_id: tabId })
      return pane?.pane?.pane_id
    } catch {
      // The method may not exist on an older desktop; the snapshot still can.
      return new Promise<string | undefined>((resolve) => {
        let socket: { close(): void } | undefined
        const done = (value?: string) => { socket?.close(); resolve(value) }
        const timer = setTimeout(() => done(undefined), 5000)
        socket = runtime.transport.subscribe('/ws/herdr', (event) => {
          if (event.type !== 'snapshot') return
          clearTimeout(timer)
          const panes = (event.snapshot?.panes ?? []) as { pane_id?: string; tab_id?: string }[]
          done(panes.find((item) => item.tab_id === tabId)?.pane_id)
        }, () => done(undefined))
      })
    }
  }

  /**
   * One Herdr RPC.
   *
   * `timeoutMs` exists because starting an agent is not like reading a pane:
   * Herdr launches a process and waits for it to become interactive before it
   * answers, and the default 20 s is shorter than a cold agent start on a busy
   * machine. The request has already been sent by then, so the user sees the
   * "may have run" message for what is really a slow but successful create.
   */
  private async rpc<T>(hostId: string, method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    const runtime = this.runtimes.get(hostId)
    if (!runtime) throw new Error(t('节点不存在'))
    const response = await runtime.transport.request<{ result?: T; error?: { code?: string; message?: string } }>(
      '/api/herdr/rpc', { method, params }, timeoutMs === undefined ? undefined : { timeoutMs },
    )
    if (response.error) throw new Error(response.error.message || response.error.code || t('Herdr 操作失败'))
    return response.result as T
  }
  readScreen = async () => {
    const session = this.state.session, epoch = this.sessionEpoch
    if (!session) return
    try { const result = await this.rpc<{ read?: { text?: string } }>(session.hostId, 'pane.read', { pane_id: session.paneId, source: 'visible', format: 'text' }); this.patchSession(epoch, { screen: result.read?.text ?? '' }) }
    catch (error) { this.patchSession(epoch, { error: message(error) }) }
  }
  /** True when the call was actually made; false when one was already in flight. */
  private async mutate(method: string, params: (session: SessionState) => Record<string, unknown>): Promise<boolean> {
    const session = this.state.session, epoch = this.sessionEpoch
    if (!session) throw new Error(t('没有打开的会话'))
    if (session.sending) return false
    if (session.uncertain) throw new Error(session.uncertain)
    this.patchSession(epoch, { sending: true, error: undefined })
    try {
      await this.rpc(session.hostId, method, params(session))
      if (epoch === this.sessionEpoch) await this.readScreen()
      return true
    }
    catch (error) { this.patchSession(epoch, { error: message(error), ...(error instanceof OperationUncertainError ? { uncertain: message(error) } : {}) }); throw error }
    finally { this.patchSession(epoch, { sending: false }) }
  }
  /**
   * Records that the user has handed this pane work. That is what turns a
   * missing session id from "the agent is still starting" into "nothing is
   * going to report one", so the pane can say which of the two it is.
   */
  private markSent(epoch: number) { if (epoch === this.sessionEpoch) this.patchSession(epoch, { sentMessage: true }) }
  sendMessage = async (text: string) => {
    if (!text.trim()) return
    const epoch = this.sessionEpoch
    if (await this.mutate('agent.prompt', (s) => ({ target: s.paneId, text }))) this.markSent(epoch)
  }
  /**
   * Runs one of the agent's own slash commands.
   *
   * The command is typed into the terminal, not sent as a prompt, so the agent
   * handles it exactly as if the user had typed it. Anything it prints arrives
   * on the screen stream, which is why the caller switches to the terminal.
   */
  runCommand = async (command: string) => {
    const text = command.trim()
    if (!text.startsWith('/')) throw new Error(t('只支持斜杠命令'))
    const session = this.state.session, epoch = this.sessionEpoch
    if (!session) throw new Error(t('没有打开的会话'))
    if (session.sending) return
    if (session.uncertain) throw new Error(session.uncertain)
    this.patchSession(epoch, { sending: true, error: undefined })
    try {
      await this.rpc(session.hostId, 'pane.send_text', { pane_id: session.paneId, text })
      if (epoch === this.sessionEpoch) await this.readScreen()
    } catch (error) {
      this.patchSession(epoch, { error: message(error), ...(error instanceof OperationUncertainError ? { uncertain: message(error) } : {}) })
      throw error
    } finally { this.patchSession(epoch, { sending: false }) }
  }

  /**
   * One step of a numbered menu, applied from outside the session screen.
   *
   * A notification button is exactly the "may already be stale" case the
   * in-app prompt guards against, worsened by the fact that the user may be in
   * another app entirely. So this reads the pane, finds the menu the caller
   * expected, and refuses if the question, the labels or the highlighted row
   * moved. `answerPrompt` is only the caller-polished form of this; the
   * notification path cannot rebuild a `Prompt` from a snapshot, so it opts out
   * of the exact-match and instead requires the menu to still be there.
   *
   * `intent` picks the option by wording (see `optionForIntent`); a number is
   * accepted for callers that already know which row they mean. Either way the
   * menu is re-read first, so a notification tapped minutes later cannot press
   * a row that has since become a different question.
   */
  readPaneScreen = async (hostId: string, paneId: string): Promise<string> => {
    const fresh = await this.rpc<{ read?: { text?: string } }>(hostId, 'pane.read', { pane_id: paneId, source: 'visible', format: 'text' })
    // Stripped here, once, so the alert that hashes this screen and the action
    // that re-reads it hash the same text. `pane.read` returns coloured output
    // whether or not the format asks for text, and a menu with escape codes in
    // it parses as nothing at all.
    return stripAnsi(fresh.read?.text ?? '')
  }

  answerPromptFromAlert = async (
    hostId: string,
    paneId: string,
    choice: number | 'allow' | 'deny',
    expectedFingerprint?: string,
  ): Promise<void> => {
    const runtime = this.runtimes.get(hostId)
    if (!runtime) throw new Error(t('节点不存在'))
    const screen = await this.readPaneScreen(hostId, paneId)
    const menu = parsePrompt(screen)
    if (!menu) throw new Error(t('终端里的选项已经消失，请打开会话确认'))
    // A notification may sit in the shade while the agent moves on to another
    // question. Generic "Allow" must not answer whatever happens to be visible
    // now: require the exact menu fingerprint captured when this alert was
    // posted. If the alert predates this safeguard or no fingerprint was
    // captured, fail closed and open the session instead.
    if (!expectedFingerprint || await promptFingerprint(menu) !== expectedFingerprint) {
      throw new Error(t('终端中的问题已变化，请打开会话确认'))
    }
    const optionNumber = typeof choice === 'number' ? choice : optionForIntent(menu, choice)
    if (optionNumber === null) throw new Error(t('这个选择在终端里已经不明确了，请打开会话确认'))
    const target = menu.options.findIndex((item) => item.number === optionNumber)
    if (target < 0) throw new Error(t('选项已不存在，请刷新后重试。'))
    const keys: string[] = []
    const multiSelect = needsSpace(menu.options[target])
    if (menu.cursor >= 0 && menu.cursor !== target) {
      const moves = moveKeys(menu.cursor, target)
      if (!moves) throw new Error(t('无法确定光标位置'))
      keys.push(...moves)
    }
    // Same rule as `answerPrompt`: in a multi-select menu Enter submits the
    // whole form, so a row is only ever toggled with Space. A notification tap
    // must not be able to commit a form the user has not finished filling in.
    if (multiSelect) keys.push(' ')
    else if (menu.cursor >= 0 && menu.cursor !== target) keys.push('enter')
    else keys.push(String(optionNumber))
    await this.rpc(hostId, 'pane.send_keys', { pane_id: paneId, keys: keys.map((key) => key === ' ' ? 'space' : key) })
  }

  sendKeys = async (keys: string[]) => {
    const names: Record<string, string> = { Up: 'up', Down: 'down', Left: 'left', Right: 'right', Enter: 'enter', Escape: 'esc', 'C-c': 'ctrl+c' }
    if (!keys.length || keys.length > 20 || keys.some((key) => !names[key])) throw new Error(t('不支持的终端按键'))
    await this.mutate('pane.send_keys', (s) => ({ pane_id: s.paneId, keys: keys.map((key) => names[key]) }))
  }
  sendTerminalText = async (text: string) => {
    const session = this.state.session, epoch = this.sessionEpoch
    if (!session) throw new Error(t('没有打开的会话'))
    if (session.sending || !text) return
    if (session.uncertain) throw new Error(session.uncertain)
    this.patchSession(epoch, { sending: true, error: undefined })
    let textSent = false
    try {
      await this.rpc(session.hostId, 'pane.send_text', { pane_id: session.paneId, text: `\u001b[200~${text}\u001b[201~` })
      textSent = true
      await this.rpc(session.hostId, 'pane.send_keys', { pane_id: session.paneId, keys: ['enter'] })
      if (epoch === this.sessionEpoch) await this.readScreen()
      this.markSent(epoch)
    } catch (error) {
      const uncertain = error instanceof OperationUncertainError || textSent
      this.patchSession(epoch, { error: message(error), ...(uncertain ? { uncertain: t('终端输入可能已部分执行，请核对画面后重新打开会话。') } : {}) })
      throw error
    } finally { this.patchSession(epoch, { sending: false }) }
  }
  dispose() { this.stopSession(); const runtimes = [...this.runtimes.values()]; this.runtimes.clear(); for (const runtime of runtimes) this.closeRuntime(runtime) }
}
export const controller = new Controller()
