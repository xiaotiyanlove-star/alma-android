import { base64url, constantTimeEqual, createKeyPair, deriveSessionKeys, fromBase64url, openBytes, routingId, sealBytes } from './crypto'
import { BINARY_FRAMES_FIELD, decodeInnerFrame, encodeInnerFrame } from './frames'
import type { Host } from '../core/model'
import { lanUrl, usableLanAddress, type LanAddress } from './lan'

/**
 * How long a direct attempt gets before the relay takes over.
 *
 * A reachable LAN answers in single-digit milliseconds, so this only bounds
 * the case where the phone is not on that network at all. Kept short: it is
 * paid on every connect while away from home.
 */
const DIRECT_DIAL_MS = 2_000
/** Once the socket opens, the paired desktop must prove itself quickly too. */
const DIRECT_HANDSHAKE_MS = 3_000
/**
 * How long the platform may take to vouch for a local address.
 *
 * The answer comes from a native bridge call, and a bridge call can stall or
 * lose its callback — most easily while the page is being frozen or resumed.
 * This wait sits in front of *both* dials, so an unanswered one used to stall
 * the relay behind it and leave the desktop unreachable until the app was
 * restarted. Timing out means "not verified", which refuses the plain-text
 * dial and lets the relay proceed immediately; it never widens what may be
 * dialled.
 */
const DIRECT_GATE_MS = 2_000
import { withDeadline } from './deadline'
import { t } from '../platform/i18n'

type Frame = Record<string, any>
export interface SocketLike {
  binaryType: string; readyState: number
  send(data: string | Uint8Array): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: (() => void) | null
  onclose: (() => void) | null
}
export interface TunnelSocket { close(): void }

/** Transport failure with a code that survives translation. */
export class TunnelError extends Error {
  constructor(readonly code: 'auth' | 'unknown-host' | 'network', message: string) {
    super(message)
    this.name = 'TunnelError'
  }
}

/** The status callback reports the code so callers never parse a message. */
export type StatusSink = (state: 'connecting' | 'online' | 'offline', error?: string, code?: TunnelError['code']) => void
/**
 * The server answered and refused. This is a definite outcome, unlike a
 * dropped connection: nothing ran, so the caller may retry or explain.
 */
export class RejectedError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'RejectedError' }
}
export class OperationUncertainError extends Error {
  constructor() { super('连接中断或超时，操作可能已执行。请先检查会话，勿直接重复发送。') }
}
interface Pending {
  mutation: boolean; sent: boolean; status: number; chunks: Uint8Array[]
  /** Headers from `hres`; the image route's content type lives here. */
  headers: Record<string, string>
  /** `bytes` keeps the body opaque instead of parsing it as JSON. */
  responseType: 'json' | 'bytes'
  timer: ReturnType<typeof setTimeout>; resolve(value: unknown): void; reject(error: Error): void
}

/** What a `responseType: 'bytes'` request resolves to. */
export interface BinaryResponse {
  bytes: Uint8Array
  /** As sent by the desktop, lowercased; empty when it named none. */
  contentType: string
}
interface Subscription { path: string; receive(frame: Frame): void; onClose(): void }
/** Extra options for requests whose payload is not a JSON body. */
export interface RequestInit2 {
  /** Bytes to send as the body, used for uploads. */
  raw?: Uint8Array
  headers?: Record<string, string>
  /**
   * Whether this call can change state on the desktop.
   *
   * It is declared explicitly rather than inferred from "has a body": an upload
   * carries bytes but must count as a mutation, while a body-less RPC can still
   * be one. Getting this wrong either retries a destructive call or refuses to
   * retry a harmless read.
   */
  kind?: 'read' | 'mutation'
  /**
   * Deadline for this call. A create that waits for an agent to become
   * interactive legitimately takes longer than a read, and the default is
   * tuned for reads.
   */
  timeoutMs?: number
  /**
   * What a 2xx body is. Everything the Herdr API answers is JSON except the
   * image route, which returns the picture itself; asking for bytes keeps the
   * caller from having to guess and losing the content type.
   */
  responseType?: 'json' | 'bytes'
  /**
   * The HTTP verb for a mutation, when the route is not POST.
   *
   * Most mutations are POST and that stays the default. A few Alma routes are
   * REST-shaped instead: `/api/herdr/mutes` is updated with PUT, and sending it
   * POST reaches Express's 404 — the tunnel is healthy, the request is valid,
   * and the desktop still refuses it. The verb belongs to the caller because
   * only the route knows it; the transport must not guess from the body.
   */
  method?: 'POST' | 'PUT' | 'DELETE'
}
export interface Transport {
  connect(): Promise<void>
  request<T>(path: string, body?: unknown, init?: RequestInit2): Promise<T>
  subscribe(path: string, receive: (frame: Frame) => void, onClose: () => void): TunnelSocket
  /** When anything last arrived from the desktop, for liveness checks. */
  lastInboundAt(): number
  close(): void
}

// Owns one connection generation. Nothing from a dead generation is replayed.
export class EncryptedTunnel implements Transport {
  private ws?: SocketLike
  private keys?: Awaited<ReturnType<typeof deriveSessionKeys>>
  private nonce = new Uint8Array(16)
  private counter = 0n
  /** Expected inbound nonce; resets with each connection generation. */
  private recvCounter = 0n
  /** Both sides offered binary inner frames during the handshake. */
  private binary = false
  private ready = false
  private stopped = false
  private epoch = 0
  private connectPromise?: Promise<void>
  private connectResolve?: () => void
  private connectReject?: (error: Error) => void
  private handshakeTimer?: ReturnType<typeof setTimeout>
  private incoming = Promise.resolve()
  private outgoing = Promise.resolve()
  private pending = new Map<string, Pending>()
  private subscriptions = new Map<string, Subscription>()
  /**
   * Bytes queued for the socket but not yet handed to it; a send in flight.
   *
   * A queued send is not evidence of a dead tunnel, so the probe skips while
   * one is outstanding — but only briefly: see `startHeartbeat`.
   */
  private queued = 0
  /**
   * When the last frame arrived from the desktop.
   *
   * A socket that is dead can still report `readyState === 1`: the close event
   * never ran because the page was frozen, or a Wi-Fi link vanished without a
   * FIN. Only the absence of traffic proves it, so this is the input the
   * liveness check reads.
   */
  private inboundAt = 0
  /** Set while a liveness probe is outstanding, and when it started. */
  private probing = 0
  private probeTimer?: ReturnType<typeof setInterval>
  constructor(private host: Host, private status: StatusSink, private socketFactory: (url: string) => SocketLike = (url) => new WebSocket(url) as unknown as SocketLike, private timeoutMs = 20_000) {}

  lastInboundAt(): number { return this.inboundAt }

  /**
   * How often an idle link is checked, and how long a silent one may stay
   * silent before it is declared dead.
   *
   * A relay connection can die without either end noticing: the phone's radio
   * sleeps, the relay drops the socket, and no `close` event is ever delivered
   * because the page was frozen. Without this the user sees "connected" until
   * their next message times out. The desktop's own client uses the same
   * shape — ping every 20 s, give up after one unanswered probe.
   */
  static readonly PROBE_EVERY_MS = 2_000
  static readonly SILENCE_LIMIT_MS = 6_000
  static readonly PROBE_TIMEOUT_MS = 3_000
  /**
   * How long an unanswered request may hold off the probe.
   *
   * A pending request is normally a reason to wait, not to probe: an upload
   * legitimately outlives the silence limit. But a request that hangs is
   * exactly the failure this exists to catch, and a request deadline is 20 s —
   * five times the probe cadence — so waiting for it would blind the probe for
   * the whole window that matters. Past this, silence wins.
   */
  static readonly PENDING_GRACE_MS = 3_000

  /**
   * Starts the idle probe.
   *
   * The cadence is a parameter so a test can exercise the decision without
   * waiting twenty real seconds. Production always calls this with no
   * arguments. Returns a stop function; calling it twice is harmless, so a
   * runtime can be torn down by whichever path notices first.
   */
  startHeartbeat(options: { everyMs?: number; silenceMs?: number; graceMs?: number; probeTimeoutMs?: number } = {}): () => void {
    if (this.probeTimer) return () => this.stopHeartbeat()
    const everyMs = options.everyMs ?? EncryptedTunnel.PROBE_EVERY_MS
    const silenceMs = options.silenceMs ?? EncryptedTunnel.SILENCE_LIMIT_MS
    const graceMs = options.graceMs ?? EncryptedTunnel.PENDING_GRACE_MS
    const probeTimeoutMs = options.probeTimeoutMs ?? EncryptedTunnel.PROBE_TIMEOUT_MS
    this.inboundAt = Date.now()
    this.probeTimer = setInterval(() => {
      if (!this.ready || this.stopped) return
      const current = Date.now()
      // A silent probe itself gets a short deadline; the ordinary request
      // deadline is deliberately longer and is not allowed to hold this test
      // open for twenty seconds.
      if (this.probing) {
        if (current - this.probing < probeTimeoutMs) return
        this.fail(new TunnelError('network', t('连接已无响应，正在重连')))
        return
      }
      if (current - this.inboundAt < silenceMs) return
      // A mutation or upload may legitimately take a long time, so don't
      // destroy it just because the remote is quiet. Read-only hangs get a
      // short grace, after which a probe is safe and a failed probe rebuilds.
      const hasMutation = [...this.pending.values()].some((item) => item.mutation)
      if (hasMutation || this.queued > 0) return
      if (this.pending.size > 0 && current - this.inboundAt < silenceMs + graceMs) return
      this.probing = current
      void this.request<unknown>('/api/herdr/info', undefined, { kind: 'read', timeoutMs: probeTimeoutMs }).then(
        () => { this.probing = 0 },
        () => {
          if (this.probing && Date.now() - this.probing >= probeTimeoutMs) {
            this.fail(new TunnelError('network', t('连接已无响应，正在重连')))
          } else this.probing = 0
        },
      )
    }, everyMs) as unknown as ReturnType<typeof setInterval> & { unref?: () => void }
    ;(this.probeTimer as any).unref?.()
    return () => this.stopHeartbeat()
  }
  private stopHeartbeat() {
    if (!this.probeTimer) return
    clearInterval(this.probeTimer)
    this.probeTimer = undefined
    this.probing = 0
  }

  connect(): Promise<void> {
    if (this.ready) return Promise.resolve()
    if (this.stopped) return Promise.reject(new Error('节点连接已关闭'))
    if (this.connectPromise) return this.connectPromise
    const epoch = ++this.epoch
    this.status('connecting')
    const promise = new Promise<void>((resolve, reject) => { this.connectResolve = resolve; this.connectReject = reject })
    this.connectPromise = promise
    this.handshakeTimer = setTimeout(() => this.fail(new Error(t('加密连接超时，请检查桌面和中继是否在线'))), this.timeoutMs)
    void this.dial(epoch).catch((error) => { if (epoch === this.epoch) this.fail(error instanceof Error ? error : new Error('连接失败')) })
    return promise
  }

  /**
   * The path the current generation is using, once it is known.
   *
   * `undefined` while dialling, then whichever opened. Reported so the UI can
   * say where a connection actually goes — the difference in latency is
   * invisible otherwise, and a failing direct path is otherwise indistinguishable
   * from a slow relay.
   */
  private route?: 'direct' | 'relay'

  /** Where the direct attempt went, when this host has one configured. */
  private direct?: LanAddress

  /**
   * Decides whether a direct address may be dialled at all.
   *
   * Injected rather than imported so the transport stays free of platform
   * calls, and so a test can state the answer outright. The rule it implements
   * is the one that makes plain text acceptable: the address must sit on a
   * subnet this phone is actually attached to.
   */
  private allowDirect: (address: LanAddress) => Promise<boolean> = async () => false

  /**
   * Uses a local address before the relay.
   *
   * Only ever a preference: the relay stays the fallback for every failure,
   * because the phone spends most of its life away from the desktop's network
   * and a connection that only works at home would be worse than none.
   */
  useDirect(address: LanAddress | undefined, allow?: (address: LanAddress) => Promise<boolean>) {
    this.direct = usableLanAddress(address) ? address : undefined
    if (allow) this.allowDirect = allow
  }

  currentRoute(): 'direct' | 'relay' | undefined { return this.route }

  /**
   * Whether a mutation or an upload has been handed to this tunnel.
   *
   * A route can be swapped underneath a session only while nothing is in
   * flight: a read can be replayed on the new tunnel, but a mutation that was
   * sent and never acknowledged is exactly the case the app reports as
   * uncertain, and moving it would invent an answer nobody gave.
   */
  busy(): boolean {
    if (this.queued > 0) return true
    return [...this.pending.values()].some((item) => item.mutation)
  }

  /** Called once per connection with the path that actually opened. */
  onRoute?: (route: 'direct' | 'relay') => void

  /** Called when a direct attempt was abandoned in favour of the relay. */
  onDirectFailed?: () => void

  private async dial(epoch: number) {
    const [id, pair] = await Promise.all([routingId(this.host.connectCode), createKeyPair()])
    if (epoch !== this.epoch || this.stopped) return
    this.nonce = crypto.getRandomValues(new Uint8Array(16))
    this.counter = 0n
    this.recvCounter = 0n
    this.binary = false
    this.keys = undefined
    this.inboundAt = 0
    this.incoming = Promise.resolve()
    this.outgoing = Promise.resolve()
    this.route = undefined
    const relayUrl = `${this.host.relayUrl.replace(/^https:/, 'wss:')}/c/${id}/__alma_e2e__`
    // A direct attempt gets a short head start, not a long one. On a reachable
    // LAN it opens in single-digit milliseconds; the wait only ever costs
    // something on a phone that is nowhere near the desktop, and that cost is
    // paid once per connect.
    const direct = this.direct
    if (!usableLanAddress(direct)) { this.attach(this.socketFactory(relayUrl), epoch, pair, 'relay'); return }
    // Plain text is only ever allowed once the platform has confirmed the
    // desktop shares a subnet with this phone. A configured address that fails
    // that check is not "tried and falls back" — it is never dialled.
    const allowed = await withDeadline(this.allowDirect(direct), DIRECT_GATE_MS, false)
    if (!allowed || epoch !== this.epoch || this.stopped) {
      this.attach(this.socketFactory(relayUrl), epoch, pair, 'relay')
      return
    }
    const socket = this.socketFactory(lanUrl(direct, '/__alma_e2e__'))
    socket.binaryType = 'arraybuffer'
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const fallback = (force = false) => {
      if ((settled && !force) || epoch !== this.epoch) return
      settled = true
      if (timer) clearTimeout(timer)
      // Silence the abandoned attempt: its events must never reach `fail`.
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null
      try { socket.close() } catch { /* already gone */ }
      // A failure is only counted against the address when the address itself
      // failed to answer. Once the tunnel was up, a drop is a connection
      // problem — the phone slept, the socket was reset — and the address is
      // still perfectly good. Counting those suspended the direct route for
      // half an hour after two ordinary disconnects, which is why a session
      // that started on `lan` stayed on `relay` for the rest of the day.
      if (!this.ready) this.onDirectFailed?.()
      this.attach(this.socketFactory(relayUrl), epoch, pair, 'relay')
    }
    timer = setTimeout(fallback, DIRECT_DIAL_MS)
    socket.onopen = () => {
      if (settled || epoch !== this.epoch) return
      settled = true
      if (timer) clearTimeout(timer)
      this.attach(socket, epoch, pair, 'direct', () => {
        // Only the still-current direct socket may trigger fallback: a late
        // event from a candidate already abandoned must not replace the relay.
        if (this.ws === socket) fallback(true)
      })
      // The socket is already open when `attach` runs, and a real WebSocket
      // does not re-fire `open`, so the greeting has to be sent from here.
      this.ws?.send(JSON.stringify({ t: 'hi', epk: base64url(pair.publicKey), n: base64url(this.nonce), [BINARY_FRAMES_FIELD]: 1 }))
    }
    socket.onerror = fallback
    socket.onclose = fallback
  }


  /**
   * Wires one socket up as the current connection generation.
   *
   * Separated from `dial` because a direct attempt and its relay fallback both
   * need identical handling — the security checks in particular must not be
   * weaker on either path. Whatever a direct peer claims about itself is worth
   * nothing until the pairing confirmation matches.
   */
  private attach(
    socket: SocketLike,
    epoch: number,
    pair: Awaited<ReturnType<typeof createKeyPair>>,
    route: 'direct' | 'relay',
    onDirectRejected?: () => void,
  ) {
    const greeting = JSON.stringify({ t: 'hi', epk: base64url(pair.publicKey), n: base64url(this.nonce), [BINARY_FRAMES_FIELD]: 1 })
    let directHandshakeTimer: ReturnType<typeof setTimeout> | undefined
    const rejectDirect = () => {
      if (directHandshakeTimer) clearTimeout(directHandshakeTimer)
      directHandshakeTimer = undefined
      if (route === 'direct' && onDirectRejected && this.ws === socket) onDirectRejected()
    }
    if (route === 'direct' && onDirectRejected) {
      directHandshakeTimer = setTimeout(rejectDirect, DIRECT_HANDSHAKE_MS)
    }
    this.route = route
    socket.binaryType = 'arraybuffer'
    this.ws = socket
    socket.onopen = () => {
      if (epoch !== this.epoch) return
      socket.send(greeting)
    }
    socket.onmessage = ({ data }) => {
      this.incoming = this.incoming.then(async () => {
        if (epoch !== this.epoch) return
        // Any inbound frame, even one that turns out to be malformed, proves
        // the link still carries traffic.
        this.inboundAt = Date.now()
        if (!this.ready) {
          if (typeof data !== 'string') throw new Error('无效的加密握手')
          const hello = JSON.parse(data)
          if (hello.t !== 'hi' || typeof hello.epk !== 'string' || typeof hello.n !== 'string' || typeof hello.cr !== 'string') throw new Error(t('桌面拒绝或不支持此握手'))
          const peer = fromBase64url(hello.epk), nonce = fromBase64url(hello.n)
          if (peer.length !== 65 || nonce.length !== 16) throw new Error('握手参数长度无效')
          const keys = await deriveSessionKeys({ connectCode: this.host.connectCode, myPrivateKey: pair.privateKey, peerPublic: peer, initiatorPublic: pair.publicKey, responderPublic: peer, initiatorNonce: this.nonce, responderNonce: nonce })
          if (epoch !== this.epoch) return
          if (!constantTimeEqual(fromBase64url(hello.cr), keys.confirmResponder)) {
            if (route === 'direct' && onDirectRejected) { rejectDirect(); return }
            throw new TunnelError('auth', t('配对验证失败，请重新导入配对链接'))
          }
          if (directHandshakeTimer) clearTimeout(directHandshakeTimer)
          // The desktop echoes `bin: 1` only when it supports the binary form;
          // without it we keep sending JSON, which every peer understands.
          this.binary = hello[BINARY_FRAMES_FIELD] === 1
          socket.send(JSON.stringify({ t: 'ok', ci: base64url(keys.confirmInitiator), ...(this.binary ? { [BINARY_FRAMES_FIELD]: 1 } : {}) }))
          this.keys = keys
          this.ready = true
          this.inboundAt = Date.now()
          clearTimeout(this.handshakeTimer)
          this.connectResolve?.()
          this.connectResolve = undefined; this.connectReject = undefined
          // Only a completed handshake counts as reaching the desktop: opening
          // a TCP socket proves nothing about what answered on it.
          this.onRoute?.(route)
          this.status('online')
        } else {
          if (typeof data === 'string') throw new Error(t('收到未加密的数据帧'))
          const bytes = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : null
          if (!bytes || bytes.length > 32 * 1024 * 1024) throw new Error('数据帧无效或过大')
          this.inboundAt = Date.now()
          const frame = decodeInnerFrame(await openBytes(this.keys!.s2c, bytes, this.recvCounter))
          this.recvCounter++
          if (epoch === this.epoch) this.handle(frame as Frame)
        }
      }).catch((error) => {
        if (epoch !== this.epoch) return
        // The LAN scan intentionally finds every Alma-compatible responder,
        // not just this pairing. A neighbour's Alma can answer `hi` with a
        // valid key but a confirmation from its own pairing code. Malformed
        // replies and invalid points are likewise just "not our desktop" on
        // this untrusted candidate. Fall back rather than letting any
        // same-subnet service break the relay path. Relay auth failures remain
        // fatal: only the direct candidate gets this treatment.
        if (route === 'direct' && onDirectRejected && !this.ready) { rejectDirect(); return }
        this.fail(error instanceof Error ? error : new Error(t('加密数据错误')))
      })
    }
    socket.onerror = () => { if (epoch === this.epoch) this.fail(new TunnelError('network', t('中继连接失败'))) }
    socket.onclose = () => { if (epoch === this.epoch) this.fail(new Error(t('连接已断开'))) }
  }
  private send(frame: Frame): Promise<void> {
    const epoch = this.epoch
    this.queued++
    const next = this.outgoing.then(async () => {
      if (!this.ready || !this.keys || !this.ws || epoch !== this.epoch) throw new Error(t('连接已断开'))
      // A socket that died without firing `close` — the page was frozen when
      // the relay dropped it — still looks open here. Sending into it is a
      // silent no-op, so the request would sit until its timeout; report the
      // failure now, while the caller can still reconnect promptly.
      if (this.ws.readyState !== 1) {
        this.fail(new TunnelError('network', t('连接已断开')))
        throw new Error(t('连接已断开'))
      }
      const wire = await sealBytes(this.keys.c2s, this.counter++, encodeInnerFrame(frame, this.binary))
      if (epoch !== this.epoch || !this.ready) throw new Error(t('连接已断开'))
      this.ws.send(wire)
    })
    this.outgoing = next.catch(() => undefined).finally(() => { this.queued = Math.max(0, this.queued - 1) })
    return next
  }
  /**
   * `raw` sends the bytes as-is (used for uploads, where the desktop reads the
   * body rather than a JSON wrapper). Callers supply the content type.
   */
  async request<T>(path: string, body?: unknown, init?: RequestInit2): Promise<T> {
    await this.connect()
    const id = crypto.randomUUID()
    return new Promise<T>((resolve, reject) => {
      // Explicit when the caller knows; a bare body still means a mutation.
      const mutation = init?.kind ? init.kind === 'mutation' : body !== undefined
      const timer = setTimeout(() => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        reject(pending.mutation && pending.sent ? new OperationUncertainError() : new Error(t('桌面接口超时')))
        void this.send({ t: 'hcancel', id }).catch(() => undefined)
      }, init?.timeoutMs ?? this.timeoutMs)
      const pending: Pending = {
        mutation, sent: false, status: 0, chunks: [], headers: {}, responseType: init?.responseType ?? 'json',
        timer, resolve: resolve as (value: unknown) => void, reject,
      }
      this.pending.set(id, pending)
      // Mark conservatively before send: a transport exception cannot prove non-delivery.
      pending.sent = true
      // The body stays bytes; `encodeInnerFrame` picks base64 or the binary form.
      // Uploads pass `init.raw` with their own headers.
      const payload = init?.raw ?? (mutation ? new TextEncoder().encode(JSON.stringify(body)) : undefined)
      const headers = init?.raw ? { ...(init.headers ?? {}) } : mutation ? { 'content-type': 'application/json' } : {}
      // The verb is the caller's, not the payload's. Defaulting every body to
      // POST was right for the RPC and upload routes and wrong for the two
      // REST-shaped ones (`PUT /mutes`, `PUT live-activity`): those answered
      // Express's 404 while the UI reported a vague failure.
      const method = payload ? (init?.method ?? 'POST') : 'GET'
      void this.send({ t: 'hreq', id, method, path, headers, ...(payload ? { b: payload } : {}) }).catch(() => {
        if (!this.pending.delete(id)) return
        clearTimeout(timer)
        reject(mutation ? new OperationUncertainError() : new Error('请求未完成，连接已断开'))
      })
    })
  }
  subscribe(path: string, receive: (frame: Frame) => void, onClose: () => void): TunnelSocket {
    const id = crypto.randomUUID()
    this.subscriptions.set(id, { path, receive, onClose })
    void this.connect().then(() => this.subscriptions.has(id) ? this.send({ t: 'wopen', id, path }) : undefined).catch(() => this.endSubscription(id))
    return { close: () => { if (this.subscriptions.delete(id) && this.ready) void this.send({ t: 'wclose', id }).catch(() => undefined) } }
  }
  private endSubscription(id: string) {
    const subscription = this.subscriptions.get(id)
    this.subscriptions.delete(id)
    subscription?.onClose()
  }
  private handle(frame: Frame) {
    const id = String(frame.id || '')
    const pending = this.pending.get(id)
    if (pending) {
      if (frame.t === 'hres') {
        pending.status = Number(frame.status)
        // Header names are not case-normalised on the wire; the body route's
        // content type is the one field that matters here.
        for (const [name, value] of Object.entries((frame.headers ?? {}) as Record<string, unknown>)) {
          if (typeof value === 'string') pending.headers[name.toLowerCase()] = value
        }
      }
      if (frame.t === 'hchunk') {
        const chunk = typeof frame.b === 'string' ? fromBase64url(frame.b) : frame.b
        if (!(chunk instanceof Uint8Array)) { this.fail(new Error(t('接口响应格式无效'))); return }
        pending.chunks.push(chunk)
        if (pending.chunks.reduce((n, part) => n + part.length, 0) > 32 * 1024 * 1024) { this.fail(new Error(t('接口响应过大'))); return }
      }
      if (frame.t === 'hend' || frame.t === 'herr') {
        this.pending.delete(id); clearTimeout(pending.timer)
        if (frame.t === 'herr') { pending.reject(pending.mutation ? new OperationUncertainError() : new Error(t('桌面转发请求失败'))); return }
        const bytes = new Uint8Array(pending.chunks.reduce((n, c) => n + c.length, 0))
        let offset = 0
        for (const chunk of pending.chunks) { bytes.set(chunk, offset); offset += chunk.length }
        // A sent mutation may already have run when the *connection* failed —
        // but a response the server actually sent proves the request reached
        // it and was answered. A 4xx, in particular, was refused before doing
        // anything, so retrying is safe and calling it uncertain is a lie that
        // stops the user from trying again.
        if (pending.status < 200 || pending.status >= 300) {
          const definite = pending.status >= 400 && pending.status < 500 && pending.status !== 408 && pending.status !== 429
          if (pending.mutation && !definite) { pending.reject(new OperationUncertainError()); return }
          const detail = (() => {
            try { return String(JSON.parse(new TextDecoder().decode(bytes))?.error?.message ?? '') } catch { return '' }
          })()
          pending.reject(new RejectedError(pending.status, detail || `桌面接口返回 HTTP ${pending.status}`))
          return
        }
        // A binary response is the caller's payload as-is; converting it to
        // text first would corrupt every byte that is not valid UTF-8.
        if (pending.responseType === 'bytes') {
          pending.resolve({ bytes, contentType: pending.headers['content-type'] ?? '' } satisfies BinaryResponse)
          return
        }
        try { pending.resolve(bytes.length ? JSON.parse(new TextDecoder().decode(bytes)) : null) } catch { pending.reject(pending.mutation ? new OperationUncertainError() : new Error(t('桌面接口返回格式无效'))) }
      }
      return
    }
    const subscription = this.subscriptions.get(id)
    if (!subscription) return
    if (frame.t === 'wclose' || frame.t === 'werr') this.endSubscription(id)
    if (frame.t === 'wmsg' && typeof frame.s === 'string') {
      try { subscription.receive(JSON.parse(frame.s)) } catch { /* Ignore malformed events without exposing content. */ }
    }
  }
  private fail(error: Error) {
    ++this.epoch
    // The generation is over; a later probe would only report on the socket
    // that no longer exists. `connect()` starts a fresh one for the next dial.
    // The interval is cleared with it: `startHeartbeat` refuses to start a
    // second one, so leaving it running means every later connection keeps an
    // interval that ticks forever against a transport nobody is using.
    this.stopHeartbeat()
    clearTimeout(this.handshakeTimer)
    this.ready = false
    const socket = this.ws
    this.ws = undefined; this.keys = undefined
    if (socket) { socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null; socket.close() }
    this.connectReject?.(error)
    this.connectResolve = undefined; this.connectReject = undefined; this.connectPromise = undefined
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(pending.mutation && pending.sent ? new OperationUncertainError() : error) }
    this.pending.clear()
    for (const id of [...this.subscriptions.keys()]) this.endSubscription(id)
    this.status('offline', error.message, error instanceof TunnelError ? error.code : undefined)
  }
  close() { this.stopped = true; this.stopHeartbeat(); this.fail(new Error('节点连接已关闭')) }
}
