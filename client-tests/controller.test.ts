import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Controller } from '../client/controller.ts'
import type { Host } from '../client/model.ts'
import type { HostStorage } from '../client/storage.ts'
import type { Transport } from '../client/transport.ts'

const hosts: Host[] = ['A', 'B'].map((id) => ({ id, name: id, relayUrl: `https://${id.toLowerCase()}.invalid`, connectCode: id.repeat(43), addedAt: 0 }))
class FakeTransport implements Transport {
  calls: { path: string; body?: any }[] = []
  subscriptions: { path: string; receive(frame: any): void; onClose(): void; closed: boolean }[] = []
  deferred?: () => Promise<any>
  constructor(readonly host: Host) {}
  async connect() {}
  async request<T>(path: string, body?: unknown): Promise<T> {
    this.calls.push({ path, body })
    if (path === '/api/herdr/info') return { online: true } as T
    if (path.startsWith('/api/herdr/chat')) {
      if (this.deferred) return this.deferred()
      return { session_id: `session-${this.host.id}`, page: { start: 0, end: 20, items: [{ id: 'm1', kind: 'assistant', text: this.host.id }] }, queued: [] } as T
    }
    return { result: { read: { text: `screen-${this.host.id}` } } } as T
  }
  subscribe(path: string, receive: (frame: any) => void, onClose: () => void) {
    const sub = { path, receive, onClose, closed: false }; this.subscriptions.push(sub)
    return { close: () => { sub.closed = true } }
  }
  close() {}
}
const wait = () => new Promise((resolve) => setTimeout(resolve, 5))
function setup() {
  const transports = new Map<string, FakeTransport>()
  const storage: HostStorage = { persistent: true, async load() { return hosts }, async save() {} }
  const controller = new Controller(storage, (host) => { const transport = new FakeTransport(host); transports.set(host.id, transport); return transport })
  return { controller, transports }
}
test('same pane IDs on different hosts never share content or send destinations', async () => {
  const { controller, transports } = setup()
  try {
    await controller.initialize(); await wait()
    controller.selectHost('A'); await controller.selectPane('w1:p1')
    assert.equal(controller.getState().session?.items[0].text, 'A')
    controller.selectHost('B'); await controller.selectPane('w1:p1')
    await controller.sendMessage('synthetic message')
    assert.equal(controller.getState().session?.items[0].text, 'B')
    assert.equal(transports.get('A')!.calls.filter((x) => x.body?.method === 'agent.prompt').length, 0)
    assert.equal(transports.get('B')!.calls.filter((x) => x.body?.method === 'agent.prompt').length, 1)
  } finally { controller.dispose() }
})
test('late history from old host cannot overwrite currently selected host', async () => {
  const { controller, transports } = setup()
  try {
    await controller.initialize(); await wait()
    let resolve!: (value: any) => void
    transports.get('A')!.deferred = () => new Promise((r) => { resolve = r })
    controller.selectHost('A'); const loadingA = controller.selectPane('w1:p1')
    controller.selectHost('B'); await controller.selectPane('w1:p1')
    resolve({ session_id: 'old', page: { items: [{ id: 'm', kind: 'assistant', text: 'old-A' }], start: 0, end: 1 } })
    await loadingA
    assert.equal(controller.getState().session?.hostId, 'B')
    assert.equal(controller.getState().session?.items[0].text, 'B')
  } finally { controller.dispose() }
})
test('adding a host while another pane is open clears the old mutation target', async () => {
  const { controller, transports } = setup()
  try {
    await controller.initialize(); await wait()
    controller.selectHost('A'); await controller.selectPane('w1:p1')
    const other = `alma://connect?u=${encodeURIComponent('https://b.invalid')}&k=${'B'.repeat(43)}&e2e=1`
    await controller.addHost('B', other)
    assert.equal(controller.getState().session, undefined)
    assert.equal(controller.getState().selectedPaneId, undefined)
    await assert.rejects(controller.sendMessage('must not reach A'))
    assert.equal(transports.get('A')!.calls.filter((x) => x.body?.method === 'agent.prompt').length, 0)
  } finally { controller.dispose() }
})
test('concurrent forgets do not resurrect a removed host', async () => {
  let saved: Host[] = [...hosts]
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const storage: HostStorage = { persistent: true, async load() { return hosts }, async save(next) { await gate; saved = [...next] } }
  const controller = new Controller(storage, (host) => new FakeTransport(host))
  try {
    await controller.initialize(); await wait()
    const a = controller.forgetHost('A'), b = controller.forgetHost('B')
    release(); await Promise.all([a, b]); await wait()
    assert.deepEqual(saved.map((h) => h.id), [])
    assert.equal(controller.getState().hosts.length, 0)
  } finally { controller.dispose() }
})
test('stale older-page response cannot splice into a changed session', async () => {
  let finish!: () => void
  const gate = new Promise<void>((r) => { finish = r })
  const sessionA = 'session-A', sessionB = 'session-B'
  const fake: Transport = {
    async connect() {},
    async request<T>(path: string): Promise<T> {
      if (path === '/api/herdr/info') return { online: true } as T
      if (path.startsWith('/api/herdr/chat')) {
        const current = controller.getState().session?.hostId === 'A' ? sessionA : sessionB
        if (path.includes('before=')) {
          await gate
          return { session_id: current, page: { start: 0, end: 10, items: [{ id: 'stale', kind: 'assistant', text: 'old' }] } } as T
        }
        return { session_id: current, page: { start: 10, end: 20, items: [{ id: 'head', kind: 'assistant', text: 'head' }] } } as T
      }
      return { result: { read: { text: '' } } } as T
    },
    subscribe() { return { close() {} } },
    close() {},
  }
  const controller = new Controller({ persistent: true, async load() { return hosts }, async save() {} }, () => fake)
  try {
    await controller.initialize(); await wait()
    controller.selectHost('A'); await controller.selectPane('w1:p1')
    const older = controller.loadOlder()
    controller.selectHost('B'); await controller.selectPane('w1:p1')
    finish(); await older
    assert.equal(controller.getState().session?.hostId, 'B')
    assert.equal(controller.getState().session?.items.some((x) => x.id === 'stale'), false)
  } finally { controller.dispose() }
})
test('session change resets old chat identity before requesting fresh history', async () => {
  const { controller, transports } = setup()
  try {
    await controller.initialize(); await wait()
    controller.selectHost('A'); await controller.selectPane('w1:p1')
    const sub = transports.get('A')!.subscriptions.find((x) => x.path.startsWith('/ws/herdr/chat'))!
    assert.ok(sub.path.endsWith('from=20'))
    sub.receive({ type: 'session_changed', session_id: 'new' })
    assert.equal(controller.getState().session?.items.length, 0)
    assert.equal(controller.getState().session?.sessionId, undefined)
  } finally { controller.dispose() }
})
