// Copy buttons: one on each fenced code block, one on each agent reply.
// Checks the clipboard actually receives the text, not just that a button exists.
import { chromium } from '@playwright/test'
import { addDesktop } from './helpers.ts'
import { base64url, createKeyPair, deriveSessionKeys, fromBase64url, openFrame, sealFrame } from '../client/crypto.ts'

const code = base64url(new Uint8Array(32).fill(91))
const REPLY = '第一段回答，用来验证整条回复的复制。\n\n```ts\nconst answer = 42\n```\n\n第二段。'
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', permissions: ['clipboard-read', 'clipboard-write'] })
await context.addInitScript({ content: `try { localStorage.setItem('herdr.prefs.locale', 'zh-CN') } catch (e) {}` })
const page = await context.newPage()
const errors: string[] = []
page.on('pageerror', (error: Error) => errors.push(error.message))

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
        keys = await deriveSessionKeys({ connectCode: code, myPrivateKey: pair.privateKey, peerPublic: fromBase64url(hi.epk), initiatorPublic: fromBase64url(hi.epk), responderPublic: pair.publicKey, initiatorNonce: fromBase64url(hi.n), responderNonce: nonce })
        socket.send(JSON.stringify({ t: 'hi', epk: base64url(pair.publicKey), n: base64url(nonce), cr: base64url(keys.confirmResponder) }))
        return
      }
      const frame = await openFrame(keys.c2s, new Uint8Array(data as unknown as ArrayBuffer)) as Record<string, any>
      if (frame.t === 'hreq') {
        if (frame.path === '/api/herdr/info') await reply(frame.id, { online: true })
        else if (frame.path.startsWith('/api/herdr/chat')) await reply(frame.id, { session_id: 's1', page: { start: 0, end: 2, items: [
          { id: 'm1', kind: 'user', from: 'user', text: '这个问题是我的', time: '2026-11-02T10:00:00Z' },
          { id: 'm2', kind: 'assistant', text: REPLY, time: '2026-11-02T10:00:10Z' },
        ] } })
        else await reply(frame.id, { result: { read: { text: '' } } })
      }
      if (frame.t === 'wopen') {
        await send({ t: 'wopened', id: frame.id })
        if (frame.path === '/ws/herdr') await send({ t: 'wmsg', id: frame.id, s: JSON.stringify({ type: 'snapshot', snapshot: { workspaces: [{ workspace_id: 'w1', label: 'tmp' }], tabs: [{ tab_id: 't1', workspace_id: 'w1', label: 'x' }], panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 't1', agent: 'claude', agent_status: 'idle', cwd: '/tmp' }] } }) })
        if (frame.path.startsWith('/ws/herdr/screen')) await send({ t: 'wmsg', id: frame.id, s: JSON.stringify({ type: 'screen', read: { text: '' } }) })
      }
    })
  })
})

const clip = () => page.evaluate(() => navigator.clipboard.readText()).catch(() => '')

try {
  await page.goto(`http://127.0.0.1:${process.env.APP_PORT ?? 5174}`)
  await addDesktop(page, '测试节点', `alma://connect?u=https://relay.invalid&k=${code}&e2e=1`)
  await page.waitForTimeout(900)
  await page.locator('.session-row').first().click()
  await page.waitForTimeout(900)

  // A code block: copies only the code, not the surrounding prose.
  await page.locator('.md-code .md-code-copy').first().click()
  await page.waitForTimeout(250)
  const codeCopied = await clip()

  // The reply: copies the whole message text.
  await page.locator('.message-copy').first().click()
  await page.waitForTimeout(250)
  const replyCopied = await clip()
  const replyButtonLabel = await page.getByRole('button', { name: /已复制|复制回复/ }).first().getAttribute('aria-label')
  await page.screenshot({ path: 'test-artifacts/copy-buttons.png' })

  // Your own message is not offered a copy button.
  const ownCopies = await page.locator('.message-user .md-code-copy').count()

  console.log(JSON.stringify({
    codeCopied,
    replyCopied,
    replyHasWholeText: replyCopied.includes('第一段回答') && replyCopied.includes('const answer = 42') && replyCopied.includes('第二段'),
    replyButtonLabel,
    ownCopies,
    pageErrors: errors,
  }))
} finally {
  await browser.close()
}
