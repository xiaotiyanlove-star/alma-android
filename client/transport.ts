import { base64url, constantTimeEqual, createKeyPair, deriveSessionKeys, fromBase64url, openFrame, routingId, sealFrame } from './crypto'
import type { Host } from './model'
import { t } from './i18n'

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
export class OperationUncertainError extends Error {
  constructor() { super('连接中断或超时，操作可能已执行。请先检查会话，勿直接重复发送。') }
}
interface Pending {
  mutation: boolean; sent: boolean; status: number; chunks: Uint8Array[]
  timer: ReturnType<typeof setTimeout>; resolve(value: unknown): void; reject(error: Error): void
}
interface Subscription { path: string; receive(frame: Frame): void; onClose(): void }
/** Extra options for requests whose payload is not a JSON body. */
export interface RequestInit2 { raw?: Uint8Array; headers?: Record<string, string> }
export interface Transport {
  connect(): Promise<void>
  request<T>(path: string, body?: unknown, init?: RequestInit2): Promise<T>
  subscribe(path: string, receive: (frame: Frame) => void, onClose: () => void): TunnelSocket
  close(): void
}

// Owns one connection generation. Nothing from a dead generation is replayed.
export class EncryptedTunnel implements Transport {
  private ws?: SocketLike
  private keys?: Awaited<ReturnType<typeof deriveSessionKeys>>
  private nonce = new Uint8Array(16)
  private keyPair?: Awaited<ReturnType<typeof createKeyPair>>
  private counter = 0n
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
  constructor(private host: Host, private status: (state: 'connecting' | 'online' | 'offline', error?: string) => void, private socketFactory: (url: string) => SocketLike = (url) => new WebSocket(url) as unknown as SocketLike, private timeoutMs = 20_000) {}

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
  private async dial(epoch: number) {
    const [id, pair] = await Promise.all([routingId(this.host.connectCode), createKeyPair()])
    if (epoch !== this.epoch || this.stopped) return
    this.keyPair = pair
    this.nonce = crypto.getRandomValues(new Uint8Array(16))
    this.counter = 0n
    this.keys = undefined
    this.incoming = Promise.resolve()
    this.outgoing = Promise.resolve()
    const socket = this.socketFactory(`${this.host.relayUrl.replace(/^https:/, 'wss:')}/c/${id}/__alma_e2e__`)
    socket.binaryType = 'arraybuffer'
    this.ws = socket
    socket.onopen = () => {
      if (epoch !== this.epoch) return
      socket.send(JSON.stringify({ t: 'hi', epk: base64url(pair.publicKey), n: base64url(this.nonce) }))
    }
    socket.onmessage = ({ data }) => {
      this.incoming = this.incoming.then(async () => {
        if (epoch !== this.epoch) return
        if (!this.ready) {
          if (typeof data !== 'string') throw new Error('无效的加密握手')
          const hello = JSON.parse(data)
          if (hello.t !== 'hi' || typeof hello.epk !== 'string' || typeof hello.n !== 'string' || typeof hello.cr !== 'string') throw new Error(t('桌面拒绝或不支持此握手'))
          const peer = fromBase64url(hello.epk), nonce = fromBase64url(hello.n)
          if (peer.length !== 65 || nonce.length !== 16) throw new Error('握手参数长度无效')
          const keys = await deriveSessionKeys({ connectCode: this.host.connectCode, myPrivateKey: pair.privateKey, peerPublic: peer, initiatorPublic: pair.publicKey, responderPublic: peer, initiatorNonce: this.nonce, responderNonce: nonce })
          if (epoch !== this.epoch) return
          if (!constantTimeEqual(fromBase64url(hello.cr), keys.confirmResponder)) throw new Error(t('配对验证失败，请重新导入配对链接'))
          socket.send(JSON.stringify({ t: 'ok', ci: base64url(keys.confirmInitiator) }))
          this.keys = keys
          this.ready = true
          clearTimeout(this.handshakeTimer)
          this.connectResolve?.()
          this.connectResolve = undefined; this.connectReject = undefined
          this.status('online')
        } else {
          if (typeof data === 'string') throw new Error(t('收到未加密的数据帧'))
          const bytes = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : null
          if (!bytes || bytes.length > 32 * 1024 * 1024) throw new Error('数据帧无效或过大')
          const frame = await openFrame(this.keys!.s2c, bytes)
          if (epoch === this.epoch) this.handle(frame as Frame)
        }
      }).catch((error) => { if (epoch === this.epoch) this.fail(error instanceof Error ? error : new Error(t('加密数据错误'))) })
    }
    socket.onerror = () => { if (epoch === this.epoch) this.fail(new Error(t('中继连接失败'))) }
    socket.onclose = () => { if (epoch === this.epoch) this.fail(new Error(t('连接已断开'))) }
  }
  private send(frame: Frame): Promise<void> {
    const epoch = this.epoch
    const next = this.outgoing.then(async () => {
      if (!this.ready || !this.keys || !this.ws || epoch !== this.epoch) throw new Error(t('连接已断开'))
      const wire = await sealFrame(this.keys.c2s, this.counter++, frame)
      if (epoch !== this.epoch || !this.ready) throw new Error(t('连接已断开'))
      this.ws.send(wire)
    })
    this.outgoing = next.catch(() => undefined)
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
      const mutation = body !== undefined
      const timer = setTimeout(() => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        reject(pending.mutation && pending.sent ? new OperationUncertainError() : new Error(t('桌面接口超时')))
        void this.send({ t: 'hcancel', id }).catch(() => undefined)
      }, this.timeoutMs)
      const pending: Pending = { mutation, sent: false, status: 0, chunks: [], timer, resolve: resolve as (value: unknown) => void, reject }
      this.pending.set(id, pending)
      // Mark conservatively before send: a transport exception cannot prove non-delivery.
      pending.sent = true
      const payload = init?.raw ?? (mutation ? new TextEncoder().encode(JSON.stringify(body)) : undefined)
      const headers = init?.raw ? { ...(init.headers ?? {}) } : mutation ? { 'content-type': 'application/json' } : {}
      void this.send({ t: 'hreq', id, method: payload ? 'POST' : 'GET', path, headers, ...(payload ? { b: base64url(payload) } : {}) }).catch(() => {
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
      if (frame.t === 'hres') pending.status = Number(frame.status)
      if (frame.t === 'hchunk') {
        pending.chunks.push(fromBase64url(frame.b))
        if (pending.chunks.reduce((n, chunk) => n + chunk.length, 0) > 32 * 1024 * 1024) { this.fail(new Error(t('接口响应过大'))); return }
      }
      if (frame.t === 'hend' || frame.t === 'herr') {
        this.pending.delete(id); clearTimeout(pending.timer)
        if (frame.t === 'herr') { pending.reject(pending.mutation ? new OperationUncertainError() : new Error(t('桌面转发请求失败'))); return }
        const bytes = new Uint8Array(pending.chunks.reduce((n, c) => n + c.length, 0))
        let offset = 0
        for (const chunk of pending.chunks) { bytes.set(chunk, offset); offset += chunk.length }
        // A sent mutation may already have run even when the response is an error.
        if (pending.status < 200 || pending.status >= 300) { pending.reject(pending.mutation ? new OperationUncertainError() : new Error(`桌面接口返回 HTTP ${pending.status}`)); return }
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
    clearTimeout(this.handshakeTimer)
    this.ready = false
    const socket = this.ws
    this.ws = undefined; this.keys = undefined; this.keyPair = undefined
    if (socket) { socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null; socket.close() }
    this.connectReject?.(error)
    this.connectResolve = undefined; this.connectReject = undefined; this.connectPromise = undefined
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(pending.mutation && pending.sent ? new OperationUncertainError() : error) }
    this.pending.clear()
    for (const id of [...this.subscriptions.keys()]) this.endSubscription(id)
    this.status('offline', error.message)
  }
  close() { this.stopped = true; this.fail(new Error('节点连接已关闭')) }
}
