// Proves the weak-network promises against the real app in a browser:
// a dead tunnel becomes visible in about five seconds (not twenty), and a
// hidden app stops redialling.
import { chromium } from '@playwright/test'
import { addDesktop } from './helpers.ts'
import { base64url, createKeyPair, deriveSessionKeys, fromBase64url, openFrame, sealFrame } from '../client/crypto.ts'

const code = base64url(new Uint8Array(32).fill(9))
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
const page = await context.newPage()
const errors: string[] = []
page.on('pageerror', (error: Error) => errors.push(error.message))

/** Set to true to make the tunnel accept the handshake and then go silent. */
let blackhole = false
const probes: number[] = []

await page.routeWebSocket('wss://relay.invalid/**', (socket) => {
  let keys: Awaited<ReturnType<typeof deriveSessionKeys>>
  let counter = 0n
  let chain = Promise.resolve()
  const send = async (frame: Record<string, unknown>) => socket.send(Buffer.from(await sealFrame(keys.s2c, counter++, frame)))
  const reply = async (rid: string, body: unknown) => {
    await send({ t: 'hres', id: rid, status: 200, headers: {} })
    await send({ t: 'hchunk', id: rid, b: base64url(new TextEncoder().encode(JSON.stringify(body))) })
    await send({ t: 'hend', id: rid })
  }
  socket.onMessage((data) => {
    if (blackhole) return
    chain = chain.then(async () => {
      if (typeof data === 'string') {
        const hi = JSON.parse(data)
        if (hi.t === 'ok') return
        const pair = await createKeyPair()
        const nonce = crypto.getRandomValues(new Uint8Array(16))
        keys = await deriveSessionKeys({ connectCode: code, myPrivateKey: pair.privateKey, peerPublic: fromBase64url(hi.epk), initiatorPublic: fromBase64url(hi.epk), responderPublic: pair.publicKey, initiatorNonce: fromBase64url(hi.n), responderNonce: nonce })
        socket.send(JSON.stringify({ t: 'hi', epk: base64url(pair.publicKey), n: base64url(nonce), cr: base64url(keys.confirmResponder) }))
        return
      }
      const frame = await openFrame(keys.c2s, new Uint8Array(data as unknown as ArrayBuffer)) as Record<string, any>
      if (frame.t === 'hreq') {
        const body = frame.b ? JSON.parse(new TextDecoder().decode(fromBase64url(frame.b))) : undefined
        if (body?.method === 'pane.read' || frame.path === '/api/herdr/info') probes.push(Date.now())
        if (frame.path === '/api/herdr/info') return reply(frame.id, { online: true })
        if (frame.path.startsWith('/api/herdr/chat')) return reply(frame.id, { session_id: 's1', page: { start: 0, end: 1, items: [{ id: 'm1', kind: 'assistant', text: 'hi' }] } })
        return reply(frame.id, { result: { read: { text: 'terminal output' } } })
      }
      if (frame.t === 'wopen') {
        await send({ t: 'wopened', id: frame.id })
        if (frame.path === '/ws/herdr') await send({ t: 'wmsg', id: frame.id, s: JSON.stringify({ type: 'snapshot', snapshot: { workspaces: [{ workspace_id: 'w1', label: 'ws' }], tabs: [], panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 't1', agent: 'claude', agent_status: 'idle', terminal_title_stripped: '会话', cwd: '/tmp' }] } }) })
      }
    })
  })
})

try {
  await page.goto(`http://127.0.0.1:${process.env.APP_PORT ?? 5174}`)
  await addDesktop(page, '测试节点', `alma://connect?u=https://relay.invalid&k=${code}&e2e=1`)
  await page.waitForTimeout(900)
  const connected = await page.getByText('已连接').first().isVisible().catch(() => false)

  // The link dies without telling anyone: no close event, no error.
  blackhole = true
  const diedAt = Date.now()
  // Wait for the UI to notice on its own, bounded by a deadline well under the
  // 20 s request timeout the old code relied on.
  let noticedAt = 0
  for (let i = 0; i < 200 && !noticedAt; i++) {
    await page.waitForTimeout(100)
    const banner = await page.locator('.connection-action, .is-error').first().isVisible().catch(() => false)
    const text = await page.locator('body').innerText()
    if (banner || /未连接|重新连接|离线/.test(text)) noticedAt = Date.now()
  }
  const detectMs = noticedAt ? noticedAt - diedAt : -1

  // Now the background promise: with the app hidden, a dead desktop must not
  // be redialled. Count actual WebSocket dials, since that is the battery cost.
  let dials = 0
  page.on('websocket', () => { dials++ })
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.waitForTimeout(10_000)
  const dialsWhileHidden = dials

  const summary = await page.evaluate(() => (window as any).__herdrController?.metrics?.())
  const failures: string[] = []
  if (!connected) failures.push('did not connect')
  if (detectMs < 0) failures.push('a dead tunnel was never reported')
  else if (detectMs > 15_000) failures.push(`detection took ${detectMs} ms; the old deadline was 20 s, so this must be well under it`)
  if (dialsWhileHidden > 0) failures.push(`redialled ${dialsWhileHidden} times while hidden`)
  if (errors.length) failures.push(`page errors: ${errors.join('; ')}`)
  console.log(JSON.stringify({ connected, detectMs, probesSent: probes.length, dialsWhileHidden, summary, pageErrors: errors, failures }))
  if (failures.length) process.exitCode = 1
} finally {
  await browser.close()
}
