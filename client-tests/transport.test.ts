import { test } from 'node:test'
import assert from 'node:assert/strict'
import './locale.ts'
import { EncryptedTunnel, OperationUncertainError, type SocketLike } from '../client/transport.ts'
import { base64url, createKeyPair, deriveSessionKeys, fromBase64url, openBytes, openFrame, sealBytes, sealFrame } from '../client/crypto.ts'
import { decodeInnerFrame, encodeInnerFrame } from '../client/frames.ts'
import { parsePairing } from '../client/pairing.ts'

const code = base64url(new Uint8Array(32).fill(7))
const host = { id: 'test-host', name: 'Test', relayUrl: 'https://relay.invalid', connectCode: code, addedAt: 0 }
class FakeSocket implements SocketLike {
  binaryType = ''; readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  keys?: Awaited<ReturnType<typeof deriveSessionKeys>>
  /** Set when this fake desktop advertised `bin: 1`, like Alma 0.4.378 does. */
  binary = false
  /** Sealed frames as they arrived, before decryption. */
  raw: Uint8Array[] = []
  /** Decrypted inner plaintext, so tests can assert on the wire form itself. */
  plain: Uint8Array[] = []
  private counter = 0n
  private chain = Promise.resolve()
  frames: Record<string, any>[] = []
  handler?: (frame: Record<string, any>) => void
  constructor(private wrongCode = false, private offerBinary = false) { setTimeout(() => this.onopen?.(), 0) }
  send(data: string | Uint8Array) {
    this.chain = this.chain.then(async () => {
      if (typeof data === 'string') {
        const frame = JSON.parse(data)
        if (frame.t === 'ok') {
          assert.deepEqual(fromBase64url(frame.ci), this.keys!.confirmInitiator)
          assert.equal(frame.bin === 1, this.binary, 'the client must echo the negotiated mode')
          return
        }
        const pair = await createKeyPair(), nonce = crypto.getRandomValues(new Uint8Array(16))
        this.keys = await deriveSessionKeys({ connectCode: this.wrongCode ? 'wrong-code' : code, myPrivateKey: pair.privateKey, peerPublic: fromBase64url(frame.epk), initiatorPublic: fromBase64url(frame.epk), responderPublic: pair.publicKey, initiatorNonce: fromBase64url(frame.n), responderNonce: nonce })
        this.binary = this.offerBinary && frame.bin === 1
        this.onmessage?.({ data: JSON.stringify({ t: 'hi', epk: base64url(pair.publicKey), n: base64url(nonce), cr: base64url(this.keys.confirmResponder), ...(this.binary ? { bin: 1 } : {}) }) })
      } else {
        this.raw.push(data)
        const plaintext = await openBytes(this.keys!.c2s, data)
        this.plain.push(plaintext)
        const frame = decodeInnerFrame(plaintext)
        this.frames.push(frame)
        this.handler?.(frame)
      }
    })
  }
  async emit(frame: Record<string, any>) {
    const data = await sealBytes(this.keys!.s2c, this.counter++, encodeInnerFrame(frame, this.binary))
    this.onmessage?.({ data })
  }
  async response(id: string, body: unknown, asBytes = false) {
    const encoded = new TextEncoder().encode(JSON.stringify(body))
    await this.emit({ t: 'hres', id, status: 200, headers: {} })
    // A binary peer sends the chunk as bytes; a legacy peer sends base64.
    await this.emit({ t: 'hchunk', id, b: asBytes ? encoded : base64url(encoded) })
    await this.emit({ t: 'hend', id })
  }
  close() { this.readyState = 3 }
  drop() { this.readyState = 3; this.onclose?.() }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 15))
async function waitFor(predicate: () => boolean) { for (let i = 0; i < 100; i++) { if (predicate()) return; await tick() } assert.fail('condition not reached') }

test('pairing accepts E2E HTTPS, retains relay path and isolates host identities', async () => {
  const a = await parsePairing('A', `alma://connect?u=${encodeURIComponent('https://relay.invalid/prefix')}&k=${code}&e2e=1`)
  const b = await parsePairing('B', `alma://connect?u=https://relay.invalid&k=${base64url(new Uint8Array(32).fill(8))}&e2e=1`)
  assert.equal(a.relayUrl, 'https://relay.invalid/prefix'); assert.notEqual(a.id, b.id)
  await assert.rejects(parsePairing('bad', `alma://connect?u=http://relay.invalid&k=${code}&e2e=1`))
  await assert.rejects(parsePairing('bad', `alma://connect?u=https://relay.invalid&k=${code}`))
})
test('handshake authenticates and HTTP response travels encrypted', async () => {
  const sockets: FakeSocket[] = []
  const tunnel = new EncryptedTunnel(host, () => {}, () => { const socket = new FakeSocket(); sockets.push(socket); socket.handler = (frame) => { if (frame.t === 'hreq') void socket.response(frame.id, { online: true }) }; return socket }, 1000)
  try { assert.deepEqual(await tunnel.request('/api/herdr/info'), { online: true }); assert.equal(sockets[0].frames[0].path, '/api/herdr/info') } finally { tunnel.close() }
})
test('wrong pairing code fails authentication', async () => {
  const tunnel = new EncryptedTunnel(host, () => {}, () => new FakeSocket(true), 1000)
  try { await assert.rejects(tunnel.connect(), /配对验证失败/) } finally { tunnel.close() }
})
test('relay loss rejects pending reads and marks sent mutations uncertain without replay', async () => {
  const sockets: FakeSocket[] = []
  const tunnel = new EncryptedTunnel(host, () => {}, () => { const socket = new FakeSocket(); sockets.push(socket); return socket }, 1000)
  try {
    await tunnel.connect()
    const read = tunnel.request('/api/herdr/chat?pane=w1:p1')
    const mutation = tunnel.request('/api/herdr/rpc', { method: 'agent.prompt', params: { target: 'w1:p1', text: 'synthetic' } })
    const readCheck = assert.rejects(read, /连接已断开/)
    const mutationCheck = assert.rejects(mutation, OperationUncertainError)
    await waitFor(() => sockets[0].frames.length === 2)
    sockets[0].drop()
    await Promise.all([readCheck, mutationCheck])
    await tunnel.connect(); await tick()
    assert.equal(sockets.length, 2); assert.equal(sockets[1].frames.length, 0)
  } finally { tunnel.close() }
})
test('non-2xx mutation response is uncertain, so it cannot be resubmitted blindly', async () => {
  let socket!: FakeSocket
  const tunnel = new EncryptedTunnel(host, () => {}, () => socket = new FakeSocket(), 1000)
  try {
    await tunnel.connect()
    const mutation = tunnel.request('/api/herdr/rpc', { method: 'pane.send_keys', params: {} })
    const check = assert.rejects(mutation, OperationUncertainError)
    await waitFor(() => socket.frames.length === 1)
    await socket.emit({ t: 'hres', id: socket.frames[0].id, status: 500, headers: {} })
    await socket.emit({ t: 'hend', id: socket.frames[0].id })
    await check
  } finally { tunnel.close() }
})
test('logical WS close reaches subscriber so it can resubscribe', async () => {
  let socket!: FakeSocket, closed = 0
  const tunnel = new EncryptedTunnel(host, () => {}, () => socket = new FakeSocket(), 1000)
  try {
    await tunnel.connect()
    tunnel.subscribe('/ws/herdr/chat?pane=w1:p1&from=3', () => {}, () => closed++)
    await waitFor(() => socket.frames.some((frame) => frame.t === 'wopen'))
    await socket.emit({ t: 'wclose', id: socket.frames[0].id })
    await waitFor(() => closed === 1)
  } finally { tunnel.close() }
})

test('negotiates binary inner frames and keeps the request body as raw bytes', async () => {
  let socket!: FakeSocket
  const tunnel = new EncryptedTunnel(host, () => {}, () => socket = new FakeSocket(false, true), 1000)
  try {
    await tunnel.connect()
    const reply = tunnel.request('/api/herdr/rpc', { method: 'agent.prompt', params: { text: 'hi' } })
    await waitFor(() => socket.frames.length === 1)
    const sent = socket.frames[0]
    assert.equal(sent.t, 'hreq')
    assert.ok(sent.b instanceof Uint8Array, 'body stays bytes when binary is on')
    assert.equal(new TextDecoder().decode(sent.b), JSON.stringify({ method: 'agent.prompt', params: { text: 'hi' } }))
    // The frame on the wire is the marker form, not JSON.
    assert.equal(socket.plain[0][0], 0, 'binary inner frame carries the marker')
    await socket.response(sent.id, { ok: true }, true)
    assert.deepEqual(await reply, { ok: true })
  } finally { tunnel.close() }
})

test('a legacy desktop that does not echo bin keeps the base64 JSON form', async () => {
  let socket!: FakeSocket
  const tunnel = new EncryptedTunnel(host, () => {}, () => socket = new FakeSocket(false, false), 1000)
  try {
    await tunnel.connect()
    const reply = tunnel.request('/api/herdr/rpc', { method: 'pane.send_keys' })
    await waitFor(() => socket.frames.length === 1)
    // The plaintext on the wire is JSON with a base64 body, which is what a
    // desktop older than 0.4.378 expects.
    assert.equal(socket.plain[0][0], 0x7b, 'legacy inner frame stays JSON')
    const wire = JSON.parse(new TextDecoder().decode(socket.plain[0]))
    assert.equal(typeof wire.b, 'string')
    assert.equal(new TextDecoder().decode(fromBase64url(wire.b)), JSON.stringify({ method: 'pane.send_keys' }))
    await socket.response(socket.frames[0].id, { ok: true }, false)
    assert.deepEqual(await reply, { ok: true })
  } finally { tunnel.close() }
})

test('a binary desktop response is decoded without base64', async () => {
  let socket!: FakeSocket
  const tunnel = new EncryptedTunnel(host, () => {}, () => socket = new FakeSocket(false, true), 1000)
  try {
    await tunnel.connect()
    const reply = tunnel.request('/api/herdr/chat?pane=w1:p1')
    await waitFor(() => socket.frames.length === 1)
    const body = { page: { items: [{ id: 'a', text: '中文' }], start: 0, end: 1 } }
    await socket.response(socket.frames[0].id, body, true)
    assert.deepEqual(await reply, body)
  } finally { tunnel.close() }
})

test('a malformed hchunk fails the tunnel instead of resolving a partial body', async () => {
  let socket!: FakeSocket, status = ''
  const tunnel = new EncryptedTunnel(host, (state) => { status = state }, () => socket = new FakeSocket(false, true), 1000)
  try {
    await tunnel.connect()
    const reply = tunnel.request('/api/herdr/info')
    const check = assert.rejects(reply)
    await waitFor(() => socket.frames.length === 1)
    await socket.emit({ t: 'hres', id: socket.frames[0].id, status: 200, headers: {} })
    await socket.emit({ t: 'hchunk', id: socket.frames[0].id, b: 42 as any })
    await check
    assert.equal(status, 'offline')
  } finally { tunnel.close() }
})

test('a probe gives up quickly so a dead link is reported in seconds', async () => {
  // A half-open socket: TCP looks fine, nothing ever comes back. This is what
  // a Wi-Fi link vanishing without a FIN looks like to the client.
  const sockets: FakeSocket[] = []
  const tunnel = new EncryptedTunnel(host, () => {}, () => { const s = new FakeSocket(); sockets.push(s); return s }, 20_000)
  try {
    // A live handshake, then permanent silence: nothing ever answers.
    await tunnel.connect()
    const started = Date.now()
    await assert.rejects(
      tunnel.request('/api/herdr/info', undefined, { kind: 'read', timeoutMs: 150 }),
      /超时|timeout/i,
    )
    const elapsed = Date.now() - started
    // The point is that the per-call deadline is honoured instead of the
    // tunnel-wide 20 s, which is what made a dead link take so long to show.
    assert.ok(elapsed < 2_000, `probe took ${elapsed} ms; the short deadline was not used`)
  } finally { tunnel.close() }
})

test('inbound traffic is timestamped, which is how silence is detected', async () => {
  const sockets: FakeSocket[] = []
  const tunnel = new EncryptedTunnel(host, () => {}, () => { const s = new FakeSocket(); sockets.push(s); return s }, 5_000)
  try {
    await tunnel.connect()
    const connectedAt = tunnel.lastInboundAt()
    assert.ok(connectedAt > 0, 'the handshake counts as traffic')
    await new Promise((r) => setTimeout(r, 30))
    const request = tunnel.request<{ online: boolean }>('/api/herdr/info', undefined, { kind: 'read' })
    sockets[0].handler = (frame) => { if (frame.t === 'hreq') void sockets[0].response(frame.id, { online: true }) }
    await request
    assert.ok(tunnel.lastInboundAt() > connectedAt, 'a response moves the clock forward')
  } finally { tunnel.close() }
})

// ── local-network direct path ───────────────────────────────────────────
const lanAddress = { host: '192.168.1.10', port: 23019 }
const DIRECT_TEST_HANDSHAKE_MS = 3_000

/** Records which URL each dial went to, and can refuse to open. */
function recordingFactory(opts: { refuse?: (url: string) => boolean; silent?: (url: string) => boolean } = {}) {
  const tried: string[] = []
  const made: FakeSocket[] = []
  return {
    tried, made,
    factory: (url: string) => {
      tried.push(url)
      if (opts.refuse?.(url)) { const s = new FakeSocket(); s.drop(); return s }
      if (opts.silent?.(url)) {
        // Accepts the connection and never speaks: a host that is reachable
        // enough to hold a socket and then says nothing at all.
        const dead = {
          binaryType: '', readyState: 0, send() {}, close() {},
          onopen: null, onmessage: null, onerror: null, onclose: null,
        } as unknown as FakeSocket
        made.push(dead)
        return dead
      }
      const socket = new FakeSocket()
      made.push(socket)
      return socket
    },
  }
}

test('a configured local address is tried before the relay', async () => {
  const tried: string[] = []
  const sockets: FakeSocket[] = []
  const tunnel = new EncryptedTunnel(host, () => {}, (url) => {
    tried.push(url)
    const socket = new FakeSocket()
    socket.handler = (frame) => { if (frame.t === 'hreq') void socket.response(frame.id, { online: true }) }
    sockets.push(socket)
    return socket
  }, 1_000)
  try {
    tunnel.useDirect(lanAddress, async () => true)
    assert.deepEqual(await tunnel.request('/api/herdr/info'), { online: true })
    assert.equal(tried[0], 'ws://192.168.1.10:23019/__alma_e2e__', 'the direct path is dialled first')
    assert.equal(tried.length, 1, 'and the relay is never touched when it works')
    assert.equal(tunnel.currentRoute(), 'direct')
  } finally { tunnel.close() }
})

test('an unreachable local address falls back to the relay without a word', async () => {
  const tried: string[] = []
  const tunnel = new EncryptedTunnel(host, () => {}, (url) => {
    tried.push(url)
    if (url.startsWith('ws://')) {
      // Nothing listening: the dial fails before it ever opens.
      const dead = { binaryType: '', readyState: 3, send() {}, close() {}, onopen: null, onmessage: null, onerror: null, onclose: null } as unknown as FakeSocket
      setTimeout(() => dead.onerror?.(), 0)
      return dead
    }
    const socket = new FakeSocket()
    socket.handler = (frame) => { if (frame.t === 'hreq') void socket.response(frame.id, { online: true }) }
    return socket
  }, 2_000)
  try {
    tunnel.useDirect(lanAddress, async () => true)
    assert.deepEqual(await tunnel.request('/api/herdr/info'), { online: true })
    assert.equal(tried[0], 'ws://192.168.1.10:23019/__alma_e2e__', 'the direct path was tried')
    assert.ok(tried.some((url) => url.startsWith('wss://relay.invalid')), 'the relay took over')
    assert.equal(tunnel.currentRoute(), 'relay')
  } finally { tunnel.close() }
})

test('a silent local address is abandoned on the short deadline', async () => {
  const recorder = recordingFactory({ silent: (url) => url.startsWith('ws://') })
  const tunnel = new EncryptedTunnel(host, () => {}, recorder.factory, 5_000)
  try {
    tunnel.useDirect(lanAddress, async () => true)
    void tunnel.request('/api/herdr/info').catch(() => undefined)
    await new Promise((r) => setTimeout(r, 2_400))
    assert.ok(recorder.tried.some((url) => url.startsWith('wss://relay.invalid')), 'the relay took over')
  } finally { tunnel.close() }
})

test('a local impostor fails identity and the paired desktop still works over the relay', async () => {
  // The scan finds any Alma-compatible responder, including a neighbour's
  // machine. It must prove the saved pairing code; a wrong confirmation falls
  // back to the already-paired relay rather than dropping the desktop.
  let directSocket: FakeSocket | undefined
  let directFailures = 0
  const tried: string[] = []
  const tunnel = new EncryptedTunnel(host, () => {}, (url) => {
    tried.push(url)
    if (url.startsWith('ws://')) {
      // The impostor answers the handshake but holds a different connect code,
      // so its confirmation cannot match.
      directSocket = new FakeSocket(true)
      return directSocket
    }
    const relay = new FakeSocket()
    relay.handler = (frame) => { if (frame.t === 'hreq') void relay.response(frame.id, { online: true }) }
    return relay
  }, 1_000)
  try {
    tunnel.useDirect(lanAddress, async () => true)
    tunnel.onDirectFailed = () => { directFailures++ }
    assert.deepEqual(await tunnel.request('/api/herdr/info'), { online: true })
    assert.ok(directSocket, 'the candidate was probed')
    assert.equal(directFailures, 1, 'the wrong pairing proof rejects this candidate')
    assert.ok(tried.some((url) => url.startsWith('wss://relay.invalid')), 'the paired tunnel fell back to relay')
    assert.equal(tunnel.currentRoute(), 'relay')
  } finally { tunnel.close() }
})

test('a public address is ignored even if one is configured', async () => {
  const recorder = recordingFactory()
  const tunnel = new EncryptedTunnel(host, () => {}, recorder.factory, 1_000)
  try {
    // A public address here would mean plain-text traffic across the internet.
    tunnel.useDirect({ host: '203.0.113.5', port: 23019 }, async () => true)
    void tunnel.request('/api/herdr/info').catch(() => undefined)
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(recorder.tried.every((url) => url.startsWith('wss://')), 'no plain-text dial was made')
  } finally { tunnel.close() }
})

test('a local address off this phone\'s subnet is never dialled in plain text', async () => {
  // The configured address is private, but it belongs to a different network:
  // a stranger's host that happens to sit on a route this phone can reach.
  const tried: string[] = []
  const tunnel = new EncryptedTunnel(host, () => {}, (url) => {
    tried.push(url)
    const socket = new FakeSocket()
    socket.handler = (frame) => { if (frame.t === 'hreq') void socket.response(frame.id, { online: true }) }
    return socket
  }, 2_000)
  try {
    tunnel.useDirect({ host: '10.9.9.9', port: 23019 }, async () => false)
    assert.deepEqual(await tunnel.request('/api/herdr/info'), { online: true })
    assert.ok(tried.every((url) => url.startsWith('wss://')), `a plain-text dial escaped: ${tried.join(', ')}`)
    assert.equal(tunnel.currentRoute(), 'relay')
  } finally { tunnel.close() }
})

test('a policy that fails closed is treated as "no"', async () => {
  const tried: string[] = []
  const tunnel = new EncryptedTunnel(host, () => {}, (url) => {
    tried.push(url)
    const socket = new FakeSocket()
    socket.handler = (frame) => { if (frame.t === 'hreq') void socket.response(frame.id, { online: true }) }
    return socket
  }, 2_000)
  try {
    tunnel.useDirect(lanAddress, async () => { throw new Error('no network info') })
    assert.deepEqual(await tunnel.request('/api/herdr/info'), { online: true })
    assert.ok(tried.every((url) => url.startsWith('wss://')), 'an unknown network must not open the plain-text path')
  } finally { tunnel.close() }
})

test('a direct peer that accepts TCP but never answers hi falls back on the handshake deadline', async () => {
  const tried: string[] = []
  const tunnel = new EncryptedTunnel(host, () => {}, (url) => {
    tried.push(url)
    if (url.startsWith('ws://')) {
      // TCP/WebSocket opens, but the peer never sends the Alma `hi`. This is
      // different from an unreachable IP: the short dial timer has already
      // stopped, so a separate handshake deadline must trigger fallback.
      const silent = {
        binaryType: '', readyState: 1, send() {}, close() { this.readyState = 3 },
        onopen: null as (() => void) | null,
        onmessage: null as ((event: { data: unknown }) => void) | null,
        onerror: null as (() => void) | null,
        onclose: null as (() => void) | null,
      }
      setTimeout(() => silent.onopen?.(), 0)
      return silent
    }
    const relay = new FakeSocket()
    relay.handler = (frame) => { if (frame.t === 'hreq') void relay.response(frame.id, { online: true }) }
    return relay
  }, 10_000)
  try {
    tunnel.useDirect(lanAddress, async () => true)
    const request = tunnel.request('/api/herdr/info')
    await new Promise((r) => setTimeout(r, DIRECT_TEST_HANDSHAKE_MS + 80))
    const response = await request
    assert.deepEqual(response, { online: true })
    assert.ok(tried.some((url) => url.startsWith('wss://relay.invalid')), 'relay must take over after a silent direct handshake')
    assert.equal(tunnel.currentRoute(), 'relay')
  } finally { tunnel.close() }
})

test('a drop after the direct tunnel was up is not counted against the address', async () => {
  // A connection that established and later dropped is a connection problem —
  // the phone slept, the socket was reset. The address is still good, so it must
  // not feed the breaker, which would suspend the direct route for half an hour
  // after two ordinary disconnects.
  let directSocket: FakeSocket | undefined
  let directFailures = 0
  const tunnel = new EncryptedTunnel(host, () => {}, (url) => {
    if (url.startsWith('ws://')) {
      directSocket = new FakeSocket()
      directSocket.handler = (frame) => { if (frame.t === 'hreq') void directSocket!.response(frame.id, { online: true }) }
      return directSocket
    }
    const relay = new FakeSocket()
    relay.handler = (frame) => { if (frame.t === 'hreq') void relay.response(frame.id, { online: true }) }
    return relay
  }, 1_000)
  try {
    tunnel.useDirect(lanAddress, async () => true)
    tunnel.onDirectFailed = () => { directFailures++ }
    assert.deepEqual(await tunnel.request('/api/herdr/info'), { online: true })
    assert.equal(tunnel.currentRoute(), 'direct', 'it really did connect directly')
    // Now the link drops, as it does when the phone goes to sleep.
    directSocket!.drop()
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(directFailures, 0, 'a proven address is not blamed for a dropped link')
  } finally { tunnel.close() }
})
