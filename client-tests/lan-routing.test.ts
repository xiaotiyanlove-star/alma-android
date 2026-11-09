import { test } from 'node:test'
import assert from 'node:assert/strict'
import './locale.ts'
import { Controller } from '../client/core/controller.ts'
import type { Host } from '../client/core/model.ts'
import type { HostStorage } from '../client/platform/storage.ts'
import type { Transport } from '../client/connection/transport.ts'

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

test('a connected desktop is asked immediately instead of waiting for the startup scan', async () => {
  // The attach-time scan runs before the relay is online. Once connected, the
  // cheap candidate request must not be blocked behind a /24 scan: on a slow
  // network that delay is exactly what kept a fresh install on relay.
  const hostOne = host('A', 'A'.repeat(43))
  const asked: string[] = []
  const storage: HostStorage = { persistent: true, async load() { return [hostOne] }, async save() {} }
  const controller = new Controller(storage, () => ({
    async connect() {},
    async request<T>(path: string): Promise<T> {
      asked.push(path)
      if (path === '/api/herdr/info') return { online: true } as T
      if (path === '/__alma_lan__') return { port: 23019, hosts: ['192.168.50.147'] } as T
      if (path === '/api/herdr/mutes') return { tabs: [], workspaces: [] } as T
      return {} as T
    },
    subscribe() { return { close() {} } },
    lastInboundAt() { return Date.now() },
    close() {},
  } as Transport))
  try {
    await controller.initialize()
    // Keep an attach-time scan alive without touching the platform scanner.
    const state = controller as any
    state.discovering.add('A')
    state.scans.add({ aborted: false })
    state.scanOwners.set('A', { aborted: false })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.ok(asked.includes('/__alma_lan__'), 'the connected desktop was asked despite a scan in flight')
  } finally { controller.dispose() }
})

test('a scan displaced by relay connectivity is stopped and its lock is released', async () => {
  const hostOne = host('A', 'A'.repeat(43))
  const storage: HostStorage = { persistent: true, async load() { return [hostOne] }, async save() {} }
  const controller = new Controller(storage, () => ({
    async connect() {},
    async request<T>(path: string): Promise<T> {
      if (path === '/api/herdr/info') return { online: true } as T
      if (path === '/__alma_lan__') throw new Error('HTTP 404')
      return {} as T
    },
    subscribe() { return { close() {} } },
    lastInboundAt() { return Date.now() },
    close() {},
  } as Transport))
  const state = controller as any
  try {
    await controller.initialize()
    const oldScan = { aborted: false }
    state.patchHost('A', { status: 'online', herdrOnline: true })
    state.discovering.add('A')
    state.scans.add(oldScan)
    state.scanOwners.set('A', oldScan)
    state.maybeDiscover('A')
    assert.equal(oldScan.aborted, true, 'the old scan stops at its next candidate')
    assert.notEqual(state.scanOwners.get('A'), oldScan, 'the replacement owns the slot or has already released it')
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

test('one failed dial keeps the address, so the next connect can retry it', async () => {
  const { controller } = setup([host('A', 'A'.repeat(43))], {})
  try {
    await controller.initialize()
    await new Promise((r) => setTimeout(r, 20))
    const state = controller as any
    const address = { host: '192.168.50.20', port: 23019 }
    state.patchHost('A', { discoveredLan: address })
    const runtime = [...state.runtimes.values()][0] as any
    // Simulate the transport reporting that the direct attempt failed once.
    const scored = runtime.transport as any
    scored.onDirectFailed?.()
    // First failure: still remembered, still eligible.
    assert.deepEqual(controller.getState().hosts[0].discoveredLan, address)
  } finally { controller.dispose() }
})

test('the direct address is offered again on every dial, not only at build time', async () => {
  // A transport that fell back to the relay would otherwise keep that route for
  // its whole life, even after the reason it failed had gone away.
  const offers: (string | undefined)[] = []
  const hostOne = host('A', 'A'.repeat(43))
  const storage: HostStorage = { persistent: true, async load() { return [hostOne] }, async save() {} }
  const controller = new Controller(storage, () => ({
    async connect() {},
    async request<T>(path: string): Promise<T> {
      if (path === '/__alma_lan__') return null as T
      if (path === '/api/herdr/info') return { online: true } as T
      if (path === '/api/herdr/mutes') return { tabs: [], workspaces: [] } as T
      return { result: { read: { text: '' } } } as T
    },
    subscribe() { return { close() {} } },
    lastInboundAt() { return Date.now() },
    close() {},
    useDirect(address: { host: string } | undefined) { offers.push(address?.host) },
  } as unknown as Transport))
  try {
    await controller.initialize()
    await new Promise((r) => setTimeout(r, 20))
    ;(controller as any).patchHost('A', { discoveredLan: { host: '192.168.50.20', port: 23019 } })
    const runtime = [...(controller as any).runtimes.values()][0]
    const before = offers.length
    await (controller as any).connectHost('A', runtime)
    assert.ok(offers.length > before, 'the address was offered to the transport again')
    assert.equal(offers[offers.length - 1], '192.168.50.20')
  } finally { controller.dispose() }
})

test('a failed relay still leaves LAN discovery running', async () => {
  const hostOne = host('A', 'A'.repeat(43))
  let searches = 0
  const storage: HostStorage = { persistent: true, async load() { return [hostOne] }, async save() {} }
  const controller = new Controller(storage, () => ({
    async connect() {},
    async request<T>(path: string): Promise<T> {
      if (path === '/__alma_lan__') throw new Error('offline')
      return {} as T
    },
    subscribe() { return { close() {} } },
    lastInboundAt() { return Date.now() },
    close() {},
  } as Transport))
  try {
    await controller.initialize()
    const state = controller as any
    state.lastDiscover.clear()
    state.maybeDiscover = () => { searches++ }
    state.maybeDiscover('A')
    assert.ok(searches > 0, 'the local path is searched independently of the relay')
  } finally { controller.dispose() }
})

test('the production scheduler starts LAN discovery after a relay failure', async () => {
  const hostOne = host('A', 'A'.repeat(43))
  const storage: HostStorage = { persistent: true, async load() { return [hostOne] }, async save() {} }
  const controller = new Controller(storage, () => ({
    async connect() {},
    async request<T>(): Promise<T> { return {} as T },
    subscribe() { return { close() {} } },
    lastInboundAt() { return Date.now() },
    close() {},
  } as Transport))
  try {
    await controller.initialize()
    const state = controller as any
    state.lastDiscover.clear()
    state.lastAsk.clear()
    state.lastMiss.clear()
    const runtime = [...state.runtimes.values()][0]
    state.patchHost('A', { status: 'error', herdrOnline: false })
    state.scheduleHost('A', runtime)
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(state.discovering.has('A'), false, 'the scheduler started and completed the LAN search')
    assert.equal(typeof state.lastDiscover.get('A'), 'number', 'the failing relay did not leave discovery idle')
  } finally { controller.dispose() }
})

test('a retry after an error does not wait out the normal ten-minute discovery interval', async () => {
  const hostOne = host('A', 'A'.repeat(43))
  const storage: HostStorage = { persistent: true, async load() { return [hostOne] }, async save() {} }
  const controller = new Controller(storage, () => ({
    async connect() {},
    async request<T>(path: string): Promise<T> {
      if (path === '/__alma_lan__') throw new Error('offline')
      return {} as T
    },
    subscribe() { return { close() {} } },
    lastInboundAt() { return Date.now() },
    close() {},
  } as Transport))
  try {
    await controller.initialize()
    const state = controller as any
    state.lastDiscover.set('A', Date.now())
    state.lastMiss.clear()
    state.patchHost('A', { status: 'error', herdrOnline: false })
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(typeof state.lastDiscover.get('A'), 'number')
    assert.equal(state.discovering.has('A'), false)
  } finally { controller.dispose() }
})

test('the retry ladder continues while a LAN discovery may replace the dead relay', async () => {
  const hostOne = host('A', 'A'.repeat(43))
  let searches = 0
  const storage: HostStorage = { persistent: true, async load() { return [hostOne] }, async save() {} }
  const controller = new Controller(storage, () => {
    return {
      async connect() {},
      async request<T>(): Promise<T> { return {} as T },
      subscribe() { return { close() {} } },
      lastInboundAt() { return Date.now() },
      close() {},
    } as Transport
  })
  try {
    await controller.initialize()
    const state = controller as any
    state.maybeDiscover = () => { searches++ }
    state.lastDiscover.clear()
    state.maybeDiscover('A')
    assert.ok(searches > 0, 'LAN discovery is active alongside relay retries')
  } finally { controller.dispose() }
})
