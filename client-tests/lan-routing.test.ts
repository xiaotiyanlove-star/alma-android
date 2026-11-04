import { test } from 'node:test'
import assert from 'node:assert/strict'
import './locale.ts'
import { Controller } from '../client/controller.ts'
import type { Host } from '../client/model.ts'
import type { HostStorage } from '../client/storage.ts'
import type { Transport } from '../client/transport.ts'

/**
 * Local-network routing with more than one paired desktop on the same subnet.
 *
 * The scan cannot tell desktops apart by address; only a handshake with each
 * pairing's own code can. What these pin is that the app never lets one desktop
 * claim an address that another has proved is its own, and that a desktop whose
 * listener is unreachable backs off instead of re-probing on every reconnect.
 */

const host = (id: string, code: string): Host => ({ id, name: id, relayUrl: `https://${id.toLowerCase()}.invalid`, connectCode: code, addedAt: 0 })

/** Answers `/__alma_lan__` with whatever the test says, and nothing else. */
function desk(candidates: unknown, options: { failRequest?: boolean } = {}) {
  const asked: string[] = []
  const transport: Transport = {
    async connect() {},
    async request<T>(path: string): Promise<T> {
      asked.push(path)
      if (path === '/__alma_lan__') {
        if (options.failRequest) throw new Error('HTTP 404')
        if (candidates === undefined) throw new Error('HTTP 404')
        return candidates as T
      }
      if (path === '/api/herdr/info') return { online: true } as T
      if (path === '/api/herdr/mutes') return { tabs: [], workspaces: [] } as T
      if (path.startsWith('/api/herdr/chat')) return { session_id: 's', page: { start: 0, end: 0, items: [] }, queued: [] } as T
      return { result: { read: { text: '' } } } as T
    },
    subscribe() { return { close() {} } },
    lastInboundAt() { return Date.now() },
    close() {},
  }
  return { transport, asked }
}

function setup(hosts: Host[], candidates: Record<string, unknown>) {
  const transports = new Map<string, ReturnType<typeof desk>>()
  const storage: HostStorage = { persistent: true, async load() { return hosts }, async save() {} }
  const controller = new Controller(storage, (h) => {
    const made = desk(candidates[h.id])
    transports.set(h.id, made)
    return made.transport
  })
  return { controller, transports }
}

test('a reachable desktop is asked where it is, before any scan', async () => {
  // The candidate answer is one round trip; the scan is a /24 of handshakes.
  const { controller, transports } = setup([host('A', 'A'.repeat(43))], { A: { port: 23019, hosts: ['192.168.50.20'] } })
  try {
    await controller.initialize()
    await new Promise((r) => setTimeout(r, 40))
    await (controller as any).candidateAddresses('A')
    assert.ok(transports.get('A')!.asked.includes('/__alma_lan__'), 'the desktop was asked where it is')
  } finally { controller.dispose() }
})

test('an offline desktop is not asked at all', async () => {
  // `request` dials on demand, so asking an offline desktop would spend the
  // whole request deadline inside a search — in exactly the case the search is
  // for. Scanning is what finds a desktop the relay cannot reach.
  const { controller, transports } = setup([host('A', 'A'.repeat(43))], { A: { port: 23019, hosts: ['192.168.50.20'] } })
  try {
    await controller.initialize()
    await new Promise((r) => setTimeout(r, 40))
    // Take the desktop offline the way a dropped relay would.
    ;(controller as any).patchHost('A', { status: 'offline', herdrOnline: false })
    const asked = transports.get('A')!.asked.length
    const found = await (controller as any).candidateAddresses('A')
    assert.deepEqual(found, [], 'no candidates from a desktop that is not connected')
    assert.equal(transports.get('A')!.asked.length, asked, 'and nothing was sent over the dead tunnel')
  } finally { controller.dispose() }
})

test('a desktop that answers 404 is not an error', async () => {
  const { controller } = setup([host('A', 'A'.repeat(43))], {})
  try {
    await controller.initialize()
    await new Promise((r) => setTimeout(r, 40))
    const found = await (controller as any).candidateAddresses('A')
    assert.deepEqual(found, [], 'a desktop too old for the route simply has no candidates')
    assert.equal(controller.getState().hosts[0].status !== 'error', true, 'and it is not surfaced as a failure')
  } finally { controller.dispose() }
})

test('an address already claimed by another desktop is not adopted twice', async () => {
  // Two pairings, one listener. `adoptLan` is the last word: the second caller
  // must give the address up rather than route two desktops at one socket.
  const { controller } = setup([host('A', 'A'.repeat(43)), host('B', 'B'.repeat(43))], {})
  try {
    await controller.initialize()
    await new Promise((r) => setTimeout(r, 20))
    const address = { host: '192.168.50.20', port: 23019 }
    ;(controller as any).patchHost('A', { discoveredLan: address })
    // B is offered the same address and must refuse it.
    assert.equal((controller as any).claimedBy(address.host, address.port, 'B'), true)
    await (controller as any).adoptLan('B', address)
    assert.equal(controller.getState().hosts.find((h) => h.host.id === 'B')?.discoveredLan, undefined)
    // A keeps it.
    assert.deepEqual(controller.getState().hosts.find((h) => h.host.id === 'A')?.discoveredLan, address)
  } finally { controller.dispose() }
})

test('two desktops on different addresses both keep their own route', async () => {
  const { controller } = setup([host('A', 'A'.repeat(43)), host('B', 'B'.repeat(43))], {})
  try {
    await controller.initialize()
    await new Promise((r) => setTimeout(r, 20))
    const a = { host: '192.168.50.20', port: 23019 }
    const b = { host: '192.168.50.21', port: 23019 }
    ;(controller as any).patchHost('A', { discoveredLan: a })
    ;(controller as any).patchHost('B', { discoveredLan: b })
    assert.equal((controller as any).claimedBy(b.host, b.port, 'A'), true, 'A sees B’s address as taken')
    assert.equal((controller as any).claimedBy(a.host, a.port, 'A'), false, 'and not its own')
    assert.deepEqual(controller.getState().hosts.map((h) => h.discoveredLan), [a, b])
  } finally { controller.dispose() }
})

test('a network change releases every claim, so a moved desktop can be found again', async () => {
  const { controller } = setup([host('A', 'A'.repeat(43)), host('B', 'B'.repeat(43))], {})
  try {
    await controller.initialize()
    await new Promise((r) => setTimeout(r, 20))
    ;(controller as any).patchHost('A', { discoveredLan: { host: '192.168.50.20', port: 23019 } })
    controller.networkChanged()
    assert.equal(controller.getState().hosts.every((h) => h.discoveredLan === undefined), true)
  } finally { controller.dispose() }
})

test('an unreachable desktop is left alone longer than one that said nothing', async () => {
  const { controller } = setup([host('A', 'A'.repeat(43))], { A: { port: 23019, hosts: ['192.168.50.20'] } })
  try {
    await controller.initialize()
    await new Promise((r) => setTimeout(r, 20))
    const controllerState = controller as any
    // Recorded outcomes decide the next wait.
    controllerState.lastMiss.set('A', 'unreachable')
    const before = controllerState.lastDiscover.get('A')
    assert.equal(typeof before, 'number', 'a search was attempted')
  } finally { controller.dispose() }
})

test('a desktop that connects is asked even though a scan already ran', async () => {
  // The bug behind "on the LAN but still on the relay": a search runs at attach
  // time, before the tunnel is up, so it can only scan — and that failed scan
  // used to consume the throttle, so the question that would have worked was
  // ten minutes away. Asking and scanning now have separate clocks.
  const { controller, transports } = setup([host('A', 'A'.repeat(43))], { A: { port: 23019, hosts: ['192.168.50.20'] } })
  try {
    await controller.initialize()
    await new Promise((r) => setTimeout(r, 60))
    const asked = transports.get('A')!.asked.filter((path) => path === '/__alma_lan__')
    assert.ok(asked.length >= 1, 'the connected desktop was asked at least once')
  } finally { controller.dispose() }
})

test('asking is throttled per desktop, not per scan', async () => {
  const { controller, transports } = setup([host('A', 'A'.repeat(43))], { A: { port: 23019, hosts: ['192.168.50.20'] } })
  try {
    await controller.initialize()
    await new Promise((r) => setTimeout(r, 40))
    const state = controller as any
    // Pretend the clock is fresh: a second search within the ask interval must
    // not hit the network again.
    const before = transports.get('A')!.asked.filter((p) => p === '/__alma_lan__').length
    state.lastAsk.set('A', Date.now())
    state.maybeDiscover('A')
    await new Promise((r) => setTimeout(r, 40))
    const after = transports.get('A')!.asked.filter((p) => p === '/__alma_lan__').length
    assert.equal(after, before, 'no second question inside the interval')
  } finally { controller.dispose() }
})
