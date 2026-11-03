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
import { optionForIntent, parsePrompt } from '../client/prompt.ts'
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
