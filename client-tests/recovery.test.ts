import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Controller } from '../client/controller.ts'
import type { Host } from '../client/model.ts'
import type { Transport } from '../client/transport.ts'
const host: Host = { id: 'A', name: 'A', relayUrl: 'https://a.invalid', connectCode: 'A'.repeat(43), addedAt: 0 }
class Fake implements Transport {
  calls: { path: string; body?: any }[] = []
  subs: { path: string; receive(x: any): void; closed(): void }[] = []
  pageEnd = 10
  async connect() {}
  async request<T>(path: string, body?: unknown): Promise<T> {
    this.calls.push({ path, body })
    if (path === '/api/herdr/info') return { online: true } as T
    if (path.startsWith('/api/herdr/chat')) return { session_id: 'session', page: { start: 0, end: this.pageEnd, items: [{ id: 'm1', kind: 'assistant', text: 'synthetic' }] } } as T
    return { result: { read: { text: 'screen' } } } as T
  }
  subscribe(path: string, receive: (x: any) => void, closed: () => void) { this.subs.push({ path, receive, closed }); return { close() {} } }
  close() {}
}
async function setup() { const fake = new Fake(); const controller = new Controller({ persistent: true, async load() { return [host] }, async save() {} }, () => fake); await controller.initialize(); await new Promise((r) => setTimeout(r, 1)); controller.selectHost('A'); await controller.selectPane('w1:p1'); return { fake, controller } }
test('terminal text uses bracketed text then canonical enter, not key-name text', async () => {
  const { fake, controller } = await setup()
  try {
    await controller.sendTerminalText('中文 input')
    const actions = fake.calls.filter((x) => x.body && ['pane.send_text', 'pane.send_keys'].includes(x.body.method))
    assert.equal(actions[0].body.method, 'pane.send_text'); assert.equal(actions[0].body.params.text, '\u001b[200~中文 input\u001b[201~')
    assert.deepEqual(actions[1].body.params.keys, ['enter'])
    await controller.sendKeys(['Up', 'Escape', 'C-c'])
    assert.deepEqual(fake.calls.filter((x) => x.body?.method === 'pane.send_keys').at(-1)!.body.params.keys, ['up', 'esc', 'ctrl+c'])
  } finally { controller.dispose() }
})
test('reconnect subscribes from last received cursor even if fresh tail advanced far ahead', async () => {
  const { fake, controller } = await setup()
  try {
    const before = fake.subs.filter((x) => x.path.startsWith('/ws/herdr/chat')).at(-1)!
    before.receive({ type: 'items', items: [{ id: 'm2', kind: 'assistant', text: 'new' }], end: 20 })
    fake.pageEnd = 2000
    controller.retryHost('A')
    await new Promise((r) => setTimeout(r, 20))
    const after = fake.subs.filter((x) => x.path.startsWith('/ws/herdr/chat')).at(-1)!
    assert.ok(after.path.endsWith('from=20'))
    assert.deepEqual(controller.getState().session?.items.map((x) => x.id), ['m1', 'm2'])
  } finally { controller.dispose() }
})
test('failed vault load cannot silently overwrite encrypted profiles', async () => {
  let writes = 0
  const controller = new Controller({ persistent: true, async load() { throw new Error('locked') }, async save() { writes++ } })
  try { await controller.initialize(); await assert.rejects(controller.addHost('A', 'not-a-link'), /安全存储/); assert.equal(writes, 0) } finally { controller.dispose() }
})
