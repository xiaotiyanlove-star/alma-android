/**
 * Behaviour taken from the official Android client's protocol use.
 *
 * Each test pins a decision that is easy to get subtly wrong: which source
 * wins for the model chip, what a notification button may press, when the
 * idle probe is allowed to declare a tunnel dead, and what the mute list
 * silences.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import './locale.ts'
import { Controller } from '../client/controller.ts'
import { headerInfo } from '../client/session-info.ts'
import { AlertTracker, actionFor, mutedOn } from '../client/notify.ts'
import { optionForIntent, parsePrompt, promptFingerprint, stripAnsi } from '../client/prompt.ts'
import { replyInProgress } from '../client/keepalive.ts'
import { EncryptedTunnel, type SocketLike } from '../client/transport.ts'
import { base64url, createKeyPair, deriveSessionKeys, fromBase64url, openBytes, sealBytes } from '../client/crypto.ts'
import { decodeInnerFrame, encodeInnerFrame } from '../client/frames.ts'
import type { Host, HostState } from '../client/model.ts'
import type { HostStorage } from '../client/storage.ts'
import type { Transport } from '../client/transport.ts'

const wait = () => new Promise((resolve) => setTimeout(resolve, 5))

// ── the desktop's transcript settings ───────────────────────────────────
test('the desktop settings win over a scraped model name', () => {
  const screen = 'some output\n  model: claude-sonnet-5   context left: 40%'
  // Without settings, the screen is all there is.
  assert.equal(headerInfo(screen).model, 'claude-sonnet-5')
  // With settings, a different answer replaces it; the context figure, which
  // the desktop does not send, survives.
  const info = headerInfo(screen, { model: 'claude-opus-5-5', effort: 'high' })
  assert.equal(info.model, 'claude-opus-5-5')
  assert.equal(info.effort, 'high')
  assert.equal(info.contextRatio, 0.6)
})

test('a desktop that says "no model" is believed instead of falling back', () => {
  // `null` is an answer, not a gap: the transcript really did not record one,
  // and showing a scraped name would be the guess this change removes.
  const info = headerInfo('  model: something  上下文 30%', { model: null, effort: null })
  assert.equal(info.model, undefined)
  assert.equal(info.effort, undefined)
  assert.equal(info.contextLabel, '30%')
})

test('the chat page carries settings into the session state', async () => {
  const host: Host = { id: 'A', name: 'A', relayUrl: 'https://a.invalid', connectCode: 'A'.repeat(43), addedAt: 0 }
  const calls: { path: string; body?: any; init?: any }[] = []
  const transport: Transport = {
    async connect() {},
    async request<T>(path: string, body?: unknown, init?: any): Promise<T> {
      calls.push({ path, body, init })
      if (path === '/api/herdr/info') return { online: true } as T
      if (path.startsWith('/api/herdr/chat')) {
        return { session_id: 's1', page: { start: 0, end: 3, items: [] }, queued: [], settings: { model: 'claude-opus-5-5', effort: 'medium' } } as T
      }
      return { result: { read: { text: '' } } } as T
    },
    subscribe() { return { close() {} } },
    lastInboundAt() { return Date.now() },
    close() {},
  }
  const storage: HostStorage = { persistent: true, async load() { return [host] }, async save() {} }
  const controller = new Controller(storage, () => transport)
  try {
    await controller.initialize(); await wait()
    controller.selectHost('A'); await controller.selectPane('w1:p1')
    assert.deepEqual(controller.getState().session?.settings, { model: 'claude-opus-5-5', effort: 'medium' })
  } finally { controller.dispose() }
})

test('a settings frame updates the session without a reload', async () => {
  const host: Host = { id: 'A', name: 'A', relayUrl: 'https://a.invalid', connectCode: 'A'.repeat(43), addedAt: 0 }
  let chat: ((frame: any) => void) | undefined
  const transport: Transport = {
    async connect() {},
    async request<T>(path: string): Promise<T> {
      if (path === '/api/herdr/info') return { online: true } as T
      if (path.startsWith('/api/herdr/chat')) return { session_id: 's1', page: { start: 0, end: 1, items: [] }, queued: [], settings: { model: 'a' } } as T
      return { result: { read: { text: '' } } } as T
    },
    subscribe(path: string, receive: (frame: any) => void) {
      if (path.startsWith('/ws/herdr/chat')) chat = receive
      return { close() {} }
    },
    lastInboundAt() { return Date.now() },
    close() {},
  }
  const storage: HostStorage = { persistent: true, async load() { return [host] }, async save() {} }
  const controller = new Controller(storage, () => transport)
  try {
    await controller.initialize(); await wait()
    controller.selectHost('A'); await controller.selectPane('w1:p1')
    chat?.({ type: 'settings', settings: { model: 'b', effort: 'low' } })
    assert.deepEqual(controller.getState().session?.settings, { model: 'b', effort: 'low' })
    // A malformed frame must not wipe what is already shown.
    chat?.({ type: 'settings', settings: null })
    assert.deepEqual(controller.getState().session?.settings, { model: 'b', effort: 'low' })
  } finally { controller.dispose() }
})

test('a new session resets settings, because the agent is a different process', async () => {
  const host: Host = { id: 'A', name: 'A', relayUrl: 'https://a.invalid', connectCode: 'A'.repeat(43), addedAt: 0 }
  let chat: ((frame: any) => void) | undefined
  const transport: Transport = {
    async connect() {},
    async request<T>(path: string): Promise<T> {
      if (path === '/api/herdr/info') return { online: true } as T
      if (path.startsWith('/api/herdr/chat')) return { session_id: 's1', page: { start: 0, end: 1, items: [] }, queued: [], settings: { model: 'a' } } as T
      return { result: { read: { text: '' } } } as T
    },
    subscribe(path: string, receive: (frame: any) => void) {
      if (path.startsWith('/ws/herdr/chat')) chat = receive
      return { close() {} }
    },
    lastInboundAt() { return Date.now() },
    close() {},
  }
  const storage: HostStorage = { persistent: true, async load() { return [host] }, async save() {} }
  const controller = new Controller(storage, () => transport)
  try {
    await controller.initialize(); await wait()
    controller.selectHost('A'); await controller.selectPane('w1:p1')
    assert.equal(controller.getState().session?.settings?.model, 'a')
    chat?.({ type: 'session_changed', session_id: 's2' })
    assert.equal(controller.getState().session?.settings, undefined, 'the old model must not describe the new session')
  } finally { controller.dispose() }
})

// ── notification buttons ────────────────────────────────────────────────
const MENU = `Do you want to proceed?
❯ 1. Yes
  2. No, and tell Claude what to do differently`

test('an allow button resolves to the option that agrees', () => {
  const menu = parsePrompt(MENU)
  assert.ok(menu)
  assert.equal(optionForIntent(menu, 'allow'), 1)
  assert.equal(optionForIntent(menu, 'deny'), 2)
})

test('a notification button is refused when the menu makes it ambiguous', () => {
  // Two rows that both read as agreement: a button must not pick one.
  const both = parsePrompt('Pick one\n❯ 1. Yes, allow it\n  2. Yes, always allow')
  assert.ok(both)
  assert.equal(optionForIntent(both, 'allow'), null)
  // A multi-select form ends in a Submit row, which needs its own tap; a
  // single button cannot stand in for that.
  const multi = parsePrompt('Select tools\n❯ 1. [ ] Read\n  2. [ ] Write\n  Submit')
  assert.ok(multi)
  assert.ok(multi.submit, 'the parser recognised the submit row')
  assert.equal(optionForIntent(multi, 'allow'), null)
  // No menu at all.
  assert.equal(optionForIntent(null, 'allow'), null)
})

test('"don\'t" in the middle of a sentence is not read as a deny', () => {
  const menu = parsePrompt(`Claude wants to run a command\n❯ 1. Yes, and don't ask again\n  2. No`)
  assert.ok(menu)
  assert.equal(optionForIntent(menu, 'allow'), 1, 'the row starts with "Yes"')
  assert.equal(optionForIntent(menu, 'deny'), 2)
})

test('a tap with no action id opens the session instead of guessing', () => {
  assert.deepEqual(actionFor({ kind: 'done' }, undefined, undefined), { kind: 'open' })
  assert.deepEqual(actionFor({ kind: 'done' }, 'dismiss'), { kind: 'open' })
  // An Allow button on a "done" alert is not something the app ever posts, but
  // a stale notification from an older build could still deliver it.
  assert.deepEqual(actionFor({ kind: 'done' }, 'allow'), { kind: 'open' })
  assert.deepEqual(actionFor({ kind: 'done' }, 'reply', '  go on  '), { kind: 'reply', text: 'go on' })
})

// ── mutes ──────────────────────────────────────────────────────────────
const hostState = (mutes?: HostState['mutes']): HostState => ({
  host: { id: 'h', name: 'h', relayUrl: 'https://r.invalid', connectCode: 'x', addedAt: 0 },
  status: 'online', herdrOnline: true,
  snapshot: { workspaces: [], panes: [{ pane_id: 'p', workspace_id: 'w1', tab_id: 't1', agent: 'claude', agent_status: 'working' }] },
  mutes,
})

test('a muted tab or workspace silences the alert, not just the badge', () => {
  assert.equal(mutedOn(hostState({ tabs: ['t1'], workspaces: [] }), { tab_id: 't1', workspace_id: 'w1' }), true)
  assert.equal(mutedOn(hostState({ tabs: [], workspaces: ['w1'] }), { tab_id: 't1', workspace_id: 'w1' }), true)
  assert.equal(mutedOn(hostState({ tabs: [], workspaces: [] }), { tab_id: 't1', workspace_id: 'w1' }), false)
  // A desktop that has not answered yet must not look muted.
  assert.equal(mutedOn(hostState(undefined), { tab_id: 't1', workspace_id: 'w1' }), false)

  const tracker = new AlertTracker()
  tracker.update([hostState({ tabs: ['t1'], workspaces: [] })])
  const alerting = tracker.update([{ ...hostState({ tabs: ['t1'], workspaces: [] }), snapshot: { workspaces: [], panes: [{ pane_id: 'p', workspace_id: 'w1', tab_id: 't1', agent: 'claude', agent_status: 'blocked' }] } }])
  assert.equal(alerting.length, 0)
})

// ── the idle probe ─────────────────────────────────────────────────────
class SlowSocket implements SocketLike {
  binaryType = ''; readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  keys?: Awaited<ReturnType<typeof deriveSessionKeys>>
  /** When false the desktop accepts the handshake but never answers anything else. */
  respond = false
  frames: Record<string, any>[] = []
  private counter = 0n
  constructor(private code: string, respond = false) {
    this.respond = respond
    setTimeout(() => this.onopen?.(), 0)
  }
  close() { this.readyState = 3; this.onclose?.() }
  send(data: string | Uint8Array) {
    void (async () => {
      if (typeof data === 'string') {
        const frame = JSON.parse(data)
        if (frame.t === 'ok') return
        const pair = await createKeyPair(), nonce = crypto.getRandomValues(new Uint8Array(16))
        this.keys = await deriveSessionKeys({ connectCode: this.code, myPrivateKey: pair.privateKey, peerPublic: fromBase64url(frame.epk), initiatorPublic: fromBase64url(frame.epk), responderPublic: pair.publicKey, initiatorNonce: fromBase64url(frame.n), responderNonce: nonce })
        this.onmessage?.({ data: JSON.stringify({ t: 'hi', epk: base64url(pair.publicKey), n: base64url(nonce), cr: base64url(this.keys.confirmResponder) }) })
        return
      }
      const frame = decodeInnerFrame(await openBytes(this.keys!.c2s, data))
      this.frames.push(frame)
      if (!this.respond || frame.t !== 'hreq') return
      await this.emit({ t: 'hres', id: frame.id, status: 200, headers: {} })
      await this.emit({ t: 'hchunk', id: frame.id, b: base64url(new TextEncoder().encode(JSON.stringify({ online: true }))) })
      await this.emit({ t: 'hend', id: frame.id })
    })()
  }
  async emit(frame: Record<string, any>) {
    const data = await sealBytes(this.keys!.s2c, this.counter++, encodeInnerFrame(frame, false))
    this.onmessage?.({ data })
  }
}

test('an idle tunnel that stops answering is closed, not left looking healthy', async () => {
  const code = base64url(new Uint8Array(32).fill(9))
  const host: Host = { id: 'A', name: 'A', relayUrl: 'https://relay.invalid', connectCode: code, addedAt: 0 }
  const statuses: string[] = []
  const tunnel = new EncryptedTunnel(host, (state) => statuses.push(state), () => new SlowSocket(code), 5_000)
  try {
    await tunnel.connect()
    // The desktop answered the handshake and then went silent: this is the
    // case a `close` event never reports. Timings are compressed for the test.
    const stop = tunnel.startHeartbeat({ everyMs: 20, silenceMs: 40, probeTimeoutMs: 80 })
    await new Promise((r) => setTimeout(r, 250))
    stop()
    assert.ok(statuses.includes('offline'), `expected the probe to report offline, got ${statuses.join(',')}`)
  } finally { tunnel.close() }
})

test('a tunnel that keeps answering is left alone', async () => {
  const code = base64url(new Uint8Array(32).fill(6))
  const host: Host = { id: 'A', name: 'A', relayUrl: 'https://relay.invalid', connectCode: code, addedAt: 0 }
  // Built lazily: the fake fires `onopen` on the next tick, which must happen
  // after the tunnel has attached its handler.
  let socket: SlowSocket | undefined
  const statuses: string[] = []
  const tunnel = new EncryptedTunnel(host, (state) => statuses.push(state), () => (socket = new SlowSocket(code, true)), 5_000)
  try {
    await tunnel.connect()
    const stop = tunnel.startHeartbeat({ everyMs: 20, silenceMs: 40, probeTimeoutMs: 80 })
    await new Promise((r) => setTimeout(r, 200))
    stop()
    assert.equal(statuses.includes('offline'), false)
    assert.ok(socket!.frames.some((frame) => frame.t === 'hreq'), 'the probe did send a read')
  } finally { tunnel.close() }
})

test('the probe stays out of the way while a request is in flight', async () => {
  const code = base64url(new Uint8Array(32).fill(8))
  const host: Host = { id: 'A', name: 'A', relayUrl: 'https://relay.invalid', connectCode: code, addedAt: 0 }
  const statuses: string[] = []
  const tunnel = new EncryptedTunnel(host, (state) => statuses.push(state), () => new SlowSocket(code), 5_000)
  try {
    await tunnel.connect()
    // A slow upload: the outstanding request must count as traffic, so the
    // probe cannot mistake "busy" for "dead".
    void tunnel.request('/api/herdr/upload', undefined, { kind: 'mutation', raw: new Uint8Array([1, 2, 3]) }).catch(() => undefined)
    ;(tunnel as any).startHeartbeat({ everyMs: 20, silenceMs: 40, graceMs: 120, probeTimeoutMs: 60 })
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(statuses.includes('offline'), false, 'a large send is not evidence of a dead tunnel')
    ;(tunnel as any).stopHeartbeat()
  } finally { tunnel.close() }
})

test('a request that hangs does not blind the probe for its whole deadline', async () => {
  // The grace exists for a real upload; a request that never answers is the
  // very failure the probe is for. Without the grace the probe waits out the
  // request deadline (20 s in production) — the whole window that matters.
  const code = base64url(new Uint8Array(32).fill(9))
  const host: Host = { id: 'A', name: 'A', relayUrl: 'https://relay.invalid', connectCode: code, addedAt: 0 }
  const statuses: string[] = []
  const tunnel = new EncryptedTunnel(host, (state) => statuses.push(state), () => new SlowSocket(code, false), 20_000)
  try {
    await tunnel.connect()
    // A request that never completes, as a dead link produces.
    void tunnel.request('/api/herdr/chat?pane=w1:p1', undefined, { kind: 'read', timeoutMs: 20_000 }).catch(() => undefined)
    ;(tunnel as any).startHeartbeat({ everyMs: 20, silenceMs: 40, graceMs: 60, probeTimeoutMs: 80 })
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(statuses.includes('offline'), true, 'a hung request must not hold off the probe indefinitely')
    ;(tunnel as any).stopHeartbeat()
  } finally { tunnel.close() }
})

// ── regressions found in the full review ───────────────────────────────
/**
 * A controller whose transports are replaced on demand, for the paths that
 * rebuild every runtime (a handover, the discovery switch).
 */
function rebuildingController(hostCount = 1) {
  const hosts: Host[] = Array.from({ length: hostCount }, (_, index) => ({
    id: `H${index}`, name: `H${index}`, relayUrl: `https://h${index}.invalid`, connectCode: String(index).repeat(43), addedAt: 0,
  }))
  const built: Transport[] = []
  const storage: HostStorage = { persistent: true, async load() { return hosts }, async save() {} }
  const controller = new Controller(storage, () => {
    // A real rebuild would spin forever here; the cap turns that into a
    // failure instead of a hung test run.
    if (built.length > 20) throw new Error(`unbounded rebuild: ${built.length} transports`)
    const transport: Transport = {
      async connect() {},
      async request<T>(path: string): Promise<T> {
        if (path === '/api/herdr/info') return { online: true } as T
        if (path === '/api/herdr/mutes') return { tabs: [], workspaces: [] } as T
        if (path.startsWith('/api/herdr/chat')) return { session_id: 's', page: { start: 0, end: 1, items: [] }, queued: [] } as T
        return { result: { read: { text: '' } } } as T
      },
      subscribe() { return { close() {} } },
      lastInboundAt() { return Date.now() },
      close() {},
    }
    built.push(transport)
    return transport
  })
  return { controller, built, hosts }
}

test('a network change rebuilds each desktop once and returns', async () => {
  // `rebuild` deletes and re-inserts the same map key; iterating the live map
  // re-visits it forever. The symptom is a frozen UI dialling without bound.
  const { controller, built } = rebuildingController(2)
  try {
    await controller.initialize(); await wait()
    const before = built.length
    controller.networkChanged()
    assert.ok(built.length - before <= 2, `rebuilt ${built.length - before} transports for 2 desktops`)
    // Still usable afterwards: a runtime exists for each host and nothing threw.
    assert.ok(controller.getState().hosts.every((host) => host.status !== 'disabled'))
  } finally { controller.dispose() }
})

test('toggling local discovery rebuilds and returns', async () => {
  const { controller, built } = rebuildingController(1)
  try {
    await controller.initialize(); await wait()
    const before = built.length
    controller.lanDiscoveryChanged(false)
    assert.ok(built.length - before <= 1, `rebuilt ${built.length - before} transports`)
    controller.lanDiscoveryChanged(true)
    assert.ok(built.length - before <= 2, `rebuilt ${built.length - before} transports`)
  } finally { controller.dispose() }
})

test('suspending leaves no retry armed on a discarded runtime', async () => {
  // `closeRuntime` reports 'offline' synchronously, and the scheduler arms a
  // retry for whatever is still current. Deleting after the close left a
  // timer waking a phone that had just been put in a pocket.
  const host: Host = { id: 'A', name: 'A', relayUrl: 'https://a.invalid', connectCode: 'A'.repeat(43), addedAt: 0 }
  const transports: { runtime?: any; transport: Transport }[] = []
  const storage: HostStorage = { persistent: true, async load() { return [host] }, async save() {} }
  let announce: ((state: string) => void) | undefined
  const controller = new Controller(storage, (_host, status) => {
    announce = status as (state: string) => void
    const transport: Transport = {
      async connect() {},
      async request<T>(): Promise<T> { return { online: true } as T },
      subscribe() { return { close() {} } },
      lastInboundAt() { return Date.now() },
      close() { announce?.('offline') },
    }
    transports.push({ transport })
    return transport
  })
  try {
    await controller.initialize(); await wait()
    const runtime = [...((controller as any).runtimes.values())][0] as any
    controller.suspend()
    assert.equal(runtime.retry, undefined, 'no timer may survive the suspend')
    assert.equal((controller as any).runtimes.size, 0)
  } finally { controller.dispose() }
})

test('a late mute answer from a replaced runtime does not win', async () => {
  const host: Host = { id: 'A', name: 'A', relayUrl: 'https://a.invalid', connectCode: 'A'.repeat(43), addedAt: 0 }
  let generation = 0
  const storage: HostStorage = { persistent: true, async load() { return [host] }, async save() {} }
  const controller = new Controller(storage, () => {
    const mine = ++generation
    return {
      async connect() {},
      async request<T>(path: string): Promise<T> {
        if (path === '/api/herdr/mutes') {
          // The first connection answers slowly; the second answers at once.
          if (mine === 1) { await new Promise((resolve) => setTimeout(resolve, 60)); return { tabs: ['stale'], workspaces: [] } as T }
          return { tabs: ['fresh'], workspaces: [] } as T
        }
        if (path === '/api/herdr/info') return { online: true } as T
        return { result: { read: { text: '' } } } as T
      },
      subscribe() { return { close() {} } },
      lastInboundAt() { return Date.now() },
      close() {},
    } satisfies Transport
  })
  try {
    await controller.initialize(); await wait()
    const first = [...((controller as any).runtimes.values())][0] as any
    ;(controller as any).rebuild('A', first)
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.deepEqual(controller.getState().hosts[0].mutes, { tabs: ['fresh'], workspaces: [] })
  } finally { controller.dispose() }
})

test('opening a pane on a desktop with no connection reports failure', async () => {
  // Returning silently made a notification reply land in whichever session was
  // open before, because the caller could not tell that nothing happened.
  const host: Host = { id: 'A', name: 'A', relayUrl: 'https://a.invalid', connectCode: 'A'.repeat(43), addedAt: 0 }
  const storage: HostStorage = { persistent: true, async load() { return [host] }, async save() {} }
  let announce: ((state: string) => void) | undefined
  const controller = new Controller(storage, (_host, status) => {
    announce = status as (state: string) => void
    return {
      async connect() {},
      async request<T>(path: string): Promise<T> {
        if (path === '/api/herdr/info') return { online: true } as T
        if (path.startsWith('/api/herdr/chat')) return { session_id: 's', page: { start: 0, end: 1, items: [] }, queued: [] } as T
        return { result: { read: { text: '' } } } as T
      },
      subscribe() { return { close() {} } },
      lastInboundAt() { return Date.now() },
      close() { announce?.('offline') },
    } satisfies Transport
  })
  try {
    await controller.initialize(); await wait()
    controller.selectHost('A')
    await controller.selectPane('w1:p1')
    controller.suspend()
    await assert.rejects(controller.selectPane('w1:p2'), /节点未连接/)
    // The previously opened pane is still what the state says, which is why the
    // caller has to check rather than assume.
    assert.equal(controller.getState().session?.paneId, 'w1:p1')
  } finally { controller.dispose() }
})

test('a stale direct address is forgotten after it stops answering', async () => {
  const host: Host = { id: 'A', name: 'A', relayUrl: 'https://a.invalid', connectCode: 'A'.repeat(43), addedAt: 0 }
  const storage: HostStorage = { persistent: true, async load() { return [host] }, async save() {} }
  let directFailed: (() => void) | undefined
  const controller = new Controller(storage, () => ({
    async connect() {},
    async request<T>(path: string): Promise<T> {
      if (path === '/api/herdr/info') return { online: true } as T
      return { result: { read: { text: '' } } } as T
    },
    subscribe() { return { close() {} } },
    lastInboundAt() { return Date.now() },
    close() {},
    set onDirectFailed(handler: () => void) { directFailed = handler },
    useDirect() {},
  } as unknown as Transport))
  try {
    await controller.initialize(); await wait()
    const address = { host: '192.168.1.50', port: 23019 }
    ;(controller as any).patchHost('A', { discoveredLan: address })
    directFailed?.()
    // One failure falls back to the relay and keeps the address: the desktop
    // may simply have been busy, and discarding it here is what turned a single
    // unlucky dial into "no direct connection for the rest of the session".
    assert.deepEqual(controller.getState().hosts[0].discoveredLan, address)
    // The second consecutive failure suspends the path, and only then is the
    // address dropped — a suspended path with no address is nothing to dial.
    directFailed?.()
    assert.equal(controller.getState().hosts[0].discoveredLan, undefined)
  } finally { controller.dispose() }
})

test('a prompt fingerprint covers the question, not just the rows', async () => {
  const write = parsePrompt('Allow write to ~/project?\n❯ 1. Yes\n  2. No')!
  const wipe = parsePrompt('Run rm -rf ~?\n❯ 1. Yes\n  2. No')!
  assert.notEqual(await promptFingerprint(write), await promptFingerprint(wipe), 'the same rows must not authorize a different question')
  // The same prompt still matches itself.
  assert.equal(await promptFingerprint(write), await promptFingerprint(parsePrompt('Allow write to ~/project?\n❯ 1. Yes\n  2. No')!))
})

test('a Chinese menu can be answered from a notification', () => {
  // `\b` never matches after a CJK character, so these were silently
  // unanswerable — the button opened the session instead of pressing anything.
  const menu = parsePrompt('是否允许执行？\n❯ 1. 同意\n  2. 拒绝')!
  assert.equal(optionForIntent(menu, 'allow'), 1)
  assert.equal(optionForIntent(menu, 'deny'), 2)
  const allowOnly = parsePrompt('是否允许执行？\n❯ 1. 允许\n  2. 取消')!
  assert.equal(optionForIntent(allowOnly, 'allow'), 1)
  assert.equal(optionForIntent(allowOnly, 'deny'), 2)
})

test('the alert and the tap hash the same screen when it is coloured', async () => {
  // `pane.read` returns escape sequences whether or not text was asked for, so
  // the capture and the verification both go through `readPaneScreen`.
  const coloured = 'Allow write?\n\x1b[36m❯ 1. Yes\x1b[0m\n\x1b[2m  2. No\x1b[0m'
  const stripped = stripAnsi(coloured)
  assert.ok(parsePrompt(stripped), 'the cleaned screen parses')
  assert.equal(await promptFingerprint(parsePrompt(stripped)!), await promptFingerprint(parsePrompt(stripAnsi(coloured))!))
  // Parsing the raw form is what used to make the button fail closed.
  assert.equal(parsePrompt(coloured), null)
})

test('a reply in progress requires a live connection', () => {
  const host = (status: string) => ({
    host: { enabled: true }, status,
    snapshot: { panes: [{ agent_status: 'working' }] },
  })
  assert.equal(replyInProgress([host('online')]), true)
  // The last snapshot outlives the connection, so a desktop that dropped
  // mid-work would otherwise keep the service (and its notification) alive.
  assert.equal(replyInProgress([host('offline')]), false)
  assert.equal(replyInProgress([host('error')]), false)
})

test('a discovered address is retried after it stops answering, not kept forever', async () => {
  // `maybeDiscover` skips a host that already has an address. Left behind, a
  // stale one means no rescan ever happens for the rest of the app run.
  const host: Host = { id: 'A', name: 'A', relayUrl: 'https://a.invalid', connectCode: 'A'.repeat(43), addedAt: 0 }
  const storage: HostStorage = { persistent: true, async load() { return [host] }, async save() {} }
  const controller = new Controller(storage, () => ({
    async connect() {},
    async request<T>(): Promise<T> { return { online: true } as T },
    subscribe() { return { close() {} } },
    lastInboundAt() { return Date.now() },
    close() {},
  } as Transport))
  try {
    await controller.initialize(); await wait()
    ;(controller as any).patchHost('A', { discoveredLan: { host: '192.168.1.50', port: 23019 } })
    assert.ok(controller.getState().hosts[0].discoveredLan, 'precondition')
    controller.networkChanged()
    assert.equal(controller.getState().hosts[0].discoveredLan, undefined, 'a new network must not inherit the old answer')
  } finally { controller.dispose() }
})

test('a scan in flight is abandoned when the network moves', async () => {
  const host: Host = { id: 'A', name: 'A', relayUrl: 'https://a.invalid', connectCode: 'A'.repeat(43), addedAt: 0 }
  const storage: HostStorage = { persistent: true, async load() { return [host] }, async save() {} }
  const controller = new Controller(storage, () => ({
    async connect() {},
    async request<T>(): Promise<T> { return { online: true } as T },
    subscribe() { return { close() {} } },
    lastInboundAt() { return Date.now() },
    close() {},
  } as Transport))
  try {
    await controller.initialize(); await wait()
    const scan = { aborted: false }
    ;(controller as any).scans.add(scan)
    ;(controller as any).discovering.add('A')
    controller.networkChanged()
    assert.equal(scan.aborted, true, 'the old subnet is not worth probing')
    assert.equal((controller as any).discovering.size, 0, 'the host can be looked for again')
  } finally { controller.dispose() }
})

test('the desktop is not asked for a tab association the client already made', async () => {
  const host: Host = { id: 'A', name: 'A', relayUrl: 'https://a.invalid', connectCode: 'A'.repeat(43), addedAt: 0 }
  const calls: string[] = []
  const storage: HostStorage = { persistent: true, async load() { return [host] }, async save() {} }
  const controller = new Controller(storage, () => ({
    async connect() {},
    async request<T>(path: string, body?: any): Promise<T> {
      calls.push(body?.method ?? path)
      if (path === '/api/herdr/info') return { online: true } as T
      if (path === '/api/herdr/rpc' && body?.method === 'tab.create') return { result: { tab: { tab_id: 'w1:t1', workspace_id: 'w1' } } } as T
      if (path === '/api/herdr/rpc' && body?.method === 'agent.start') return { result: {} } as T
      if (path === '/api/herdr/rpc' && body?.method === 'tab.get') { calls.push('TAB.GET'); return { result: {} } as T }
      return { result: { read: { text: '' } } } as T
    },
    subscribe() { return { close() {} } },
    lastInboundAt() { return Date.now() },
    close() {},
  } as Transport))
  try {
    await controller.initialize(); await wait()
    // A desktop that reports no pane at all: the recovery path runs.
    ;(controller as any).rememberTabAddress('A', 'w1:p1', 'w1:t1')
    const found = await (controller as any).paneOfTab('A', 'w1:t1')
    assert.equal(found, 'w1:p1')
    assert.equal(calls.includes('TAB.GET'), false, 'no round trip for an association this client made')
  } finally { controller.dispose() }
})

test('verifying a dead link finishes and does not loop on rebuilt runtimes', async () => {
  const host: Host = { id: 'A', name: 'A', relayUrl: 'https://a.invalid', connectCode: 'A'.repeat(43), addedAt: 0 }
  let built = 0
  const storage: HostStorage = { persistent: true, async load() { return [host] }, async save() {} }
  const controller = new Controller(storage, (_host, status) => {
    built++
    if (built > 20) throw new Error(`unbounded verify: ${built} transports`)
    return {
      async connect() { status('online') },
      // The read times out but the status sink is not told, which is what a
      // request deadline produces on a tunnel that still believes it is open.
      async request<T>(): Promise<T> { throw new Error('桌面接口超时') },
      subscribe() { return { close() {} } },
      lastInboundAt() { return Date.now() },
      close() {},
    } satisfies Transport
  })
  try {
    await controller.initialize(); await wait()
    await controller.verify()
    assert.ok(built <= 3, `rebuilt ${built} transports`)
  } finally { controller.dispose() }
})

test('a hidden app does not start an idle probe when it connects', async () => {
  const host: Host = { id: 'A', name: 'A', relayUrl: 'https://a.invalid', connectCode: 'A'.repeat(43), addedAt: 0 }
  const heartbeats: string[] = []
  const storage: HostStorage = { persistent: true, async load() { return [host] }, async save() {} }
  const transport = () => ({
    async connect() {},
    async request<T>(path: string): Promise<T> {
      if (path === '/api/herdr/info') return { online: true } as T
      return { result: { read: { text: '' } } } as T
    },
    subscribe() { return { close() {} } },
    lastInboundAt() { return Date.now() },
    startHeartbeat() { heartbeats.push('start'); return () => heartbeats.push('stop') },
    close() {},
  } as unknown as Transport)
  const controller = new Controller(storage, () => transport())
  try {
    await controller.initialize(); await wait()
    controller.setForeground(false)
    // The launch itself happened while visible; only the reconnect made while
    // hidden is under test.
    const before = heartbeats.filter((entry) => entry === 'start').length
    ;(controller as any).rebuild('A', [...((controller as any).runtimes.values())][0])
    await wait()
    assert.equal(heartbeats.filter((entry) => entry === 'start').length, before, 'a hidden app must not probe')
  } finally { controller.dispose() }
})

test('coming back to the foreground starts the probe again', async () => {
  const host: Host = { id: 'A', name: 'A', relayUrl: 'https://a.invalid', connectCode: 'A'.repeat(43), addedAt: 0 }
  let running = 0
  const storage: HostStorage = { persistent: true, async load() { return [host] }, async save() {} }
  const controller = new Controller(storage, () => ({
    async connect() {},
    async request<T>(path: string): Promise<T> {
      if (path === '/api/herdr/info') return { online: true } as T
      return { result: { read: { text: '' } } } as T
    },
    subscribe() { return { close() {} } },
    lastInboundAt() { return Date.now() },
    startHeartbeat() { running++; return () => { running-- } },
    close() {},
  } as unknown as Transport))
  try {
    await controller.initialize(); await wait()
    controller.setForeground(false)
    assert.equal(running, 0, 'hidden: no probe')
    controller.setForeground(true)
    assert.equal(running, 1, 'visible: exactly one probe')
    controller.setForeground(true)
    assert.equal(running, 1, 'repeating the same state does not stack probes')
  } finally { controller.dispose() }
})
