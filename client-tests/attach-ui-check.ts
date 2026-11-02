import { chromium } from '@playwright/test'
import { base64url, createKeyPair, deriveSessionKeys, fromBase64url, openFrame, routingId, sealFrame } from '../client/crypto.ts'

const code = base64url(new Uint8Array(32).fill(71))
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
await context.addInitScript(() => { try { localStorage.setItem('herdr.prefs.locale', 'zh-CN') } catch {} })
const page = await context.newPage()
const errors: string[] = []
page.on('pageerror', (e) => errors.push(e.message))
const uploads: { path: string; filename: string | null; size: number }[] = []

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
  socket.onMessage((data) => {
    chain = chain.then(async () => {
      if (typeof data === 'string') {
        const hi = JSON.parse(data)
        if (hi.t === 'ok') return
        const pair = await createKeyPair(); const nonce = crypto.getRandomValues(new Uint8Array(16))
        keys = await deriveSessionKeys({ connectCode: code, myPrivateKey: pair.privateKey, peerPublic: fromBase64url(hi.epk), initiatorPublic: fromBase64url(hi.epk), responderPublic: pair.publicKey, initiatorNonce: fromBase64url(hi.n), responderNonce: nonce })
        socket.send(JSON.stringify({ t: 'hi', epk: base64url(pair.publicKey), n: base64url(nonce), cr: base64url(keys.confirmResponder) }))
        return
      }
      const frame = await openFrame(keys.c2s, new Uint8Array(data as unknown as ArrayBuffer)) as Record<string, any>
      if (frame.t === 'hreq') {
        if (frame.path === '/api/herdr/info') await reply(frame.id, { online: true })
        else if (frame.path.startsWith('/api/attachments/')) {
          uploads.push({ path: frame.path, filename: frame.headers['x-alma-filename'] ?? null, size: frame.b ? fromBase64url(frame.b).length : 0 })
          await reply(frame.id, { filePath: '/Users/x/cache/attachment-abc.png', filename: 'attachment-abc.png', size: 5 })
        } else if (frame.path.startsWith('/api/herdr/chat')) await reply(frame.id, { session_id: 's1', page: { start: 0, end: 1, items: [{ id: 'm1', kind: 'assistant', text: 'ready' }] } })
        else await reply(frame.id, { result: { read: { text: '' } } })
      }
      if (frame.t === 'wopen') {
        await send({ t: 'wopened', id: frame.id })
        if (frame.path === '/ws/herdr') await send({ t: 'wmsg', id: frame.id, s: JSON.stringify({ type: 'snapshot', snapshot: { workspaces: [{ workspace_id: 'w1', label: 'ws' }], panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 't1', agent: 'claude', agent_status: 'idle', terminal_title_stripped: 'S' }] } }) })
        if (frame.path.startsWith('/ws/herdr/screen')) await send({ t: 'wmsg', id: frame.id, s: JSON.stringify({ type: 'screen', read: { text: '' } }) })
      }
    })
  })
})

try {
  await page.goto('http://127.0.0.1:5174')
  await page.getByRole('button', { name: '添加节点', exact: true }).first().click()
  await page.getByLabel('节点名称', { exact: true }).fill('N')
  await page.getByLabel('配对链接', { exact: true }).fill(`alma://connect?u=https://relay.invalid&k=${code}&e2e=1`)
  await page.getByRole('button', { name: '添加节点', exact: true }).last().click()
  await page.getByRole('button', { name: /S/ }).first().click()
  await page.waitForTimeout(800)

  const button = page.getByRole('button', { name: '添加附件' })
  const state = {
    visible: await button.isVisible().catch(() => false),
    enabled: await button.isEnabled().catch(() => false),
    hasFileInput: await page.locator('input[type=file]').count(),
  }
  // Feed the input the way the OS picker would, then send.
  await page.locator('input[type=file]').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('hello upload') })
  await page.waitForTimeout(500)
  const trayCount = await page.locator('.attachment-chip').count()
  await page.getByRole('textbox', { name: '消息' }).fill('看附件')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await page.waitForTimeout(1500)
  await page.screenshot({ path: 'test-artifacts/attach-sent.png' })
  console.log(JSON.stringify({ state, trayCount, uploads, pageErrors: errors }))
} finally { await browser.close() }
