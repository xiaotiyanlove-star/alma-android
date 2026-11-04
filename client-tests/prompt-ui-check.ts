import { chromium } from '@playwright/test'
import { addDesktop } from './helpers.ts'
import { base64url, createKeyPair, deriveSessionKeys, fromBase64url, openFrame, routingId, sealFrame } from '../client/crypto.ts'

const code = base64url(new Uint8Array(32).fill(9))
const MENU = [
  '╭──────────────────────────────╮',
  '│ Run this command?            │',
  '│ ❯ 1. Yes, run command        │',
  '│   2. Yes, always allow       │',
  '│   3. No, cancel              │',
  '╰──────────────────────────────╯',
].join('\n')

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
await context.addInitScript(() => { try { localStorage.setItem('herdr.prefs.locale', 'zh-CN') } catch {} })
const page = await context.newPage()
const errors: string[] = []
page.on('pageerror', (error: Error) => errors.push(error.message))
const sent: string[] = []

await page.routeWebSocket('wss://relay.invalid/**', (socket) => {
  let keys: Awaited<ReturnType<typeof deriveSessionKeys>>
  let counter = 0n
  let chain = Promise.resolve()
  const send = async (frame: Record<string, unknown>) => socket.send(Buffer.from(await sealFrame(keys.s2c, counter++, frame)))
  const reply = async (id: string, body: unknown) => {
    await send({ t: 'hres', id, status: 200, headers: {} })
    await send({ t: 'hchunk', id, b: base64url(new TextEncoder().encode(JSON.stringify(body))) })
    await send({ t: 'hend', id })
  }
  socket.onMessage((data) => {
    chain = chain.then(async () => {
      if (typeof data === 'string') {
        const hi = JSON.parse(data)
        if (hi.t === 'ok') return
        const pair = await createKeyPair()
        const nonce = crypto.getRandomValues(new Uint8Array(16))
        keys = await deriveSessionKeys({
          connectCode: code,
          myPrivateKey: pair.privateKey,
          peerPublic: fromBase64url(hi.epk),
          initiatorPublic: fromBase64url(hi.epk),
          responderPublic: pair.publicKey,
          initiatorNonce: fromBase64url(hi.n),
          responderNonce: nonce,
        })
        socket.send(JSON.stringify({ t: 'hi', epk: base64url(pair.publicKey), n: base64url(nonce), cr: base64url(keys.confirmResponder) }))
        return
      }
      const frame = await openFrame(keys.c2s, new Uint8Array(data as unknown as ArrayBuffer)) as Record<string, any>
      if (frame.t === 'hreq') {
        if (frame.path === '/api/herdr/info') await reply(frame.id, { online: true })
        else if (frame.path.startsWith('/api/herdr/chat')) await reply(frame.id, { session_id: 's1', page: { start: 0, end: 1, items: [{ id: 'm1', kind: 'assistant', text: 'ready' }] } })
        else if (frame.path === '/api/herdr/mutes') await reply(frame.id, { workspaces: [], tabs: [] })
        else if (frame.path === '/__alma_lan__') await reply(frame.id, null)
        else {
          // A bodyless GET is not an RPC; decoding it unconditionally throws.
          const rpc = JSON.parse(new TextDecoder().decode(fromBase64url(frame.b)))
          if (rpc.method === 'pane.read') await reply(frame.id, { result: { read: { text: MENU } } })
          else {
            if (rpc.method === 'pane.send_keys') sent.push((rpc.params.keys as string[]).join(','))
            await reply(frame.id, { result: {} })
          }
        }
      }
      if (frame.t === 'wopen') {
        await send({ t: 'wopened', id: frame.id })
        if (frame.path === '/ws/herdr') {
          await send({ t: 'wmsg', id: frame.id, s: JSON.stringify({ type: 'snapshot', snapshot: { workspaces: [{ workspace_id: 'w1', label: 'demo' }], panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 't1', agent: 'claude', agent_status: 'blocked', terminal_title_stripped: '权限测试' }] } }) })
        }
        if (frame.path.startsWith('/ws/herdr/screen')) {
          await send({ t: 'wmsg', id: frame.id, s: JSON.stringify({ type: 'screen', read: { text: MENU } }) })
        }
      }
    })
  })
})

try {
  await page.goto(`http://127.0.0.1:${process.env.APP_PORT ?? 5174}`)
  await addDesktop(page, '权限节点', `alma://connect?u=https://relay.invalid&k=${code}&e2e=1`)
  await page.locator('.session-row').filter({ hasText: '权限测试' }).click()
  await page.getByRole('group', { name: '需要你选择' }).waitFor({ timeout: 20000 })
  await page.screenshot({ path: 'test-artifacts/prompt-card.png' })
  const labels = await page.locator('.prompt-option .prompt-label').allTextContents()
  await page.getByRole('button', { name: /Yes, always allow/ }).click()
  await page.waitForTimeout(800)
  console.log(JSON.stringify({ labels, sentKeys: sent, pageErrors: errors }))
} finally {
  await browser.close()
}
