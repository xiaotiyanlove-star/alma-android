import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Controller } from '../client/controller.ts'
import type { Host, HostState } from '../client/model.ts'
import type { HostStorage } from '../client/storage.ts'
import { EncryptedTunnel, OperationUncertainError, RejectedError, TunnelError, type SocketLike } from '../client/transport.ts'
import { createKeyPair, deriveSessionKeys, openBytes, sealBytes } from '../client/crypto.ts'
import { isPermanentFailure } from '../client/backoff.ts'

const host: Host = { id: 'A', name: 'A', relayUrl: 'https://a.invalid', connectCode: 'A'.repeat(43), addedAt: 0 }

// ── suspend / resume ────────────────────────────────────────────────────
class CountingTransport implements TransportLike {
  connections = 0
  closed = false
  private stop = false
  constructor(private sink: (state: 'connecting' | 'online' | 'offline', error?: string, code?: any) => void) {}
  async connect() { if (this.stop) throw new Error('连接已关闭'); this.connections++; this.sink('online') }
  async request<T>(path: string): Promise<T> { if (path === '/api/herdr/info') return { online: true } as T; return { result: {} } as T }
  subscribe() { return { close() {} } }
  close() { this.stop = true; this.closed = true; this.sink('offline') }
  /** Simulates the transport noticing a dead connection on its own. */
  die() { this.stop = true; this.sink('offline') }
}
interface TransportLike { connect(): Promise<void>; request<T>(p: string, b?: unknown, i?: unknown): Promise<T>; subscribe(p: string, r: (f: any) => void, c: () => void): { close(): void }; close(): void }

test('a suspended desktop reconnects after resume', async () => {
  const made: CountingTransport[] = []
  const storage: HostStorage = { persistent: true, async load() { return [host] }, async save() {} }
  const controller = new Controller(storage, (_h, sink) => { const t = new CountingTransport(sink as any); made.push(t); return t as any })
  try {
    await controller.initialize(); await new Promise((r) => setTimeout(r, 5))
    assert.equal(made[0].connections, 1, 'connected on load')

    controller.suspend()
    assert.equal(made[0].closed, true, 'old transport released')
    assert.equal(controller.getState().hosts[0].status, 'offline')

    controller.resume(true)
    await new Promise((r) => setTimeout(r, 5))
    assert.equal(made.length, 2, 'a fresh transport is built: the closed one could never reopen')
    assert.equal(made[1].connections, 1, 'and it actually connects')
    assert.equal(controller.getState().hosts[0].status, 'online')
  } finally { controller.dispose() }
})

test('resume without a suspension does nothing', async () => {
  const made: CountingTransport[] = []
  const storage: HostStorage = { persistent: true, async load() { return [host] }, async save() {} }
  const controller = new Controller(storage, (_h, sink) => { const t = new CountingTransport(sink as any); made.push(t); return t as any })
  try {
    await controller.initialize(); await new Promise((r) => setTimeout(r, 5))
    controller.resume(false); await new Promise((r) => setTimeout(r, 5))
    assert.equal(made.length, 1, 'no extra transport')
  } finally { controller.dispose() }
})

// ── error classification by code ────────────────────────────────────────
test('permanent failures are recognised by code, not by message', () => {
  assert.equal(isPermanentFailure('auth'), 'auth')
  assert.equal(isPermanentFailure('unknown-host'), 'unknown-host')
  assert.equal(isPermanentFailure('network'), null)
  assert.equal(isPermanentFailure(undefined), null)
})

test('a translated message cannot change the classification', () => {
  // Whatever the interface language, only the code decides.
  assert.equal(isPermanentFailure('Anything at all'), null)
})

// ── replay protection ───────────────────────────────────────────────────
test('an out-of-order frame is rejected before decryption', async () => {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  const first = await sealBytes(key, 0n, new TextEncoder().encode('{"a":1}'))
  const second = await sealBytes(key, 1n, new TextEncoder().encode('{"b":2}'))

  await assert.rejects(openBytes(key, second, 0n), /out of order/, 'a future frame is refused')
  await assert.rejects(openBytes(key, first, 1n), /out of order/, 'a replayed old frame is refused')
  assert.equal(new TextDecoder().decode(await openBytes(key, first, 0n)), '{"a":1}', 'the expected one passes')
  assert.equal(new TextDecoder().decode(await openBytes(key, second, 1n)), '{"b":2}')
})

test('without an expected counter the check is skipped, for compatibility', async () => {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  const frame = await sealBytes(key, 7n, new TextEncoder().encode('x'))
  assert.equal(new TextDecoder().decode(await openBytes(key, frame)), 'x')
})

// ── request kind ────────────────────────────────────────────────────────
test('an upload is a mutation even though it has no JSON body', async () => {
  let socket!: FakeSocket
  const tunnel = new EncryptedTunnel(host, () => {}, () => socket = new FakeSocket(), 1000)
  try {
    await tunnel.connect()
    const upload = tunnel.request('/api/attachments/file', undefined, { kind: 'mutation', raw: new Uint8Array([1, 2, 3]), headers: { 'content-type': 'text/plain' } })
    const check = assert.rejects(upload, /不确定|uncertain|可能已执行/)
    await new Promise((r) => setTimeout(r, 30))
    socket.drop()
    await check
  } finally { tunnel.close() }
})

test('a read stays retryable', async () => {
  let socket!: FakeSocket
  const tunnel = new EncryptedTunnel(host, () => {}, () => socket = new FakeSocket(), 1000)
  try {
    await tunnel.connect()
    const read = tunnel.request('/api/herdr/info', undefined, { kind: 'read' })
    const check = assert.rejects(read)
    await new Promise((r) => setTimeout(r, 30))
    socket.drop()
    await check
  } finally { tunnel.close() }
})

class FakeSocket implements SocketLike {
  binaryType = ''; readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  private keys?: Awaited<ReturnType<typeof deriveSessionKeys>>
  private chain = Promise.resolve()
  private recvAsClient = 0n
  constructor() { setTimeout(() => this.onopen?.(), 0) }
  /** Request ids that went out encrypted, so a test can answer one. */
  private requestIds: string[] = []
  hasRequest(): boolean { return this.requestIds.length > 0 }
  count(): number { return this.requestIds.length }
  lastId(): string { return this.requestIds[this.requestIds.length - 1] ?? '' }
  /** Answers the most recent request with a given HTTP status and body. */
  reply(status: number, body: unknown) {
    const id = this.requestIds[this.requestIds.length - 1]
    if (!id) throw new Error('no request to answer')
    const json = new TextEncoder().encode(JSON.stringify(body))
    this.onmessage?.({ data: JSON.stringify({ t: 'hres', id, status, headers: {} }) })
    this.onmessage?.({ data: JSON.stringify({ t: 'hchunk', id, b: b64(json) }) })
    this.onmessage?.({ data: JSON.stringify({ t: 'hend', id }) })
  }
  send(data: string | Uint8Array) {
    this.chain = this.chain.then(async () => {
      if (typeof data === 'string') {
        const frame = JSON.parse(data)
        if (frame.t === 'ok') return
        const pair = await createKeyPair(), nonce = crypto.getRandomValues(new Uint8Array(16))
        this.keys = await deriveSessionKeys({ connectCode: host.connectCode, myPrivateKey: pair.privateKey, peerPublic: fromBase64urlOf(frame.epk), initiatorPublic: fromBase64urlOf(frame.epk), responderPublic: pair.publicKey, initiatorNonce: fromBase64urlOf(frame.n), responderNonce: nonce })
        this.onmessage?.({ data: JSON.stringify({ t: 'hi', epk: b64(pair.publicKey), n: b64(nonce), cr: b64(this.keys.confirmResponder) }) })
      } else {
        // Remember the id so the test can answer a request as the relay would.
        const frame = await openBytes(this.keys!.c2s, data, this.recvAsClient++)
        const inner = JSON.parse(new TextDecoder().decode(frame))
        if (inner.t === 'hreq') this.requestIds.push(String(inner.id))
      }
    })
  }
  close() { this.readyState = 3 }
  drop() { this.readyState = 3; this.onclose?.() }
}
function b64(bytes: Uint8Array): string {
  let s = ''
  for (const byte of bytes) s += String.fromCharCode(byte)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function fromBase64urlOf(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

test('coming back after a long absence rebuilds a tunnel that still looks open', async () => {
  // Android froze the page while hidden, so nothing marked this transport
  // closed; the relay has dropped the socket all the same.
  const made: CountingTransport[] = []
  const storage: HostStorage = { persistent: true, async load() { return [host] }, async save() {} }
  const controller = new Controller(storage, (_h, sink) => { const t = new CountingTransport(sink as any); made.push(t); return t as any })
  try {
    await controller.initialize(); await new Promise((r) => setTimeout(r, 5))
    assert.equal(controller.getState().hosts[0].status, 'online')

    controller.resume(true)
    await new Promise((r) => setTimeout(r, 5))
    assert.equal(made[0].closed, true, 'the stale transport is released')
    assert.equal(made.length, 2)
    assert.equal(made[1].connections, 1)
    assert.equal(controller.getState().hosts[0].status, 'online')
    assert.equal(controller.getState().hosts[0].retriesLeft, 3, 'the ladder starts over')
  } finally { controller.dispose() }
})

test('a quick app switch keeps the tunnel it already has', async () => {
  const made: CountingTransport[] = []
  const storage: HostStorage = { persistent: true, async load() { return [host] }, async save() {} }
  const controller = new Controller(storage, (_h, sink) => { const t = new CountingTransport(sink as any); made.push(t); return t as any })
  try {
    await controller.initialize(); await new Promise((r) => setTimeout(r, 5))
    controller.resume(false); await new Promise((r) => setTimeout(r, 5))
    assert.equal(made.length, 1)
    assert.equal(made[0].closed, false)
  } finally { controller.dispose() }
})

test('a dead socket that never reported its death is replaced on return', async () => {
  // The page was frozen when the relay dropped the socket, so no close event
  // ran: the transport still believes it is online. Only a read can tell.
  const made: CountingTransport[] = []
  const storage: HostStorage = { persistent: true, async load() { return [host] }, async save() {} }
  const controller = new Controller(storage, (_h, sink) => { const t = new CountingTransport(sink as any); made.push(t); return t as any })
  try {
    await controller.initialize(); await new Promise((r) => setTimeout(r, 5))
    // A real transport reports the failure before rejecting; the runtime is
    // what schedules the retry, so the status has to change with it.
    made[0].request = async (path: string) => {
      if (path === '/api/herdr/info') { made[0].die(); throw new Error('connection closed') }
      return {} as any
    }
    await controller.verify()
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(made.length, 2, 'the unanswerable transport is replaced')
    assert.equal(controller.getState().hosts[0].status, 'online')
  } finally { controller.dispose() }
})

test('a working socket is left alone when the app returns', async () => {
  const made: CountingTransport[] = []
  const storage: HostStorage = { persistent: true, async load() { return [host] }, async save() {} }
  const controller = new Controller(storage, (_h, sink) => { const t = new CountingTransport(sink as any); made.push(t); return t as any })
  try {
    await controller.initialize(); await new Promise((r) => setTimeout(r, 5))
    await controller.verify()
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(made.length, 1, 'no reconnect for a healthy tunnel')
    assert.equal(controller.getState().hosts[0].status, 'online')
  } finally { controller.dispose() }
})

test('a request on a socket that died silently fails at once instead of timing out', async () => {
  // The relay closed the socket while the page was frozen, so no close event
  // ran and `ready` is still true. Sending would go nowhere; waiting for the
  // 20 s timeout would leave the UI dead for the whole wait.
  let socket!: FakeSocket
  const tunnel = new EncryptedTunnel(host, () => {}, () => socket = new FakeSocket(), 1000)
  try {
    await tunnel.connect()
    socket.readyState = 3
    const started = Date.now()
    await assert.rejects(tunnel.request('/api/herdr/info', undefined, { kind: 'read' }))
    assert.ok(Date.now() - started < 500, 'fails immediately, not on the timeout')
  } finally { tunnel.close() }
})

// ── a refusal is not an uncertain outcome ───────────────────────────────
test('a 403 on a mutation is a definite refusal, not "may have run"', async () => {
  // Alma answers methods the phone may not call with 403 and a JSON body.
  // Reporting that as uncertain tells the user not to retry something that
  // provably did not happen.
  const call = new EncryptedTunnel(host, () => {}, () => new FakeSocket(), 1000)
  try {
    await call.connect()
    // Drive the inbound side directly: the point under test is how a response
    // status is classified, not how frames travel.
    const pendingId = 'probe'
    ;(call as any).pending.set(pendingId, {
      mutation: true, sent: true, status: 0, chunks: [],
      timer: setTimeout(() => undefined, 10_000),
      resolve: () => { throw new Error('should not resolve') },
      reject: (error: Error) => {
        assert.ok(error instanceof RejectedError, 'a refusal has its own type')
        assert.equal((error as RejectedError).status, 403)
        assert.match(error.message, /not available from the phone/)
      },
    })
    const body = new TextEncoder().encode(JSON.stringify({ error: { code: 'forbidden', message: 'layout.apply is not available from the phone' } }))
    ;(call as any).handle({ t: 'hres', id: pendingId, status: 403, headers: {} })
    ;(call as any).handle({ t: 'hchunk', id: pendingId, b: b64(body) })
    ;(call as any).handle({ t: 'hend', id: pendingId })
  } finally { call.close() }
})

test('a 500 on a mutation stays uncertain: it may have run', async () => {
  let socket!: FakeSocket
  const tunnel = new EncryptedTunnel(host, () => {}, () => socket = new FakeSocket(), 1000)
  try {
    await tunnel.connect()
    const call = tunnel.request('/api/herdr/rpc', { method: 'agent.prompt', params: {} })
    const check = assert.rejects(call, (error: unknown) => error instanceof OperationUncertainError)
    for (let i = 0; i < 50 && !socket.hasRequest(); i++) await new Promise((r) => setTimeout(r, 5))
    socket.reply(500, { error: { code: 'internal', message: 'boom' } })
    await check
  } finally { tunnel.close() }
})
