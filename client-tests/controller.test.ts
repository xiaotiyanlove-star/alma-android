import { test } from 'node:test'
import assert from 'node:assert/strict'
import './locale.ts'
import { Controller, agentLaunchCommand, transcriptGap } from '../client/controller.ts'
import { RejectedError } from '../client/transport.ts'
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
    if (path === '/api/herdr/info') return { online: true } as any
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
  lastInboundAt() { return 0 }
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
      if (path === '/api/herdr/info') return { online: true } as any
      if (path.startsWith('/api/herdr/chat')) {
        const current = controller.getState().session?.hostId === 'A' ? sessionA : sessionB
        if (path.includes('before=')) {
          await gate
          return { session_id: current, page: { start: 0, end: 10, items: [{ id: 'stale', kind: 'assistant', text: 'old' }] } } as T
        }
        return { session_id: current, page: { start: 10, end: 20, items: [{ id: 'head', kind: 'assistant', text: 'head' }] } } as T
      }
      return { result: { read: { text: '' } } } as any
    },
    subscribe() { return { close() {} } },
    lastInboundAt() { return 0 },
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

test('a new session starts the agent directly instead of typing into a shell', async () => {
  const { controller, transports } = setup()
  try {
    await controller.initialize(); await wait()
    const transport = transports.get('A')!
    transport.request = async (path: string, body?: unknown): Promise<any> => {
      transport.calls.push({ path, body })
      if (path === '/api/herdr/info') return { online: true } as any
      if ((body as any)?.method === 'layout.apply') return { result: { tab_id: 'w1:t9', workspace_id: 'w1', focused_pane_id: 'w1:p9' } } as any
      return { result: { read: { text: '' } } } as any
    }
    const { paneId } = await controller.newSession('A', { kind: 'claude', cwd: '/tmp', label: 'named' })
    assert.equal(paneId, 'w1:p9')
    const methods = transport.calls.map((call) => (call.body as any)?.method).filter(Boolean)
    // agent.start types the command into a shell whose rc files may still be
    // reading; it is the source of the swallowed first letter.
    assert.equal(methods.includes('agent.start'), false, 'must not type the agent command into a shell')
    assert.equal(methods.includes('tab.create'), false, 'the pane must come from the same request')
    const apply = transport.calls.find((call) => (call.body as any)?.method === 'layout.apply')!.body as any
    assert.deepEqual(apply.params.root.command, ['/bin/sh', '-lc', 'claude; exec "${SHELL:-/bin/sh}" -il'])
    assert.equal(apply.params.tab_label, 'named')
    assert.equal(apply.params.root.cwd, '/tmp')
  } finally { controller.dispose() }
})

test('only one process is started, so a login shell cannot race the agent', () => {
  const [program, flag, script] = agentLaunchCommand('codex')
  assert.equal(program, '/bin/sh')
  assert.equal(flag, '-lc')
  assert.equal(script, 'codex; exec "${SHELL:-/bin/sh}" -il')
  // A kind is interpolated into a shell line, so anything but a plain command
  // name must fall back instead of running whatever the caller sent.
  assert.equal(agentLaunchCommand('claude; rm -rf /')[2], 'claude; exec "${SHELL:-/bin/sh}" -il')
})

test('renaming a session writes the label to its Herdr tab', async () => {
  const { controller, transports } = setup()
  try {
    await controller.initialize(); await wait()
    const transport = transports.get('A')!
    controller.selectHost('A')
    // The list needs the pane and its tab before a rename can resolve one.
    transport.subscriptions.find((sub) => sub.path === '/ws/herdr')?.receive({
      type: 'snapshot',
      snapshot: {
        workspaces: [{ workspace_id: 'w1', label: 'tmp' }],
        tabs: [{ tab_id: 'w1:t7', workspace_id: 'w1', label: '2' }],
        panes: [{ pane_id: 'w1:p7', workspace_id: 'w1', tab_id: 'w1:t7', cwd: '/tmp' }],
      },
    })
    transport.request = async (path: string, body?: unknown): Promise<any> => {
      transport.calls.push({ path, body })
      if (path === '/api/herdr/info') return { online: true } as any
      return { result: {} } as any
    }
    await controller.renameSession('A', 'w1:p7', '  部署脚本  ')
    const rename = transport.calls.find((call) => (call.body as any)?.method === 'tab.rename')!.body as any
    assert.deepEqual(rename.params, { tab_id: 'w1:t7', label: '部署脚本' })
    assert.equal(controller.getState().hosts[0].snapshot?.tabs?.[0].label, '部署脚本', 'the list updates without waiting for a snapshot')
  } finally { controller.dispose() }
})

test('a desktop without the layout API still creates a session', async () => {
  const { controller, transports } = setup()
  try {
    await controller.initialize(); await wait()
    const transport = transports.get('A')!
    transport.request = async (path: string, body?: unknown): Promise<any> => {
      transport.calls.push({ path, body })
      const method = (body as any)?.method
      if (path === '/api/herdr/info') return { online: true }
      // Herdr names the method it does not know, which is how the client tells
      // "too old for this API" apart from "this call failed".
      if (method === 'layout.apply') throw new Error('invalid request: unknown variant `layout.apply`, expected one of `tab.create`, `agent.start`')
      if (method === 'tab.create') return { result: { tab: { tab_id: 'w1:t5', workspace_id: 'w1' }, root_pane: { pane_id: 'w1:p5', workspace_id: 'w1' } } }
      return { result: {} }
    }
    const { paneId } = await controller.newSession('A', { kind: 'codex', cwd: '/tmp' })
    assert.equal(paneId, 'w1:p5')
    const methods = transport.calls.map((call) => (call.body as any)?.method).filter(Boolean)
    assert.deepEqual(methods.slice(-2), ['tab.create', 'agent.start'])
  } finally { controller.dispose() }
})

// ── a pane with no transcript ───────────────────────────────────────────
test('a freshly started agent waits for its session id instead of blaming the integration', () => {
  // Alma recognises the agent but the integration has not reported an id yet.
  assert.equal(transcriptGap('no_agent_session', { pane_id: 'p', workspace_id: 'w', tab_id: 't', agent: 'claude' }, false), 'waiting')
})

test('a known session id with no transcript in place is not an install problem', () => {
  // Alma had an id and looked for the file, so nothing was missing from the
  // integration; the CLI just keeps its transcript somewhere else.
  assert.equal(transcriptGap('transcript_not_found', { pane_id: 'p', workspace_id: 'w', tab_id: 't', agent: 'claude', agent_status: 'working' }, true), 'transcript')
})

test('an agent that has done work and still has no session id needs the integration', () => {
  const pane = { pane_id: 'p', workspace_id: 'w', tab_id: 't', agent: 'claude', agent_status: 'working' } as const
  assert.equal(transcriptGap('no_agent_session', pane, false), 'integration', 'the status line already says it started')
  assert.equal(transcriptGap('no_agent_session', { ...pane, agent_status: 'idle' }, true), 'integration', 'or the user sent it a message')
  assert.equal(transcriptGap('no_agent_session', { ...pane, agent_status: 'done' }, false), 'integration')
})

test('a shell reports no_agent_session too, so the pane decides', () => {
  // The chat endpoint answers no_agent_session for a shell as well; blaming
  // the integration there would send the user chasing an agent that is not
  // running.
  assert.equal(transcriptGap('no_agent_session', { pane_id: 'p', workspace_id: 'w', tab_id: 't' }, false), 'terminal')
  // Before the snapshot arrives nothing can be told apart; stay silent.
  assert.equal(transcriptGap('no_agent_session', undefined, true), 'waiting')
})

test('an agent Alma cannot read is not an integration problem', () => {
  assert.equal(transcriptGap('unsupported_agent', { pane_id: 'p', workspace_id: 'w', tab_id: 't', agent: 'pi', agent_status: 'working' }, true), 'unsupported')
})

test('sending a message turns the wait into a missing integration', async () => {
  const { controller, transports } = setup()
  try {
    await controller.initialize(); await wait()
    controller.selectHost('A')
    const transport = transports.get('A')!
    // An agent painted on the pane, but the chat endpoint has nothing for it.
    transport.subscriptions.find((sub) => sub.path === '/ws/herdr')?.receive({
      type: 'snapshot',
      snapshot: { workspaces: [{ workspace_id: 'w1' }], panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', agent: 'claude', agent_status: 'idle' }] },
    })
    transport.request = async (path: string, body?: unknown): Promise<any> => {
      transport.calls.push({ path, body })
      if (path === '/api/herdr/info') return { online: true }
      if (path.startsWith('/api/herdr/chat')) return { error: { code: 'no_agent_session' } }
      return { result: { read: { text: '' } } }
    }
    await controller.selectPane('w1:p1')
    assert.equal(controller.getState().session?.gap, 'waiting', 'nothing has been sent yet')
    assert.equal(controller.getState().session?.unsupported, true)
    assert.equal(controller.getState().session?.sentMessage, false)

    await controller.sendMessage('synthetic message')
    assert.equal(controller.getState().session?.sentMessage, true)
    await controller.reloadSession()
    assert.equal(controller.getState().session?.gap, 'integration')
  } finally { controller.dispose() }
})

test('the id arriving after the wait restores the conversation', async () => {
  const { controller, transports } = setup()
  try {
    await controller.initialize(); await wait()
    controller.selectHost('A')
    const transport = transports.get('A')!
    let missing = true
    transport.request = async (path: string, body?: unknown): Promise<any> => {
      transport.calls.push({ path, body })
      if (path === '/api/herdr/info') return { online: true }
      if (path.startsWith('/api/herdr/chat')) {
        if (missing) return { error: { code: 'no_agent_session' } }
        return { session_id: 's1', page: { start: 0, end: 1, items: [{ id: 'm1', kind: 'assistant', text: 'hello' }] } }
      }
      return { result: { read: { text: '' } } }
    }
    await controller.selectPane('w1:p1')
    assert.equal(controller.getState().session?.unsupported, true)
    missing = false
    await controller.reloadSession()
    assert.equal(controller.getState().session?.unsupported, false)
    assert.equal(controller.getState().session?.gap, undefined)
    assert.equal(controller.getState().session?.items[0].text, 'hello')
  } finally { controller.dispose() }
})

// ── creating a session ──────────────────────────────────────────────────
test('the real layout.apply reply shape yields the new pane', async () => {
  // Herdr answers `{ type: 'layout_apply', layout: { … } }`, not a flat object.
  const { controller, transports } = setup()
  try {
    await controller.initialize(); await wait()
    const transport = transports.get('A')!
    transport.request = async (path: string, body?: unknown): Promise<any> => {
      transport.calls.push({ path, body })
      if (path === '/api/herdr/info') return { online: true }
      if ((body as any)?.method === 'layout.apply') {
        // `rpc` unwraps `result`, so this is the Herdr result object verbatim.
        return { result: { type: 'layout_apply', layout: { workspace_id: 'w1', tab_id: 'w1:t2', zoomed: false, focused_pane_id: 'w1:p2', root: { type: 'pane' } } } }
      }
      return { result: { read: { text: '' } } }
    }
    const created = await controller.newSession('A', { kind: 'claude', cwd: '/tmp' })
    assert.deepEqual(created, { paneId: 'w1:p2', workspaceId: 'w1' })
  } finally { controller.dispose() }
})

test('a reply without a pane id still finds the created pane', async () => {
  // The tab exists either way; failing here would report a create that worked
  // as broken.
  const { controller, transports } = setup()
  try {
    await controller.initialize(); await wait()
    const transport = transports.get('A')!
    transport.request = async (path: string, body?: unknown): Promise<any> => {
      transport.calls.push({ path, body })
      if (path === '/api/herdr/info') return { online: true }
      const method = (body as any)?.method
      if (method === 'layout.apply') return { result: { type: 'layout_apply', layout: { workspace_id: 'w1', tab_id: 'w1:t3' } } }
      if (method === 'tab.get') return { result: { pane: { pane_id: 'w1:p3' } } }
      return { result: {} }
    }
    const created = await controller.newSession('A', { kind: 'codex' })
    assert.equal(created.paneId, 'w1:p3')
  } finally { controller.dispose() }
})

test('creating a session is allowed to take longer than a read', async () => {
  // A slow agent start must not become "operation may have run": the request
  // went out, so a short deadline misreports a success as an uncertain one.
  const { controller, transports } = setup()
  try {
    await controller.initialize(); await wait()
    const transport = transports.get('A')!
    const timeouts: unknown[] = []
    transport.request = async (path: string, body?: unknown, init?: any): Promise<any> => {
      transport.calls.push({ path, body })
      if (path === '/api/herdr/info') return { online: true }
      if ((body as any)?.method === 'layout.apply') { timeouts.push(init?.timeoutMs); return { result: { type: 'layout_apply', layout: { workspace_id: 'w1', focused_pane_id: 'w1:p9' } } } }
      return { result: {} }
    }
    await controller.newSession('A', { kind: 'claude' })
    assert.ok(typeof timeouts[0] === 'number' && (timeouts[0] as number) >= 60_000, `create deadline was ${timeouts[0]}`)
  } finally { controller.dispose() }
})

// ── the phone bridge's allowlist ────────────────────────────────────────
test('a method the phone may not call falls back to the allowlisted path', async () => {
  // Alma's phone bridge answers 403 for anything outside its allowlist, and
  // `layout.apply` is not in it. Reporting that as "may have run" is wrong on
  // both counts: nothing ran, and tab.create + agent.start would have worked.
  const { controller, transports } = setup()
  try {
    await controller.initialize(); await wait()
    const transport = transports.get('A')!
    transport.request = async (path: string, body?: unknown): Promise<any> => {
      transport.calls.push({ path, body })
      const method = (body as any)?.method
      if (path === '/api/herdr/info') return { online: true }
      if (method === 'layout.apply') throw new RejectedError(403, 'layout.apply is not available from the phone')
      if (method === 'tab.create') return { result: { tab: { tab_id: 'w1:t4', workspace_id: 'w1' }, root_pane: { pane_id: 'w1:p4', workspace_id: 'w1' } } }
      return { result: {} }
    }
    const created = await controller.newSession('A', { kind: 'claude', cwd: '/tmp', label: 'named' })
    assert.equal(created.paneId, 'w1:p4')
    const methods = transport.calls.map((call) => (call.body as any)?.method).filter(Boolean)
    assert.deepEqual(methods.slice(-3), ['layout.apply', 'tab.create', 'agent.start'])

    // The next create goes straight to the working path.
    transport.calls.length = 0
    await controller.newSession('A', { kind: 'codex' })
    const second = transport.calls.map((call) => (call.body as any)?.method).filter(Boolean)
    assert.equal(second.includes('layout.apply'), false, 'a refused method is not retried on every create')
    assert.deepEqual(second.slice(0, 2), ['tab.create', 'agent.start'])
  } finally { controller.dispose() }
})

test('the allowlisted path still names and cwds the new session', async () => {
  const { controller, transports } = setup()
  try {
    await controller.initialize(); await wait()
    const transport = transports.get('A')!
    transport.request = async (path: string, body?: unknown): Promise<any> => {
      transport.calls.push({ path, body })
      const method = (body as any)?.method
      if (path === '/api/herdr/info') return { online: true }
      if (method === 'layout.apply') throw new RejectedError(403, 'not available from the phone')
      if (method === 'tab.create') return { result: { tab: { tab_id: 'w1:t4', workspace_id: 'w1' }, root_pane: { pane_id: 'w1:p4' } } }
      return { result: {} }
    }
    await controller.newSession('A', { kind: 'claude', cwd: '/Users/me/project', label: '发布流程' })
    const create = transport.calls.find((call) => (call.body as any)?.method === 'tab.create')!.body as any
    assert.equal(create.params.cwd, '/Users/me/project')
    assert.equal(create.params.label, '发布流程')
    assert.equal(create.params.focus, false)
  } finally { controller.dispose() }
})
