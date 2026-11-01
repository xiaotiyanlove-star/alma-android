import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EncryptedTunnel, OperationUncertainError, type SocketLike } from '../client/transport.ts'
import { base64url, createKeyPair, deriveSessionKeys, fromBase64url, openFrame, sealFrame } from '../client/crypto.ts'
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
  private counter = 0n
  private chain = Promise.resolve()
  frames: Record<string, any>[] = []
  handler?: (frame: Record<string, any>) => void
  constructor(private wrongCode = false) { setTimeout(() => this.onopen?.(), 0) }
  send(data: string | Uint8Array) {
    this.chain = this.chain.then(async () => {
      if (typeof data === 'string') {
        const frame = JSON.parse(data)
        if (frame.t === 'ok') { assert.deepEqual(fromBase64url(frame.ci), this.keys!.confirmInitiator); return }
        const pair = await createKeyPair(), nonce = crypto.getRandomValues(new Uint8Array(16))
        this.keys = await deriveSessionKeys({ connectCode: this.wrongCode ? 'wrong-code' : code, myPrivateKey: pair.privateKey, peerPublic: fromBase64url(frame.epk), initiatorPublic: fromBase64url(frame.epk), responderPublic: pair.publicKey, initiatorNonce: fromBase64url(frame.n), responderNonce: nonce })
        this.onmessage?.({ data: JSON.stringify({ t: 'hi', epk: base64url(pair.publicKey), n: base64url(nonce), cr: base64url(this.keys.confirmResponder) }) })
      } else {
        const frame = await openFrame(this.keys!.c2s, data) as Record<string, any>
        this.frames.push(frame)
        this.handler?.(frame)
      }
    })
  }
  async emit(frame: Record<string, any>) { const data = await sealFrame(this.keys!.s2c, this.counter++, frame); this.onmessage?.({ data }) }
  async response(id: string, body: unknown) {
    await this.emit({ t: 'hres', id, status: 200, headers: {} })
    await this.emit({ t: 'hchunk', id, b: base64url(new TextEncoder().encode(JSON.stringify(body))) })
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
