import { test } from 'node:test'
import assert from 'node:assert/strict'
import './locale.ts'
import { Controller } from '../client/core/controller.ts'
import { clearAllBreakers } from '../client/connection/breaker.ts'
import type { Host } from '../client/core/model.ts'
import type { HostStorage } from '../client/platform/storage.ts'
import type { Transport } from '../client/connection/transport.ts'

/**
 * Moving an open session from the relay to the local network.
 *
 * The route change used to be a reconnect: the relay tunnel closed first and a
 * new one dialled second, so the session reloaded, the composer greyed out and
 * a reply that arrived in that gap was lost. Every case below pins the shape of
 * the replacement — dial first, publish second, close third — because the value
 * of the change is precisely that the user never sees it happen.
 */

const host: Host = { id: 'A', name: 'A', relayUrl: 'https://a.invalid', connectCode: 'A'.repeat(43), addedAt: 0 }
const ADDRESS = { host: '192.168.50.20', port: 23019 }

interface Fake extends Transport {
  log: string[]
  route?: 'direct' | 'relay'
  direct?: { host: string; port: number }
  inFlight?: boolean
  useDirect(address?: { host: string; port: number }): void
  currentRoute(): 'direct' | 'relay' | undefined
  busy(): boolean
}

/**
 * A transport that records the order of everything and can be told which path
 * it will open. `lanFails` models a listener that is not answering.
 */
function fake(name: string, order: string[], options: { lanFails?: boolean } = {}) {
  const log: string[] = []
  const note = (entry: string) => { log.push(entry); order.push(entry) }
  const transport: Fake = {
    log,
    direct: undefined,
    inFlight: false,
    async connect() { note(`${name}:connect`) },
    async request<T>(path: string): Promise<T> {
      note(`${name}:request ${path}`)
      if (path === '/api/herdr/info') {
        if (options.lanFails && transport.direct) { transport.route = 'relay'; return { online: true } as T }
        transport.route = transport.direct ? 'direct' : 'relay'
        return { online: true } as T
      }
      if (path === '/api/herdr/mutes') return { tabs: [], workspaces: [] } as T
      if (path === '/__alma_lan__') return { port: 23019, hosts: ['192.168.50.20'] } as T
      return {} as T
    },
    subscribe() { note(`${name}:subscribe`); return { close() { note(`${name}:unsubscribe`) } } },
    lastInboundAt() { return Date.now() },
    close() { log.push(`${name}:close`); order.push(`${name}:close`) },
    useDirect(address?: { host: string; port: number }) { transport.direct = address; note(`${name}:useDirect ${address ? 'set' : 'none'}`) },
    currentRoute() { return transport.route },
    busy() { return transport.inFlight === true },
  }
  return transport
}

function setup(options: { lanFails?: boolean } = {}) {
  const made: Fake[] = []
  /** Every event from every transport, in the order it happened. */
  const order: string[] = []
  const storage: HostStorage = { persistent: true, async load() { return [host] }, async save() {} }
  const controller = new Controller(storage, () => {
    const transport = fake(`t${made.length + 1}`, order, options)
    made.push(transport)
    return transport
  })
  return { controller, made, order }
}

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms))

test('the new tunnel is published before the relay one is closed', async () => {
  clearAllBreakers()
  const { controller, made, order } = setup()
  try {
    await controller.initialize()
    await settle()
    const relay = made[0]
    // The relay has opened; nothing is known about a local address yet.
    assert.equal(controller.getState().hosts[0].status, 'online')
    relay.log.length = 0

    await (controller as any).adoptLan('A', ADDRESS)
    await settle()

    const fresh = made[1]
    assert.ok(fresh, 'a second tunnel was dialled')
    // Order: the replacement answers before the old tunnel lets go.
    const answered = order.indexOf('t2:request /api/herdr/info')
    const closed = order.indexOf('t1:close')
    assert.ok(answered >= 0, 'the local tunnel answered')
    assert.ok(closed > answered, 'the relay tunnel is closed only once the new one is up')
    assert.equal(controller.getState().hosts[0].status, 'online', 'the desktop never looked offline')
    assert.equal(controller.getState().hosts[0].route, 'direct')
  } finally { controller.dispose() }
})

test('a local address that does not answer leaves the relay tunnel alone', async () => {
  clearAllBreakers()
  const { controller, made } = setup({ lanFails: true })
  try {
    await controller.initialize()
    await settle()
    const relay = made[0]
    relay.log.length = 0
    await (controller as any).adoptLan('A', ADDRESS)
    await settle()
    // The replacement dialled, fell back to the relay, and was refused: the
    // address never answered, so it is not worth promoting.
    assert.equal(relay.log.includes('t1:close'), false, 'the working tunnel was not closed')
    assert.equal(controller.getState().hosts[0].status, 'online')
    assert.equal((controller as any).runtimes.get('A').transport, relay, 'the original runtime is still in place')
  } finally { controller.dispose() }
})

test('a mutation in flight defers the switch instead of moving it', async () => {
  clearAllBreakers()
  const { controller, made } = setup()
  try {
    await controller.initialize()
    await settle()
    const relay = made[0]
    relay.inFlight = true
    relay.log.length = 0
    await (controller as any).adoptLan('A', ADDRESS)
    await settle()
    assert.equal(made.length, 1, 'no second tunnel while a mutation is outstanding')
    assert.equal(relay.log.includes('t1:close'), false)
    // The address is still remembered, so the next natural reconnect uses it.
    assert.deepEqual(controller.getState().hosts[0].discoveredLan, ADDRESS)
  } finally { controller.dispose() }
})

test('an address already in use is not dialled a second time', async () => {
  clearAllBreakers()
  const { controller, made } = setup()
  try {
    await controller.initialize()
    await settle()
    made[0].route = 'direct'
    await (controller as any).adoptLan('A', ADDRESS)
    await settle()
    assert.equal(made.length, 1, 'a second handshake to the same listener proves nothing')
  } finally { controller.dispose() }
})

test('a desktop that disappeared during the dial is not resurrected', async () => {
  clearAllBreakers()
  const { controller, made } = setup()
  try {
    await controller.initialize()
    await settle()
    const relay = made[0]
    const switching = (controller as any).adoptLan('A', ADDRESS)
    // The user forgets the desktop while the local tunnel is being dialled.
    await controller.forgetHost('A')
    await switching
    await settle()
    const fresh = made[1]
    assert.ok(fresh.log.includes('t2:close'), 'the new tunnel was closed rather than installed')
    assert.equal((controller as any).runtimes.has('A'), false, 'and no runtime was put back')
    void relay
  } finally { controller.dispose() }
})
