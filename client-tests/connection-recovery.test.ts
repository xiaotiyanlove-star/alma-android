import { test } from 'node:test'
import assert from 'node:assert/strict'
import './locale.ts'
import { Controller } from '../client/controller.ts'
import { EncryptedTunnel } from '../client/transport.ts'
import { base64url } from '../client/crypto.ts'
import type { Host } from '../client/model.ts'
import type { HostStorage } from '../client/storage.ts'
import type { Transport } from '../client/transport.ts'

/**
 * Recovering a connection, and the ways it used to fail permanently.
 *
 * Everything here has the same shape: something that should have been a delay
 * became a dead end. The cure is the same idea three times — every wait has a
 * deadline, every failure keeps a way back, and nothing draws a conclusion it
 * cannot revisit.
 */

const code = base64url(new Uint8Array(32).fill(7))
const host: Host = { id: 'A', name: 'A', relayUrl: 'https://a.invalid', connectCode: code, addedAt: 0 }

/** Records every dial, and answers the handful of routes the controller uses. */
function recorder() {
  const log: string[] = []
  const transport: Transport & { useDirect?: (address: unknown) => void } = {
    async connect() { log.push('connect') },
    async request<T>(path: string): Promise<T> {
      log.push(`request ${path}`)
      if (path === '/api/herdr/info') return { online: true } as T
      if (path === '/api/herdr/mutes') return { tabs: [], workspaces: [] } as T
      if (path === '/__alma_lan__') return { port: 23019, hosts: ['192.168.50.20'] } as T
      return {} as T
    },
    subscribe() { return { close() {} } },
    lastInboundAt() { return Date.now() },
    close() { log.push('close') },
    useDirect(address: unknown) { log.push(`direct ${address ? 'set' : 'none'}`) },
  }
  return { transport, log }
}

function setup() {
  const made: ReturnType<typeof recorder>[] = []
  const storage: HostStorage = { persistent: true, async load() { return [host] }, async save() {} }
  const controller = new Controller(storage, () => {
    const entry = recorder()
    made.push(entry)
    return entry.transport
  })
  return { controller, made }
}

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms))

test('a subnet gate that never answers still lets the relay be dialled', async () => {
  // The gate is a native bridge call, and a bridge call can lose its callback
  // while the page is frozen. It used to be awaited *before* the relay was
  // attempted at all, so a lost answer meant "encrypted connection timed out"
  // on every dial until the app was restarted. A timeout is a refusal: the
  // plain-text path is skipped and the relay proceeds.
  const dialled: string[] = []
  const tunnel = new EncryptedTunnel(host, () => {}, (url) => {
    dialled.push(url)
    return {
      binaryType: '', readyState: 0, send() {}, close() {},
      onopen: null, onmessage: null, onerror: null, onclose: null,
    }
  }, 30_000)
  try {
    tunnel.useDirect({ host: '192.168.50.20', port: 23019 }, () => new Promise<boolean>(() => {}))
    void tunnel.connect().catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 2_400))
    assert.equal(dialled.length, 1, 'the relay was reached despite the unanswered gate')
    assert.ok(dialled[0].startsWith('wss://'), 'and it is the relay, not the local address')
  } finally { tunnel.close() }
})

test('a gate that throws refuses the direct path but not the connection', async () => {
  const dialled: string[] = []
  const tunnel = new EncryptedTunnel(host, () => {}, (url) => {
    dialled.push(url)
    return {
      binaryType: '', readyState: 0, send() {}, close() {},
      onopen: null, onmessage: null, onerror: null, onclose: null,
    }
  }, 30_000)
  try {
    tunnel.useDirect({ host: '192.168.50.20', port: 23019 }, async () => { throw new Error('bridge unavailable') })
    void tunnel.connect().catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.equal(dialled.length, 1, 'the relay was dialled at once')
    assert.ok(dialled[0].startsWith('wss://'))
  } finally { tunnel.close() }
})

test('returning to the app dials each desktop once, not twice', async () => {
  // `resume` replaced every tunnel and then `retryStopped` dialled the same
  // runtimes again, because their status was still `connecting`. Both sockets
  // opened, both asked `/api/herdr/info`, and the subscription of whichever
  // lost the race could be closed under the winner.
  const { controller, made } = setup()
  try {
    await controller.initialize()
    await settle()
    const first = made[0]
    first.log.length = 0
    controller.resume(true)
    controller.retryStopped()
    await settle()
    const second = made[made.length - 1]
    assert.equal(second.log.filter((entry) => entry === 'connect').length, 1, 'one dial per return')
    assert.equal(second.log.filter((entry) => entry === 'request /api/herdr/info').length, 1, 'one handshake read, not two')
  } finally { controller.dispose() }
})

test('a desktop on the relay is asked again, even though an address is cached', async () => {
  // The cached address used to end the search outright, so a stale one (the
  // desktop moved, the phone changed network, the breaker suspended the path)
  // kept the session on the relay for the rest of the day.
  const { controller, made } = setup()
  try {
    await controller.initialize()
    await settle()
    ;(controller as any).patchHost('A', { discoveredLan: { host: '10.0.0.99', port: 23019 }, route: 'relay', status: 'online', herdrOnline: true })
    const transport = made[made.length - 1]
    transport.log.length = 0
    ;(controller as any).maybeDiscover('A', true)
    await settle()
    assert.ok(transport.log.includes('request /__alma_lan__'), 'the desktop was asked where it is')
  } finally { controller.dispose() }
})

test('a desktop already using its address is not asked again', async () => {
  // The early return still has to work for the healthy case: asking a desktop
  // that is already connected over the LAN spends a round trip to hear that
  // nothing changed.
  const { controller, made } = setup()
  try {
    await controller.initialize()
    await settle()
    ;(controller as any).patchHost('A', { discoveredLan: { host: '192.168.50.20', port: 23019 }, route: 'direct', status: 'online', herdrOnline: true })
    const transport = made[made.length - 1]
    transport.log.length = 0
    ;(controller as any).maybeDiscover('A', true)
    await settle()
    assert.equal(transport.log.includes('request /__alma_lan__'), false, 'nothing to search for')
  } finally { controller.dispose() }
})

test('returning to the app asks a relayed desktop where it is', async () => {
  // Returning is when the user feels the latency, so it is the moment the
  // question is worth one round trip — regardless of the ordinary interval.
  const { controller, made } = setup()
  try {
    await controller.initialize()
    await settle()
    ;(controller as any).patchHost('A', { discoveredLan: { host: '10.0.0.99', port: 23019 }, route: 'relay', status: 'online', herdrOnline: true })
    ;(controller as any).lastAsk.set('A', Date.now())
    const transport = made[made.length - 1]
    transport.log.length = 0
    controller.setForeground(false)
    controller.setForeground(true)
    await settle()
    assert.ok(transport.log.includes('request /__alma_lan__'), 'the return forced one question')
  } finally { controller.dispose() }
})

test('a replacement runtime does not keep the discarded route', async () => {
  // The route is a property of the transport in hand. Carrying it over showed
  // "lan" while the replacement dialled the relay — and the discovery early
  // return read that stale value as "nothing to search for".
  const { controller } = setup()
  try {
    await controller.initialize()
    await settle()
    ;(controller as any).patchHost('A', { route: 'direct' })
    const state = controller as any
    const runtime = [...state.runtimes.values()][0]
    state.rebuild('A', runtime)
    assert.equal(controller.getState().hosts[0].route, undefined, 'the new dial has no route yet')
  } finally { controller.dispose() }
})
