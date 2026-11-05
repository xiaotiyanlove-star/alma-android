import { test } from 'node:test'
import assert from 'node:assert/strict'
import './locale.ts'
import { Controller } from '../client/controller.ts'
import type { Host } from '../client/model.ts'
import type { HostStorage } from '../client/storage.ts'
import type { Transport } from '../client/transport.ts'
import { TranscriptCache } from '../client/transcript-cache.ts'

const host: Host = { id: 'A', name: 'A', relayUrl: 'https://a.invalid', connectCode: 'A'.repeat(43), addedAt: 0 }

/** A desktop whose transcripts can be delayed per pane, like a real one. */
function desk() {
  const delays = new Map<string, number>()
  const asked: string[] = []
  const received: { path: string; frame: any }[] = []
  const subs: { path: string; receive(frame: any): void }[] = []
  const transport: Transport = {
    async connect() {},
    async request<T>(path: string): Promise<T> {
      if (path === '/api/herdr/info') return { online: true } as T
      if (path === '/api/herdr/mutes') return { tabs: [], workspaces: [] } as T
      if (path.startsWith('/api/herdr/chat')) {
        const pane = new URL(path, 'https://x').searchParams.get('pane') ?? ''
        asked.push(pane)
        const wait = delays.get(pane) ?? 0
        if (wait) await new Promise((r) => setTimeout(r, wait))
        return { session_id: `sess-${pane}`, page: { start: 0, end: 1, items: [{ id: `m-${pane}`, kind: 'assistant', text: `transcript of ${pane}` }] }, queued: [] } as T
      }
      return { result: { read: { text: '' } } } as T
    },
    subscribe(path: string, receive: (frame: any) => void) {
      subs.push({ path, receive })
      return { close() {} }
    },
    lastInboundAt() { return Date.now() },
    close() {},
  }
  const storage: HostStorage = { persistent: true, async load() { return [host] }, async save() {} }
  const controller = new Controller(storage, () => transport)
  return { controller, delays, asked, subs, received }
}

test('switching panes mid-load never shows the previous pane’s transcript', async () => {
  const { controller, delays } = desk()
  try {
    await controller.initialize()
    await new Promise((r) => setTimeout(r, 10))
    controller.selectHost('A')

    // The first pane is slow, the second answers at once — a desktop under load
    // and a user who taps the next row before the first page arrives.
    delays.set('w1:p1', 80)
    const first = controller.selectPane('w1:p1')
    await new Promise((r) => setTimeout(r, 5))
    const second = controller.selectPane('w1:p2')
    await Promise.all([first, second])

    const session = controller.getState().session
    assert.equal(session?.paneId, 'w1:p2', 'state must describe the pane the user is on')
    assert.deepEqual(session?.items.map((item) => item.id), ['m-w1:p2'], 'and nothing from the other pane')
  } finally { controller.dispose() }
})

test('a late answer for the pane that was left behind is discarded', async () => {
  const { controller, delays } = desk()
  try {
    await controller.initialize()
    await new Promise((r) => setTimeout(r, 10))
    controller.selectHost('A')
    delays.set('w1:p1', 60)
    const first = controller.selectPane('w1:p1')
    await new Promise((r) => setTimeout(r, 5))
    const second = controller.selectPane('w1:p2')
    await Promise.all([first, second])
    // Give the stale page every chance to land.
    await new Promise((r) => setTimeout(r, 120))
    assert.deepEqual(controller.getState().session?.items.map((item) => item.id), ['m-w1:p2'])
  } finally { controller.dispose() }
})

test('a subscription for the pane that was left behind cannot add items', async () => {
  const { controller, subs } = desk()
  try {
    await controller.initialize()
    await new Promise((r) => setTimeout(r, 10))
    controller.selectHost('A')
    await controller.selectPane('w1:p1')
    const firstChat = subs.find((s) => s.path.includes('pane=w1%3Ap1'))
    await controller.selectPane('w1:p2')
    // The desktop pushes an item on the old pane's socket after the switch.
    firstChat?.receive({ type: 'items', items: [{ id: 'late', kind: 'assistant', text: 'from the old pane' }], end: 9 })
    assert.equal(controller.getState().session?.items.some((item) => item.id === 'late'), false)
    assert.deepEqual(controller.getState().session?.items.map((item) => item.id), ['m-w1:p2'])
  } finally { controller.dispose() }
})

test('two panes that share a terminal title still load their own transcripts', async () => {
  // The session list labels rows by the agent's terminal title, which two
  // Claude panes can share. Loading must key on the pane id, never on the name.
  const { controller, asked } = desk()
  try {
    await controller.initialize()
    await new Promise((r) => setTimeout(r, 10))
    controller.selectHost('A')
    await controller.selectPane('w1:p3')
    assert.deepEqual(controller.getState().session?.items.map((item) => item.id), ['m-w1:p3'])
    await controller.selectPane('w1:p4')
    assert.deepEqual(controller.getState().session?.items.map((item) => item.id), ['m-w1:p4'])
    assert.deepEqual(asked, ['w1:p3', 'w1:p4'])
  } finally { controller.dispose() }
})

test('opening a pane on another desktop never reuses the open session', async () => {
  const { controller } = desk()
  try {
    await controller.initialize()
    await new Promise((r) => setTimeout(r, 10))
    controller.selectHost('A')
    await controller.selectPane('w1:p1')
    // Selecting a desktop that has no runtime must not leave the old pane open
    // under the new desktop's name.
    controller.selectHost('B')
    assert.equal(controller.getState().session, undefined, 'the old pane cannot stay open under another desktop')
  } finally { controller.dispose() }
})

test('warming one pane does not evict the pane currently on screen', () => {
  const cache = new TranscriptCache(2)
  const now = Date.now()
  cache.put('A', 'p1', { items: [], start: 0, end: 0, queued: [], screen: '', at: now })
  cache.put('A', 'p2', { items: [], start: 0, end: 0, queued: [], screen: '', at: now })
  cache.put('A', 'p3', { items: [], start: 0, end: 0, queued: [], screen: '', at: now }, { hostId: 'A', paneId: 'p2' })
  assert.ok(cache.take('A', 'p2'))
  assert.ok(cache.take('A', 'p3'))
})

test('transcript cache entries expire instead of painting stale content', () => {
  const cache = new TranscriptCache(2, 100)
  cache.put('A', 'p1', { items: [], start: 0, end: 0, queued: [], screen: '', at: 1_000 })
  assert.ok(cache.take('A', 'p1', 1_050))
  assert.equal(cache.take('A', 'p1', 1_101), undefined)
})

test('an upload that finishes after a pane switch cannot send to the new pane', async () => {
  const sent: unknown[] = []
  const transport = {
    async connect() {},
    async request<T>(path: string, body?: unknown): Promise<T> {
      if (path === '/api/herdr/chat?pane=p1&limit=150') return {
        session_id: 's1', page: { start: 0, end: 1, items: [{ id: 'm1', kind: 'assistant' }] },
      } as T
      if (path === '/api/herdr/chat?pane=p2&limit=150') return {
        session_id: 's2', page: { start: 0, end: 1, items: [{ id: 'm2', kind: 'assistant' }] },
      } as T
      if (path.startsWith('/ws/')) throw new Error('not a request')
      if (path === '/api/herdr/info') return { online: true } as T
      if (path === '/api/herdr/rpc' && body && typeof body === 'object' && 'method' in body) {
        const method = (body as { method?: string }).method
        if (method === 'agent.prompt') sent.push(body)
        if (method === 'pane.read') return { result: { read: { text: '' } } } as T
        return { result: {} } as T
      }
      return {} as T
    },
    subscribe() { return { close() {} } },
    lastInboundAt() { return Date.now() },
    close() {},
  } as Transport
  const storage: HostStorage = { persistent: true, async load() { return [host] }, async save() {} }
  const controller = new Controller(storage, () => transport)
  try {
    await controller.initialize()
    await controller.selectPane('p1')
    const target = controller.sessionTarget()
    assert.ok(target)
    await controller.selectPane('p2')
    await assert.rejects(controller.sendMessage('must not move', target), /会话已切换/)
    assert.equal(sent.length, 0)
  } finally { controller.dispose() }
})

test('a reload cancels the old generation so it cannot subscribe twice', async () => {
  let chatRequests = 0
  let finish!: () => void
  const firstRequest = new Promise<void>((resolve) => { finish = resolve })
  let subscribeCount = 0
  const transport = {
    async connect() {},
    async request<T>(path: string): Promise<T> {
      if (path === '/api/herdr/info') return { online: true } as T
      if (path.includes('/api/herdr/chat?')) {
        chatRequests++
        if (chatRequests === 1) await firstRequest
        return { session_id: 's1', page: { start: 0, end: 0, items: [] } } as T
      }
      return {} as T
    },
    subscribe() { subscribeCount++; return { close() {} } },
    lastInboundAt() { return Date.now() },
    close() {},
  } as Transport
  const storage: HostStorage = { persistent: true, async load() { return [host] }, async save() {} }
  const controller = new Controller(storage, () => transport)
  try {
    await controller.initialize()
    const opening = controller.selectPane('p1')
    await Promise.resolve()
    await controller.reloadSession()
    finish()
    await opening
    assert.equal(chatRequests, 3)
    assert.equal(subscribeCount, 3, 'hub plus only the new chat and screen generations')
  } finally { controller.dispose() }
})
