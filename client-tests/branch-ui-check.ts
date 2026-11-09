import { launchBrowser } from './browser.ts'
import { addDesktop } from './helpers.ts'
import { base64url, createKeyPair, deriveSessionKeys, fromBase64url, openFrame, sealFrame } from '../client/connection/crypto.ts'

const code = base64url(new Uint8Array(32).fill(74))
const branch = 'review/branch-info'
const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
await context.addInitScript(() => { try { localStorage.setItem('herdr.prefs.locale', 'zh-CN') } catch {} })
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
        const hello = JSON.parse(data)
        if (hello.t === 'ok') return
        const pair = await createKeyPair()
        const nonce = crypto.getRandomValues(new Uint8Array(16))
        keys = await deriveSessionKeys({ connectCode: code, myPrivateKey: pair.privateKey, peerPublic: fromBase64url(hello.epk), initiatorPublic: fromBase64url(hello.epk), responderPublic: pair.publicKey, initiatorNonce: fromBase64url(hello.n), responderNonce: nonce })
        socket.send(JSON.stringify({ t: 'hi', epk: base64url(pair.publicKey), n: base64url(nonce), cr: base64url(keys.confirmResponder) }))
        return
      }
      const frame = await openFrame(keys.c2s, new Uint8Array(data as unknown as ArrayBuffer)) as Record<string, any>
      if (frame.t === 'hreq') {
        if (frame.path === '/api/herdr/info') await reply(frame.id, { online: true })
        else if (frame.path.startsWith('/api/herdr/chat')) await reply(frame.id, { session_id: 's1', page: { start: 0, end: 1, items: [{ id: 'm1', kind: 'assistant', text: '分支测试' }] } })
        else await reply(frame.id, { result: { read: { text: '' } } })
      }
      if (frame.t === 'wopen') {
        await send({ t: 'wopened', id: frame.id })
        if (frame.path === '/ws/herdr') await send({ t: 'wmsg', id: frame.id, s: JSON.stringify({ type: 'snapshot', snapshot: {
          workspaces: [{ workspace_id: 'w1', label: 'branch', cwd: '/work/project' }],
          panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 't1', agent: 'claude', agent_status: 'idle', terminal_title_stripped: 'branch test', cwd: '/work/project', git_branch: branch }],
        } }) })
        if (frame.path.startsWith('/ws/herdr/screen')) await send({ t: 'wmsg', id: frame.id, s: JSON.stringify({ type: 'screen', read: { text: `branch: ${branch}` } }) })
      }
    })
  })
})

try {
  await page.goto(`http://127.0.0.1:${process.env.APP_PORT ?? 5174}`)
  await addDesktop(page, '分支节点', `alma://connect?u=https://relay.invalid&k=${code}&e2e=1`)
  await page.getByRole('button', { name: /^打开 / }).first().click()
  const chip = page.locator('.session-branch')
  await chip.waitFor({ timeout: 15000 })
  const shown = await chip.innerText()
  await page.screenshot({ path: 'test-artifacts/branch-info.png' })
  console.log(JSON.stringify({ shown, pageErrors: errors }))
  if (shown !== branch || errors.length) process.exitCode = 1
} finally {
  await browser.close()
}
