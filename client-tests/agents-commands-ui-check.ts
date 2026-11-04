import { chromium } from '@playwright/test'
import { addDesktop } from './helpers.ts'
import { base64url, createKeyPair, deriveSessionKeys, fromBase64url, openFrame, sealFrame } from '../client/crypto.ts'

const code = base64url(new Uint8Array(32).fill(97))
const agentRow = (id: string, done: boolean, desc: string) => ({
  id,
  kind: 'tool',
  time: '2026-11-02T07:00:00Z',
  tool: { id, name: 'Agent', done, background: true, summary: desc, input: { description: desc, subagent_type: 'general-purpose' } },
})
const ITEMS = [
  { id: 'm1', kind: 'assistant', text: 'working', time: '2026-11-02T07:00:00Z' },
  agentRow('a1', false, 'Security review of main'),
  agentRow('a2', false, 'Product review of main'),
  agentRow('a3', true, 'Architecture review of main'),
]

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
await context.addInitScript(() => { try { localStorage.setItem('herdr.prefs.locale', 'zh-CN') } catch {} })
const page = await context.newPage()
const errors: string[] = []
page.on('pageerror', (e) => errors.push(e.message))
const sentText: string[] = []

await page.routeWebSocket('wss://relay.invalid/**', (socket) => {
  let keys: Awaited<ReturnType<typeof deriveSessionKeys>>
  let counter = 0n
  let chain = Promise.resolve()
  const send = async (f: Record<string, unknown>) => socket.send(Buffer.from(await sealFrame(keys.s2c, counter++, f)))
  const reply = async (id: string, body: unknown) => {
    await send({ t: 'hres', id, status: 200, headers: {} })
    await send({ t: 'hchunk', id, b: base64url(new TextEncoder().encode(JSON.stringify(body))) })
    await send({ t: 'hend', id })
  }
  socket.onMessage((d) => {
    chain = chain.then(async () => {
      if (typeof d === 'string') {
        const hi = JSON.parse(d)
        if (hi.t === 'ok') return
        const kp = await createKeyPair()
        const n = crypto.getRandomValues(new Uint8Array(16))
        keys = await deriveSessionKeys({ connectCode: code, myPrivateKey: kp.privateKey, peerPublic: fromBase64url(hi.epk), initiatorPublic: fromBase64url(hi.epk), responderPublic: kp.publicKey, initiatorNonce: fromBase64url(hi.n), responderNonce: n })
        socket.send(JSON.stringify({ t: 'hi', epk: base64url(kp.publicKey), n: base64url(n), cr: base64url(keys.confirmResponder) }))
        return
      }
      const f = await openFrame(keys.c2s, new Uint8Array(d as unknown as ArrayBuffer)) as Record<string, any>
      if (f.t === 'hreq') {
        if (f.path === '/api/herdr/info') await reply(f.id, { online: true })
        else if (f.path.startsWith('/api/herdr/chat')) await reply(f.id, { session_id: 's1', page: { start: 0, end: ITEMS.length, items: ITEMS } })
        else if (f.path === '/api/herdr/mutes') await reply(f.id, { workspaces: [], tabs: [] })
        else {
          // A bodyless GET is not an RPC; decoding it unconditionally throws.
          const rpc = JSON.parse(new TextDecoder().decode(fromBase64url(f.b)))
          if (rpc.method === 'pane.send_text') sentText.push(rpc.params.text)
          await reply(f.id, { result: rpc.method === 'pane.read' ? { read: { text: '' } } : {} })
        }
      }
      if (f.t === 'wopen') {
        await send({ t: 'wopened', id: f.id })
        if (f.path === '/ws/herdr') {
          await send({ t: 'wmsg', id: f.id, s: JSON.stringify({ type: 'snapshot', snapshot: { workspaces: [{ workspace_id: 'w1', label: 'tmp' }], panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 't1', agent: 'claude', agent_status: 'working', terminal_title_stripped: 'Claude Code' }] } }) })
        }
        if (f.path.startsWith('/ws/herdr/screen')) await send({ t: 'wmsg', id: f.id, s: JSON.stringify({ type: 'screen', read: { text: '' } }) })
      }
    })
  })
})

try {
  await page.goto(`http://127.0.0.1:${process.env.APP_PORT ?? 5174}`)
  await addDesktop(page, 'N', `alma://connect?u=https://relay.invalid&k=${code}&e2e=1`)
  await page.locator('.session-row').filter({ hasText: 'Claude Code' }).first().click()
  await page.waitForTimeout(900)

  // 1. The header reports the two still-running background agents.
  const badge = page.locator('.composer-fact.is-agents')
  const badgeText = (await badge.textContent())?.trim()
  await badge.click()
  await page.waitForTimeout(300)
  const sheetTitles = await page.locator('.agents-row strong').allTextContents()
  await page.screenshot({ path: 'test-artifacts/agents-sheet.png' })
  await page.getByRole('button', { name: '关闭' }).click()
  await page.waitForTimeout(200)

  // 2. Typing `/` opens the picker, filtered per agent.
  const composer = page.getByRole('textbox', { name: '消息' })
  await composer.fill('/')
  await page.waitForTimeout(300)
  const allCommands = await page.locator('.command-label').allTextContents()
  await composer.fill('/mo')
  await page.waitForTimeout(300)
  const filtered = await page.locator('.command-label').allTextContents()
  await page.screenshot({ path: 'test-artifacts/command-picker.png' })

  // 3. Running a command sends it to the terminal and switches view.
  await page.locator('.command-option').first().click()
  await page.waitForTimeout(700)
  const onTerminal = await page.getByRole('tab', { name: '终端' }).getAttribute('aria-selected')
  const draftAfter = await composer.inputValue().catch(() => '(unmounted)')

  console.log(JSON.stringify({ badgeText, sheetTitles, allCommands, filtered, sentText, onTerminal, draftAfter, pageErrors: errors }))
} finally {
  await browser.close()
}
