// Live read-only check against a real Alma node, driven from the installed APK.
// The pairing link is passed through the environment and never written to disk.
// Usage: ALMA_TEST_LINK='alma://connect?...' node client-tests/device-live-check.mjs
// Only reads: connection, /api/herdr/info, snapshot, chat history, screen.
// Never sends agent.prompt, pane.send_keys, or pane.send_text.
const target = process.env.CDP || 'http://127.0.0.1:9333'
const link = process.env.ALMA_TEST_LINK
if (!link) throw new Error('ALMA_TEST_LINK is required')
const list = await (await fetch(`${target}/json/list`)).json()
const page = list.find((entry) => entry.type === 'page')
if (!page) throw new Error('no debuggable page found')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.onmessage = (event) => {
  const message = JSON.parse(event.data)
  const waiter = pending.get(message.id)
  if (!waiter) return
  pending.delete(message.id)
  waiter(message)
}
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
function evaluate(expression) {
  const requestId = ++id
  ws.send(JSON.stringify({ id: requestId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  return new Promise((resolve, reject) => pending.set(requestId, (message) => {
    if (message.error) reject(new Error(JSON.stringify(message.error)))
    else if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.text + ' ' + (message.result.exceptionDetails.exception?.description || '')))
    else resolve(message.result?.result?.value)
  }))
}
// Inject the link straight into the controller instance already running in the page.
const report = await evaluate(`(async () => {
  const link = ${JSON.stringify(link)}
  const state = () => window.__herdrController?.getState?.()
  const controller = window.__herdrController
  if (!controller) return { error: 'controller not exposed' }
  const out = {}
  try { await controller.addHost('测试节点', link) } catch (e) { return { error: 'addHost: ' + e.message } }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 40; i++) {
    const s = state()
    const host = s.hosts.find((h) => h.host.name === '测试节点')
    if (host && (host.status === 'online' || host.status === 'error')) {
      out.host = { status: host.status, herdrOnline: host.herdrOnline, error: host.error || null }
      out.panes = (host.snapshot?.panes || []).map((p) => ({ id: p.pane_id, agent: p.agent, status: p.agent_status, title: p.terminal_title_stripped }))
      out.workspaces = (host.snapshot?.workspaces || []).map((w) => w.label || w.name)
      break
    }
    await wait(500)
  }
  const host = state().hosts.find((h) => h.host.name === '测试节点')
  if (!host || host.status !== 'online' || !host.herdrOnline) return out
  const paneId = host.snapshot?.panes?.[0]?.pane_id
  if (!paneId) return { ...out, note: 'no panes' }
  controller.selectHost(host.host.id)
  await controller.selectPane(paneId)
  await wait(1500)
  const s = state().session
  out.session = { hostId: s.hostId ? 'set' : null, paneId: s.paneId, items: s.items.length, kinds: [...new Set(s.items.map((i) => i.kind))], screenChars: s.screen.length, error: s.error || null, unsupported: s.unsupported, hasSessionId: Boolean(s.sessionId) }
  out.firstKinds = s.items.slice(0, 3).map((i) => i.kind)
  out.textLengths = s.items.slice(-3).map((i) => (i.text || '').length)
  return out
})()`)
console.log(JSON.stringify(report, null, 2))
ws.close()
