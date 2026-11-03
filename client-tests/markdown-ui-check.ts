import { chromium } from '@playwright/test'
import { addDesktop } from './helpers.ts'
import { base64url, createKeyPair, deriveSessionKeys, fromBase64url, openFrame, routingId, sealFrame } from '../client/crypto.ts'

const code = base64url(new Uint8Array(32).fill(4))
const id = await routingId(code)
const REPLY = [
  '## 标题',
  '',
  '这是**加粗**和 `行内代码`，以及一个列表：',
  '',
  '- 第一项',
  '- 第二项',
  '',
  '| 列 A | 列 B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '```ts',
  'const x = 1',
  '```',
].join('\n')

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo', locale: 'en-US' })
await context.addInitScript(() => { try { localStorage.setItem('herdr.prefs.locale', 'zh-CN') } catch {} })
const page = await context.newPage()
const errors: string[] = []
page.on('pageerror', (error: Error) => errors.push(error.message))

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
        if (frame.path === '/api/herdr/info') await reply(frame.id, { online: true })
        else if (frame.path.startsWith('/api/herdr/chat')) await reply(frame.id, { session_id: 's1', page: { start: 0, end: 1, items: [{ id: 'm1', kind: 'assistant', text: REPLY, time: '2026-11-01T17:15:35.254Z' }] } })
        else await reply(frame.id, { result: { read: { text: '' } } })
      }
      if (frame.t === 'wopen') {
        await send({ t: 'wopened', id: frame.id })
        if (frame.path === '/ws/herdr') {
          await send({ t: 'wmsg', id: frame.id, s: JSON.stringify({ type: 'snapshot', snapshot: { workspaces: [{ workspace_id: 'w1', label: 'demo' }], panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 't1', agent: 'claude', agent_status: 'idle', terminal_title_stripped: 'Markdown 测试' }] } }) })
        }
      }
    })
  })
})

try {
  await page.goto(`http://127.0.0.1:${process.env.APP_PORT ?? 5174}`)
  await addDesktop(page, 'md', `alma://connect?u=https://relay.invalid&k=${code}&e2e=1`)
  await page.locator('.session-row').filter({ hasText: 'Markdown 测试' }).click()
  await page.locator('.markdown-body').waitFor({ timeout: 20000 })
  await page.screenshot({ path: 'test-artifacts/md-rendered.png' })

  const rendered = await page.evaluate(() => ({
    heading: document.querySelector('.markdown-body h2')?.textContent,
    strong: document.querySelector('.markdown-body strong')?.textContent,
    code: document.querySelector('.markdown-body code')?.textContent,
    listItems: document.querySelectorAll('.markdown-body li').length,
    table: Boolean(document.querySelector('.markdown-body table')),
    timeText: document.querySelector('.message-meta time')?.textContent,
  }))

  // The three views are one segmented tablist; 源码 is a tab, not a toggle.
  await page.getByRole('tab', { name: '源码' }).click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'test-artifacts/md-source.png' })
  const source = await page.evaluate(() => ({
    hasRawHeading: (document.querySelector('.prose-text')?.textContent ?? '').includes('## 标题'),
    markdownBodyGone: !document.querySelector('.markdown-body'),
  }))

  console.log(JSON.stringify({ rendered, source, pageErrors: errors }))
} finally {
  await browser.close()
}
