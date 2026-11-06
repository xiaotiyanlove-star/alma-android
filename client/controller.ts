import type { AppState, ChatItem, Host, Mutes, SessionState, Snapshot } from './model'
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
import { imageRequestPath, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_MB, uploadRoute, type UploadedFile } from './attachments'
import { moveKeys, needsSpace, optionForIntent, parsePrompt, promptFingerprint, samePrompt, stripAnsi, type Prompt } from './prompt'
import { parseSessionInfo } from './session-info'
import { readChatPage, mergeChatItems, readMediaResponse, readSnapshot, readUploadResponse } from './protocol'
import { MediaCache } from './media-cache'
import { answerKeys, bracketedTerminalText, protocolKeys, terminalKeys, validTerminalKeys } from './operations'
import { SessionLoader, type SessionLoaderHost, type SessionTransport } from './session-loader'
import { readSettings } from './session-rules'
export { transcriptGap } from './session-rules'

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
/**
 * How often a connected desktop is asked where it is.
 *
 * Cheap enough (one round trip on a tunnel that is already open) to repeat,
 * and repeating is what makes this reliable: the listener can be switched on
 * after the app connected, and a desktop that moved networks is still the same
 * connected desktop.
 */
const ASK_INTERVAL_MS = 60_000
/** Deadline for the foreground liveness read; a healthy desktop answers at once. */
const VERIFY_TIMEOUT_MS = 5_000
import { hostStorage, type HostStorage } from './storage'
import { EncryptedTunnel, OperationUncertainError, RejectedError, type RequestInit2, type Transport, type TunnelError, type TunnelSocket } from './transport'

/**
 * One page of a transcript.
 *
 * `settings` is the model and effort the desktop read from the transcript
 * itself. It is the only authoritative source: the terminal prints a model name
 * only sometimes, and what it prints is what the agent chose to draw.
 */
const message = (error: unknown) => error instanceof Error ? error.message : t('请求失败')

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

/**
 * Transcript page size.
 *
 * 60 rows is roughly two screens of an agent turn, so reading back through a
 * session meant tapping "earlier" every few swipes. The view loads earlier
 * pages on scroll now, and a larger page keeps that from turning into one
 * request per flick; 150 still answers in well under a second on a phone.
 */
const TRANSCRIPT_PAGE = 150

const merge = mergeChatItems
interface Runtime {
  transport: Transport
  epoch: number
  hub?: TunnelSocket
  retry?: ReturnType<typeof setTimeout>
  attempts: number
  stopped?: 'exhausted' | 'auth' | 'unknown-host'
  /** Stops the idle probe when this runtime is replaced or closed. */
  stopHeartbeat?: () => void
  /**
   * A dial is currently in flight.
   *
   * More than one caller can ask for a connection within the same tick — the
   * return-to-foreground path did exactly that (`resume` replaced the tunnel
   * and then `retryStopped` dialled the same runtime again, because its status
   * was still `connecting`). Each extra dial opened a second socket, sent a
   * second `/api/herdr/info`, and could overwrite `hub` with a subscription
   * belonging to the socket that lost. Nothing here is reentrant, so the flag
   * is what makes one runtime one dial.
   */
  connecting?: boolean
}
export class Controller {
  private state: AppState = { hosts: [], loading: true, foreground: true }
  private listeners = new Set<() => void>()
  private runtimes = new Map<string, Runtime>()
  /** In-flight/successful remote image fetches, scoped to this controller. */
  private media = new MediaCache(24)
  private uncertain = new Map<string, string>()
  private initialized?: Promise<void>
  private openingHost = false
  private initializedStorage = false
  private sessions: SessionLoader
  constructor(
    private storage: HostStorage = hostStorage,
    private createTransport = (host: Host, status: (state: 'connecting' | 'online' | 'offline', error?: string, code?: TunnelError['code']) => void): Transport => new EncryptedTunnel(host, status),
  ) {
    // The loader calls this only through its browser-safe host bridge, and the
    // fields it needs are installed before either public method runs.
    this.sessions = new SessionLoader(this as unknown as SessionLoaderHost)
  }
  getState = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(patch: Partial<AppState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener() }
  private patchHost(id: string, patch: Partial<AppState['hosts'][number]>) { this.publish({ hosts: this.state.hosts.map((item) => item.host.id === id ? { ...item, ...patch } : item) }) }
  private patchSession(epoch: number, patch: Partial<SessionState>) {
    if (epoch === this.sessions.epoch && this.state.session) {
      this.publish({ session: { ...this.state.session, ...patch } })
    }
  }
  private getSession(): SessionState | undefined { return this.state.session }
  private setSession(session: SessionState | undefined): void {
    this.publish({ session })
  }
  private getRuntime(hostId: string): SessionTransport | undefined {
    return this.runtimes.get(hostId)?.transport
  }
  private getSnapshot(hostId: string): Snapshot | undefined {
    return this.state.hosts.find((item) => item.host.id === hostId)?.snapshot
  }
  private prefetch(hostId: string, paneId: string): void {
    if (this.state.session?.hostId === hostId) this.prefetchNeighbours(paneId)
  }
  private message(error: unknown): string { return message(error) }
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
      // Only a path that never answered is discarded, and only one failure at a
      // time: the first attempt at a stale address should fall back to the relay
      // and try again next time, because the address may simply have been busy.
      // Forgetting it immediately, plus suspending the path, is what turned one
      // unlucky dial into "no LAN for the rest of the session".
      if (this.discoveredLanFor(host.id) && !directAllowed(host.id)) {
        this.patchHost(host.id, { discoveredLan: undefined })
        // The remembered address is the one that keeps failing, so it is not
        // offered again on the next launch either.
        forgetRoute(host.id)
      }
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

  private sessionKey(hostId: string, paneId: string): string {
    return `${hostId}\u0000${paneId}`
  }

  private rememberUncertain(hostId: string, paneId: string, error: unknown): void {
    if (error instanceof OperationUncertainError) this.uncertain.set(this.sessionKey(hostId, paneId), message(error))
  }

  private uncertaintyFor(hostId: string, paneId: string): string | undefined {
    return this.uncertain.get(this.sessionKey(hostId, paneId))
  }

  private assertTarget(current: SessionState | undefined, hostId: string, paneId: string, epoch: number): asserts current is SessionState {
    if (!current || current.hostId !== hostId || current.paneId !== paneId || epoch !== this.sessions.epoch) {
      throw new Error(t('会话已切换，本次操作未发送。请在新会话中重试。'))
    }
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
    this.abortScans()
    this.lastDiscover.clear()
    this.lastAsk.clear()
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
    this.abortScans()
    this.lastDiscover.clear()
    this.lastAsk.clear()
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
    // A search that does not wait for the relay: if the public path is the
    // broken one and the phone is at home, scanning is the only way to find the
    // desktop at all. It is scan-only by construction (an offline desktop
    // cannot be asked), and it charges the scan clock rather than the ask one,
    // so the question that becomes possible once the tunnel is up still happens.
    this.maybeDiscover(host.id)
  }
  /**
   * Bounded retry: three attempts, at most 30 s apart, then stop. Automatic
   * retrying only resumes when the app is foregrounded, the network returns,
   * or the user asks — nothing else resets the ladder.
   *
   * LAN/relay split: this function is the only place that may start a local
   * search after a failed dial. The transport, pairing proof, E2E handshake,
   * subnet gate and relay URL construction are separate security boundaries
   * and must not be changed to make discovery work. A relay failure starts a
   * LAN search here; the runtime's normal retry and relay fallback remain.
   */
  private scheduleHost(id: string, runtime: Runtime, code?: TunnelError['code']) {
    // A dead relay is the reason to look on the LAN, not a reason to stop
    // looking. Start that search independently of the retry timer so a slow
    // relay timeout cannot hold local discovery hostage.
    const hostState = this.state.hosts.find((item) => item.host.id === id)
    const retryPending = Boolean(runtime.retry)
    if (!retryPending && !hostState?.discoveredLan && !this.discoveryRequestedForOutage.has(id)) {
      this.discoveryRequestedForOutage.add(id)
      this.lastDiscover.delete(id)
      this.maybeDiscover(id, true)
    }
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
    if (foreground) {
      this.retryStopped()
      this.maybeDiscoverAll()
    }
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
    // A subnet scan can outlive the screen by minutes on a dense network.
    // Once hidden there is no one to use its result, so stop at the next
    // bounded probe instead of letting the radio finish all 254 addresses.
    this.abortScans()
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
  /** Which scan owns the per-desktop lock, so an old finally cannot release a new scan. */
  private scanOwners = new Map<string, { aborted: boolean }>()
  /** Set when relay connectivity makes the desktop answerable, so a scan yields. */
  private relocateScans = new Set<string>()
  /** Discovery tasks owned by this controller; disposal waits for them to finish. */
  private discoveryTasks = new Set<Promise<void>>()
  /** One eager LAN search per connection outage, never once per retry loop. */
  private discoveryRequestedForOutage = new Set<string>()
  private discoveryEpoch = 0
  private lastDiscover = new Map<string, number>()
  /** When each desktop was last asked for its addresses, per the tunnel life. */
  private lastAsk = new Map<string, number>()
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
      answer = await this.request(id, LAN_CANDIDATE_PATH, undefined, { kind: 'read', timeoutMs: 5_000 })
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

  private maybeDiscover(id: string, force = false) {
    // Discovery does not wait for a relay connection: if the public path is
    // broken, the LAN path is precisely how this phone can still reach home.
    // It remains background work and only runs while the app is visible.
    if (!lanDiscoveryEnabled()) return
    if (!this.state.foreground) return
    const hostState = this.state.hosts.find((item) => item.host.id === id)
    const host = hostState?.host
    if (!host || host.enabled === false) return

    // A known address normally means there is nothing to search for. It stops
    // meaning that as soon as the tunnel is not using it: the address may be
    // stale (the desktop moved, the phone changed network), or simply not
    // dialled because the breaker suspended it. Either way the session is on
    // the relay while the desktop is probably right here, and the only way to
    // learn otherwise is to ask again — one round trip on the open tunnel, at
    // the ordinary interval. Returning early here is what pinned a session to
    // `relay` for the rest of the day after a single stale address.
    if (hostState?.discoveredLan && hostState.route === 'direct') return
    const at = this.lastDiscover.get(id) ?? 0
    const now = Date.now()
    // A desktop that answered with a candidate list but did not answer on any
    // address is out of reach for a reason — asleep, on a different VLAN — and
    // retrying a minute later only spends radio on the same answer. A desktop
    // that reported nothing gets the ordinary interval: it may simply have been
    // started with its listener off and be switched on shortly.
    // Asking and scanning are throttled separately, because they cost
    // completely different things and become possible at different moments.
    // `attach` searches before the tunnel is up, when a desktop cannot be asked
    // and only a scan is possible; charging that scan's clock would put the
    // useful question ten minutes away, which is why a connected desktop stayed
    // on the relay for the rest of the session.
    const live = hostState?.status === 'online' && hostState.herdrOnline === true
    // Once the desktop can answer over its tunnel, a subnet scan is no longer
    // the shortest answer. Let it finish only if nobody can ask the desktop;
    // otherwise stop it at its next candidate and use one authenticated request.
    if (live && this.discovering.has(id)) {
      const owner = this.scanOwners.get(id)
      if (owner) {
        owner.aborted = true
        this.relocateScans.add(id)
      }
      this.discovering.delete(id)
      this.scanOwners.delete(id)
    } else if (this.discovering.has(id)) return
    const lastLook = live ? this.lastAsk.get(id) ?? 0 : at
    const wait = live ? ASK_INTERVAL_MS : this.lastMiss.get(id) === 'unreachable' ? DISCOVERY_MISS_MS : DISCOVERY_INTERVAL_MS
    // A new connection outage resets the scan clock. Otherwise a failed scan
    // made at launch kept the phone from using the LAN for ten minutes after
    // the relay died — the exact case this recovery path exists for.
    if (!force && now - lastLook < wait) return
    if (live) this.lastAsk.set(id, now)
    else this.lastDiscover.set(id, now)
    this.discovering.add(id)
    const startedAt = this.discoveryEpoch
    // Signalled when the network changes, so a scan of the old subnet stops
    // probing instead of running all 254 addresses to no purpose. The epoch
    // alone cannot do that: it only discards the answer after the fact.
    const scan = { aborted: false }
    this.scans.add(scan)
    this.scanOwners.set(id, scan)
    const task = (async () => {
      try {
        if (this.relocateScans.has(id) && scan.aborted) return
        // A hidden app has no user to benefit from a multi-second subnet scan.
        // Check again after entering the async task: `scheduleHost` can be
        // invoked synchronously while a transport is closing during suspend.
        if (!this.state.foreground || !lanDiscoveryEnabled()) {
          scan.aborted = true
          return
        }
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
        const displaced = this.relocateScans.delete(id)
        if (!displaced && this.scanOwners.get(id) === scan) {
          this.scanOwners.delete(id)
          this.discovering.delete(id)
        }
        // A connect that finished while this search was running had its own
        // call dropped by the `discovering` guard above. That call is the one
        // that can ask the desktop, so it must not be lost — run it now that
        // the slot is free.
        if (this.runtimes.has(id) && this.state.foreground) {
          // The eager outage search is already in flight or complete. Queue
          // only the normal cadence; a second forced call here would loop.
          this.maybeDiscover(id)
        }
      }
    })()
    this.discoveryTasks.add(task)
    void task.finally(() => this.discoveryTasks.delete(task))
  }

  /** Stops every scan in flight; the caller has already bumped the epoch. */
  private abortScans() {
    this.discoveryEpoch++
    for (const scan of this.scans) scan.aborted = true
    this.scans.clear()
    this.scanOwners.clear()
    this.relocateScans.clear()
    this.discovering.clear()
    this.discoveryRequestedForOutage.clear()
  }

  /** Resumes discovery only after the app is visible again. */
  private maybeDiscoverAll() {
    for (const [id, runtime] of [...this.runtimes]) {
      const state = this.state.hosts.find((item) => item.host.id === id)
      // A desktop that is connected but on the relay is exactly the case worth
      // asking about right now: returning to the app is when the user notices
      // the latency, and one authenticated request on the open tunnel settles
      // where the desktop actually is. The throttle is skipped here because
      // this is a single question per return, not a scan.
      if (runtime.stopped || state?.status !== 'online' || (state.discoveredLan !== undefined && state.route !== 'direct')) {
        this.maybeDiscover(id, true)
      }
    }
  }

  /**
   * Remembers a discovered address, and moves an open session onto it.
   *
   * The move is made before the break: a second tunnel is dialled to the local
   * address and must complete the handshake before the relay one is closed.
   * Rebuilding instead — closing first and dialling second — is what made a
   * route change visible as a disconnect: the session reloaded, the send button
   * greyed out, and a reply that arrived in that second was missed.
   */
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
    // Stored first so the new runtime receives it immediately, and so a
    // failure below still leaves the address for the next dial.
    this.patchHost(id, { discoveredLan: address })
    const runtime = this.runtimes.get(id)
    // Nothing open: the address is all that was wanted, and the next dial uses
    // it. This is the common case at launch, before the relay has answered.
    if (!runtime || runtime.stopped) return
    // Already there. A second tunnel to the same listener would prove nothing
    // and cost a handshake.
    if (this.routeOf(runtime) === 'direct') return
    await this.switchToLan(id, runtime)
  }

  /** The path this runtime is on, when the transport can say. */
  private routeOf(runtime: Runtime): 'direct' | 'relay' | undefined {
    const transport = runtime.transport as Partial<{ currentRoute(): 'direct' | 'relay' | undefined }>
    return typeof transport.currentRoute === 'function' ? transport.currentRoute() : undefined
  }

  /**
   * Opens a second tunnel on the local address and promotes it in place.
   *
   * Two things make this safe rather than merely fast:
   *
   * - Nothing is published until the new tunnel has finished its handshake and
   *   answered `info`. A direct attempt that fails leaves the relay tunnel
   *   exactly as it was, so a bad address costs a handshake and no outage.
   * - A mutation in flight defers the whole thing. A read can be replayed on a
   *   new tunnel; a request that was sent and not yet answered cannot, and
   *   moving the route under it would turn a definite outcome into "uncertain".
   */
  private async switchToLan(id: string, current: Runtime) {
    const transport = current.transport as Partial<{ busy(): boolean }>
    if (typeof transport.busy === 'function' && transport.busy()) return
    const host = this.state.hosts.find((item) => item.host.id === id)?.host
    if (!host) return
    // `makeRuntime` already offers the address it finds in state, and the
    // caller stored it just above — so this tunnel is dialled direct.
    const fresh = this.makeRuntime(host)
    fresh.epoch = 0
    try {
      const info = await fresh.transport.request<{ online: boolean; offline_reason?: string; herdr_error?: string }>('/api/herdr/info')
      // The desktop may have been forgotten, switched off, or replaced by a
      // reconnect while this dial ran. Then the new tunnel is simply closed.
      const still = this.runtimes.get(id)
      if (still !== current) { this.closeRuntime(fresh); return }
      // The transport falls back to the relay on its own, so a successful
      // `info` does not prove the local path opened. Promoting a relay tunnel
      // would swap one relay for another and, worse, score the address as
      // working when it never answered.
      if (this.routeOf(fresh) !== 'direct') {
        this.closeRuntime(fresh)
        recordDirect(id, false)
        return
      }
      const epoch = ++fresh.epoch
      this.cancelRetry(current)
      // Delete before closing: `close` reports offline synchronously, and the
      // replaced runtime must not schedule a retry of its own.
      this.runtimes.delete(id)
      this.runtimes.set(id, fresh)
      this.media.clear(id)
      this.closeRuntime(current)
      this.settleOnline(id, fresh, epoch, info)
      // The transport's own `onRoute` hook cannot score this one: it fires
      // during the handshake, before this runtime is in the map, and its guard
      // correctly ignores an unknown runtime. So the success is recorded here.
      this.patchHost(id, { route: 'direct' })
      recordDirect(id, true)
    } catch {
      // The local path did not answer. The relay tunnel was never touched, so
      // there is nothing to undo and nothing to tell the user. The failure is
      // recorded here because this runtime was never in the map, so the
      // transport's own `onDirectFailed` hook ignores it.
      this.closeRuntime(fresh)
      recordDirect(id, false)
    }
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
    // One dial per runtime at a time. A call that arrives while a dial is in
    // flight has nothing to add: the dial in progress already ends in `online`
    // or in a scheduled retry, and both paths re-read the current state.
    if (runtime.connecting) return
    runtime.connecting = true
    const epoch = ++runtime.epoch
    runtime.hub?.close()
    // The address is offered before every dial, not only when the runtime is
    // built. A transport that fell back to the relay keeps that route for its
    // whole life otherwise, and the direct path is never tried again even after
    // the reason it failed has gone away — which is how a session that was on
    // `lan` stayed on `relay` until the app restarted.
    this.applyLan(runtime, id, this.discoveredLanFor(id) ?? lastRoute(id))
    try {
      // Explicit even though `request` dials on demand: the tunnel is the thing
      // being established here, and a transport that fails to open must report
      // through the same path as a failed read.
      await runtime.transport.connect()
      const info = await runtime.transport.request<{ online: boolean; offline_reason?: string; herdr_error?: string }>('/api/herdr/info')
      if (this.runtimes.get(id) !== runtime || epoch !== runtime.epoch) return
      this.settleOnline(id, runtime, epoch, info)
    } catch (error) {
      if (this.runtimes.get(id) !== runtime || epoch !== runtime.epoch) return
      this.patchHost(id, { status: 'error', herdrOnline: false, error: message(error) })
      this.scheduleHost(id, runtime)
    } finally {
      runtime.connecting = false
    }
  }

  /**
   * Publishes a tunnel that has completed its handshake and answered `info`.
   *
   * Split out of `connectHost` because a route can now be adopted on a
   * *second* tunnel while the first one is still up (see `adoptLan`). The two
   * paths must end in exactly the same state — same snapshot subscription, same
   * probe, same mute refresh, same discovery nudge — or a silky route change
   * would quietly leave a desktop without its live snapshot.
   */
  private settleOnline(id: string, runtime: Runtime, epoch: number, info: { online?: boolean; offline_reason?: unknown; herdr_error?: unknown }) {
    this.patchHost(id, {
      status: 'online',
      herdrOnline: info.online === true,
      error: this.herdrOffline(info),
      offlineReason: info.online === true ? undefined : (typeof info.offline_reason === 'string' ? info.offline_reason : undefined),
    })
    runtime.hub = runtime.transport.subscribe('/ws/herdr', (event) => {
      if (epoch !== runtime.epoch || this.runtimes.get(id) !== runtime) return
      if (event.type === 'snapshot') {
        const snapshot = readSnapshot(event.snapshot)
        if (snapshot) this.patchHost(id, { snapshot, herdrOnline: true, error: undefined, offlineReason: undefined })
      }
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
    this.discoveryRequestedForOutage.delete(id)
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
    if (this.state.session?.hostId === id) void this.sessions.reload()
    // The tunnel is up and working; that is the moment to look for the same
    // desktop on the local network, so the next connection can skip it.
    this.maybeDiscover(id)
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
    this.clearMedia(host.id)
    for (const key of [...this.uncertain.keys()]) if (key.startsWith(`${host.id}\u0000`)) this.uncertain.delete(key)
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
    const response = readUploadResponse(await this.request(hostId, route, undefined, {
      kind: 'mutation',
      raw: file.bytes,
      headers: {
        'content-type': file.type || 'application/octet-stream',
        'x-alma-filename': encodeURIComponent(file.name),
      },
    }))
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
    const answer = await this.request<Partial<Mutes> | null>(hostId, '/api/herdr/mutes', undefined, { kind: 'read' })
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
    const answer = await this.request<Partial<Mutes> | null>(hostId, '/api/herdr/mutes', body, { kind: 'mutation' })
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
    const answer = await this.request<{ result?: { session_id?: string }; error?: { code?: string; message?: string } }>(
      hostId, '/api/herdr/restart-agent', body, { kind: 'mutation', timeoutMs: CREATE_TIMEOUT_MS },
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
      this.publish({ selectedPaneId: paneId, session: { ...open, items: [], start: -1, end: 0, queued: [], sessionId: undefined, loading: true, unsupported: false, gap: undefined, uncertain: undefined, screen: '', details: undefined, settings: undefined, sentMessage: false } })
      void this.sessions.reload()
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
    const answer = await this.request<{
      agent?: { type?: string; description?: string; finished?: boolean }
      page?: { items?: ChatItem[] }
      error?: { code?: string; message?: string }
    }>(hostId, `/api/herdr/subagent?${query}`, undefined, { kind: 'read' })
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
    const path = imageRequestPath(url)
    const answer = readMediaResponse(await this.request<unknown>(hostId, path, undefined, { kind: 'read', responseType: 'bytes', timeoutMs: 30_000 }))
    if (!answer?.bytes.length) throw new Error(t('图片为空'))
    if (answer.bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error(tWith('图片超过 {size} MB', { size: MAX_ATTACHMENT_MB }))
    return answer
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

  /** Closes a Herdr tab and every pane it owns. */
  closeSession = async (hostId: string, paneId: string): Promise<void> => {
    const open = this.state.session
    const pane = this.state.hosts.find((item) => item.host.id === hostId)?.snapshot?.panes.find((item) => item.pane_id === paneId)
    if (!pane?.tab_id) throw new Error(t('找不到会话'))
    await this.rpc(hostId, 'tab.close', { tab_id: pane.tab_id })
    if (open?.hostId === hostId) {
      const panes = this.state.hosts.find((item) => item.host.id === hostId)?.snapshot?.panes
        .filter((item) => item.tab_id !== pane.tab_id) ?? []
      const currentClosed = open.paneId === paneId || !panes.some((item) => item.pane_id === open.paneId)
      if (currentClosed) this.stopSession()
    }
    // The snapshot follows, but remove the row immediately so a second tap
    // cannot send the same destructive mutation again.
    const host = this.state.hosts.find((item) => item.host.id === hostId)
    if (host?.snapshot) {
      this.patchHost(hostId, {
        snapshot: {
          ...host.snapshot,
          panes: host.snapshot.panes.filter((item) => item.tab_id !== pane.tab_id),
          tabs: host.snapshot.tabs?.filter((item) => item.tab_id !== pane.tab_id),
        },
      })
    }
    if (open?.paneId === paneId) this.publish({ selectedPaneId: undefined, session: undefined })
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
    this.clearMedia(id)
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
      this.clearMedia(id)
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
        await this.request<{ online: boolean }>(id, '/api/herdr/info', undefined, { kind: 'read', timeoutMs: VERIFY_TIMEOUT_MS })
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
    // The route belongs to the transport that is being discarded; keeping it
    // would show "lan" while the replacement is still dialling the relay, and
    // it is also what the discovery early-return reads.
    this.patchHost(id, { retriesLeft: MAX_RETRIES, stopReason: undefined, error: undefined, route: undefined })
    void this.connectHost(id, fresh)
  }

  /** Releases remote pictures for one desktop when its data stops being valid. */
  private clearMedia(hostId: string) {
    this.media.clear(hostId)
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
    // The subnet cache outlives a trip to another app, and a phone that has
    // just re-associated with Wi-Fi can answer with the empty list it had while
    // the link was down. Re-read it once here, so the first dial after a return
    // is judged on the network that exists now rather than the one that existed
    // before the screen turned off.
    forgetSubnets()
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
      this.discoveryRequestedForOutage.delete(id)
      this.patchHost(id, { retriesLeft: MAX_RETRIES, stopReason: undefined, error: undefined, route: undefined })
      void this.connectHost(id, runtime)
    }
  }
  backToSessions = () => { this.stopSession(); this.publish({ selectedPaneId: undefined, session: undefined }) }
  private stopSession() { this.sessions.stop() }
  /** The identity of the pane on screen, captured when a UI action begins. */
  sessionTarget = (): { hostId: string; paneId: string; epoch: number } | undefined => {
    const session = this.state.session
    return session
      ? { hostId: session.hostId, paneId: session.paneId, epoch: this.sessions.epoch }
      : undefined
  }
  selectPane = async (paneId: string) => {
    const hostId = this.state.selectedHostId
    // Report the failure rather than returning silently: a caller that opens a
    // session (a notification tap, a new session) would otherwise believe it
    // succeeded and act on whatever session was opened before — which is how a
    // notification reply ended up in a different conversation.
    if (!hostId || !this.runtimes.has(hostId)) throw new Error(t('节点未连接，无法打开会话'))
    this.publish({ selectedPaneId: paneId })
    await this.sessions.open(hostId, paneId)
    const uncertain = this.uncertaintyFor(hostId, paneId)
    if (uncertain) this.patchSession(this.sessions.epoch, { uncertain })
  }

  /**
   * Fetches the panes either side of this one in the same tab.
   *
   * A swipe is a burst of taps in one direction; having the next pane's rows
   * already in hand turns the second and third swipes into pure paints. Errors
   * are dropped: a prefetch that fails is just a page that arrives later.
   */
  private prefetchNeighbours(paneId: string) {
    const session = this.state.session
    if (!session) return
    const runtime = this.runtimes.get(session.hostId)
    const panes = this.state.hosts.find((item) => item.host.id === session.hostId)?.snapshot?.panes ?? []
    const pane = panes.find((item) => item.pane_id === paneId)
    if (!runtime || !pane?.tab_id) return
    const siblings = panes.filter((item) => item.tab_id === pane.tab_id)
    const index = siblings.findIndex((item) => item.pane_id === paneId)
    for (const neighbour of [siblings[index + 1], siblings[index - 1]]) {
      if (!neighbour) continue
      if (this.sessions.transcripts.has(session.hostId, neighbour.pane_id)) continue
      void this.request<unknown>(session.hostId, `/api/herdr/chat?pane=${encodeURIComponent(neighbour.pane_id)}&limit=${TRANSCRIPT_PAGE}`)
        .then(readChatPage)
        .then((page) => {
          if (page.error || !page.items.length) return
          this.sessions.transcripts.put(session.hostId, neighbour.pane_id, {
            sessionId: page.sessionId,
            items: page.items,
            start: page.start,
            end: page.end,
            queued: page.queued ?? [],
            screen: '',
            settings: readSettings(page.settings),
            at: Date.now(),
          }, this.state.session ? { hostId: this.state.session.hostId, paneId: this.state.session.paneId } : undefined)
        })
        .catch(() => undefined)
    }
  }
  /** Manual retry: drop any scheduled attempt and reload now. */
  reloadSession = () => this.sessions.reload()
  loadOlder = () => this.sessions.loadOlder()

  /**
   * Answers a numbered agent prompt.
   *
   * The screen shown when the user tapped may already be stale, so this
   * re-reads the terminal and requires the parsed menu to match exactly
   * (same question, same labels, same highlighted row) before sending keys.
   * On drift it aborts and refreshes instead of guessing.
   */
  answerPrompt = async (expected: Prompt, optionNumber: number) => {
    const session = this.state.session, epoch = this.sessions.epoch
    if (!session) throw new Error(t('没有打开的会话'))
    if (session.sending) return
    if (session.uncertain) throw new Error(session.uncertain)
    const option = expected.options.find((item) => item.number === optionNumber)
    if (!option) throw new Error(t('选项不存在'))

    const fresh = await this.rpc<{ read?: { text?: string } }>(session.hostId, 'pane.read', { pane_id: session.paneId, source: 'visible', format: 'text' })
    this.assertTarget(this.state.session, session.hostId, session.paneId, epoch)
    if (this.state.session!.uncertain) throw new Error(this.state.session!.uncertain)
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
      const multiSelect = needsSpace(current.options[target])
      const keys = answerKeys(optionNumber, current.cursor, target, multiSelect, moveKeys, t('无法确定光标位置'))
      await this.rpc(session.hostId, 'pane.send_keys', { pane_id: session.paneId, keys: protocolKeys(keys) })
      if (epoch === this.sessions.epoch) await this.readScreen()
    } catch (error) {
      this.rememberUncertain(session.hostId, session.paneId, error)
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
  /**
   * Fetch an image from the paired desktop through the encrypted tunnel.
   *
   * The URL/path originates in agent output, so it is never fetched by
   * `window.fetch` and never allowed to select an arbitrary host. The fixed
   * `/api/herdr/file` route on this host is the only transport destination.
   */
  fetchSessionImage = async (hostId: string, reference: string): Promise<string> => {
    const host = this.state.hosts.find((item) => item.host.id === hostId)?.host
    const runtime = this.runtimes.get(hostId)
    if (!host || !runtime) throw new Error(t('节点不存在'))
    let path: string
    if (reference.startsWith('/api/herdr/image/')) {
      path = reference
    } else if (reference.startsWith('/api/')) {
      if (!reference.startsWith('/api/herdr/file?')) throw new Error(t('不支持的图片地址'))
      path = reference
    } else if (reference.startsWith('/') || reference.startsWith('~/')) {
      path = `/api/herdr/file?path=${encodeURIComponent(reference)}`
    } else {
      throw new Error(t('不支持的图片地址'))
    }
    return this.media.load(hostId, path, () => this.request<{ bytes: Uint8Array; contentType: string }>(hostId, path, undefined, { kind: 'read', responseType: 'bytes' })
      .then(({ bytes, contentType }) => {
        if (!readMediaResponse({ bytes, contentType })) throw new Error(t('远端文件不是图片'))
        if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error(tWith('图片超过 {size} MB', { size: MAX_ATTACHMENT_MB }))
        let binary = ''
        for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
        return `data:${contentType};base64,${btoa(binary)}`
      }))
  }

  /**
   * Targeted cancellation for the agent in the current pane. It is a write,
   * so a lost response remains uncertain and is never replayed.
   */
  stopAgent = async () => {
    const session = this.state.session
    if (!session) throw new Error(t('没有打开的会话'))
    const pane = this.state.hosts.find((item) => item.host.id === session.hostId)?.snapshot?.panes.find((item) => item.pane_id === session.paneId)
    const agent = pane?.agent ?? pane?.agent_session?.agent
    if (!agent) throw new Error(t('此终端没有可停止的 agent'))
    await this.rpc(session.hostId, 'pane.send_keys', { pane_id: session.paneId, keys: ['ctrl+c'] })
    if (this.state.session?.hostId === session.hostId && this.state.session?.paneId === session.paneId) await this.readScreen()
  }

  private async rpc<T>(hostId: string, method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    const response = await this.request<{ result?: T; error?: { code?: string; message?: string } }>(
      hostId,
      '/api/herdr/rpc',
      { method, params },
      timeoutMs === undefined ? undefined : { timeoutMs },
    )
    if (response.error) throw new Error(response.error.message || response.error.code || t('Herdr 操作失败'))
    return response.result as T
  }

  /** The one place ordinary controller code reaches a desktop. */
  private request<T>(hostId: string, path: string, body?: unknown, init?: RequestInit2): Promise<T> {
    const runtime = this.runtimes.get(hostId)
    if (!runtime) return Promise.reject(new Error(t('节点不存在')))
    return runtime.transport.request<T>(path, body, init)
  }
  readScreen = async () => {
    const session = this.state.session, epoch = this.sessions.epoch
    if (!session) return
    try {
      const result = await this.rpc<{ read?: { text?: string } }>(session.hostId, 'pane.read', { pane_id: session.paneId, source: 'visible', format: 'text' })
      this.patchSession(epoch, { screen: result.read?.text ?? '' })
      if (this.state.session?.hostId === session.hostId) void this.readDetail().catch(() => undefined)
    }
    catch (error) { this.patchSession(epoch, { error: message(error) }) }
  }
  /** A second narrow read leaves a rightmost model visible on a phone. */
  private readDetail(): Promise<void> {
    const state = this.state.session
    if (!state) return Promise.resolve()
    const runtime = this.runtimes.get(state.hostId)
    if (!runtime) return Promise.resolve()
    const known = parseSessionInfo(state.screen)
    if (known.model && known.contextRatio !== undefined) return Promise.resolve()
    const epoch = this.sessions.epoch
    void this.request<{ result?: { read?: { text?: string } } }>(
      state.hostId, '/api/herdr/rpc',
      { method: 'pane.read', params: { pane_id: state.paneId, source: 'visible', format: 'text' } },
      { kind: 'read', timeoutMs: VERIFY_TIMEOUT_MS },
    ).then((result) => {
      if (epoch === this.sessions.epoch) this.patchSession(epoch, { details: result.result?.read?.text ?? '' })
    }).catch(() => undefined)
    return Promise.resolve()
  }
  /** True when the call was actually made; false when one was already in flight. */
  private async mutate(
    method: string,
    params: (session: SessionState) => Record<string, unknown>,
    target?: { hostId: string; paneId: string; epoch: number },
  ): Promise<boolean> {
    const session = this.state.session
    const epoch = target?.epoch ?? this.sessions.epoch
    if (!session) throw new Error(t('没有打开的会话'))
    if (target) this.assertTarget(session, target.hostId, target.paneId, target.epoch)
    if (session.sending) return false
    if (session.uncertain) throw new Error(session.uncertain)
    this.patchSession(epoch, { sending: true, error: undefined })
    try {
      await this.rpc(session.hostId, method, params(session))
      if (epoch === this.sessions.epoch) await this.readScreen()
      return true
    }
    catch (error) {
      this.rememberUncertain(session.hostId, session.paneId, error)
      this.patchSession(epoch, { error: message(error), ...(error instanceof OperationUncertainError ? { uncertain: message(error) } : {}) })
      throw error
    }
    finally { this.patchSession(epoch, { sending: false }) }
  }
  /**
   * Records that the user has handed this pane work. That is what turns a
   * missing session id from "the agent is still starting" into "nothing is
   * going to report one", so the pane can say which of the two it is.
   */
  private markSent(epoch: number) { if (epoch === this.sessions.epoch) this.patchSession(epoch, { sentMessage: true }) }
  /** Sends to the pane the user acted on, even if an upload finishes after a switch. */
  sendMessage = async (text: string, target?: { hostId: string; paneId: string; epoch: number }) => {
    if (!text.trim()) return
    const epoch = target?.epoch ?? this.sessions.epoch
    if (await this.mutate('agent.prompt', (s) => ({ target: s.paneId, text }), target)) this.markSent(epoch)
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
    const session = this.state.session, epoch = this.sessions.epoch
    if (!session) throw new Error(t('没有打开的会话'))
    if (session.sending) return
    if (session.uncertain) throw new Error(session.uncertain)
    this.patchSession(epoch, { sending: true, error: undefined })
    try {
      await this.rpc(session.hostId, 'pane.send_text', { pane_id: session.paneId, text })
      if (epoch === this.sessions.epoch) await this.readScreen()
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
    const multiSelect = needsSpace(menu.options[target])
    const keys = answerKeys(optionNumber, menu.cursor, target, multiSelect, moveKeys, t('无法确定光标位置'))
    await this.rpc(hostId, 'pane.send_keys', { pane_id: paneId, keys: protocolKeys(keys) })
  }

  sendKeys = async (keys: string[], target?: { hostId: string; paneId: string; epoch: number }) => {
    if (!validTerminalKeys(keys)) throw new Error(t('不支持的终端按键'))
    await this.mutate('pane.send_keys', (s) => ({ pane_id: s.paneId, keys: terminalKeys(keys) }), target)
  }
  sendTerminalText = async (text: string, target?: { hostId: string; paneId: string; epoch: number }) => {
    const session = this.state.session, epoch = this.sessions.epoch
    if (!session) throw new Error(t('没有打开的会话'))
    if (target) this.assertTarget(session, target.hostId, target.paneId, target.epoch)
    if (session.sending || !text) return
    if (session.uncertain) throw new Error(session.uncertain)
    this.patchSession(epoch, { sending: true, error: undefined })
    let textSent = false
    try {
      await this.rpc(session.hostId, 'pane.send_text', { pane_id: session.paneId, text: bracketedTerminalText(text) })
      textSent = true
      await this.rpc(session.hostId, 'pane.send_keys', { pane_id: session.paneId, keys: ['enter'] })
      if (epoch === this.sessions.epoch) await this.readScreen()
      this.markSent(epoch)
    } catch (error) {
      const uncertain = error instanceof OperationUncertainError || textSent
      this.patchSession(epoch, { error: message(error), ...(uncertain ? { uncertain: t('终端输入可能已部分执行，请核对画面后重新打开会话。') } : {}) })
      throw error
    } finally { this.patchSession(epoch, { sending: false }) }
  }
  dispose() {
    this.stopSession()
    this.abortScans()
    this.media.clearAll()
    this.sessions.transcripts.clear()
    const runtimes = [...this.runtimes.values()]
    this.runtimes.clear()
    for (const runtime of runtimes) this.closeRuntime(runtime)
  }
}
export const controller = new Controller()
