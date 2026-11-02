import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Controller } from '../client/controller.ts'
import type { Host, HostState } from '../client/model.ts'
import type { HostStorage } from '../client/storage.ts'
import { EncryptedTunnel, TunnelError, type SocketLike } from '../client/transport.ts'
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
  constructor() { setTimeout(() => this.onopen?.(), 0) }
  send(data: string | Uint8Array) {
    this.chain = this.chain.then(async () => {
      if (typeof data === 'string') {
        const frame = JSON.parse(data)
        if (frame.t === 'ok') return
        const pair = await createKeyPair(), nonce = crypto.getRandomValues(new Uint8Array(16))
        this.keys = await deriveSessionKeys({ connectCode: host.connectCode, myPrivateKey: pair.privateKey, peerPublic: fromBase64urlOf(frame.epk), initiatorPublic: fromBase64urlOf(frame.epk), responderPublic: pair.publicKey, initiatorNonce: fromBase64urlOf(frame.n), responderNonce: nonce })
        this.onmessage?.({ data: JSON.stringify({ t: 'hi', epk: b64(pair.publicKey), n: b64(nonce), cr: b64(this.keys.confirmResponder) }) })
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
