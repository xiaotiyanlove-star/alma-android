// The create-session flow, driven through the real dialog: open it, name the
// session, create it, and land in the new pane's conversation.
import { chromium } from '@playwright/test'
import { addDesktop } from './helpers.ts'
import { base64url, createKeyPair, deriveSessionKeys, fromBase64url, openFrame, sealFrame } from '../client/crypto.ts'

const code = base64url(new Uint8Array(32).fill(71))
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
await context.addInitScript({ content: `try { localStorage.setItem('herdr.prefs.locale', 'zh-CN') } catch (e) {}` })
const page = await context.newPage()
const errors: string[] = []
const calls: any[] = []
page.on('pageerror', (error: Error) => errors.push(error.message))

await page.routeWebSocket('wss://relay.invalid/**', (socket) => {
  let keys: Awaited<ReturnType<typeof deriveSessionKeys>>
  let counter = 0n
  let chain = Promise.resolve()
  const send = async (frame: Record<string, unknown>) => socket.send(Buffer.from(await sealFrame(keys.s2c, counter++, frame)))
  const reply = async (id: string, body: unknown, status = 200) => {
    await send({ t: 'hres', id, status, headers: {} })
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
        if (frame.path === '/api/herdr/info') { await reply(frame.id, { online: true }); return }
        if (frame.path.startsWith('/api/herdr/chat')) {
          await reply(frame.id, { session_id: 's9', page: { start: 0, end: 1, items: [{ id: 'n1', kind: 'assistant', text: '新建的会话已就绪' }] } })
          return
        }
        const rpc = JSON.parse(new TextDecoder().decode(fromBase64url(frame.b)))
        calls.push({ method: rpc.method, params: rpc.params, headers: frame.headers })
        if (rpc.method === 'layout.apply') {
          // Exactly what Alma's phone bridge answers: a method outside its
          // allowlist is refused with 403 before anything runs.
          await reply(frame.id, { error: { code: 'forbidden', message: 'layout.apply is not available from the phone' } }, 403)
          return
        }
        if (rpc.method === 'tab.create') {
          await reply(frame.id, { result: { tab: { tab_id: 'w1:t9', workspace_id: 'w1' }, root_pane: { pane_id: 'w1:p9', workspace_id: 'w1' } } })
          await send({ t: 'wmsg', id: 'hub', s: JSON.stringify({ type: 'snapshot', snapshot: {
            workspaces: [{ workspace_id: 'w1', label: 'tmp' }],
            tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'old' }, { tab_id: 'w1:t9', workspace_id: 'w1', label: '新会话' }],
            panes: [
              { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', agent: 'claude', agent_status: 'idle', terminal_title_stripped: 'Claude Code', cwd: '/private/tmp' },
              { pane_id: 'w1:p9', workspace_id: 'w1', tab_id: 'w1:t9', agent: 'claude', agent_status: 'working', terminal_title_stripped: 'Claude Code', cwd: '/private/tmp' },
            ],
          } }) })
          return
        }
        if (false) {
          // The real reply shape: the pane is inside `layout`.
          await reply(frame.id, { result: { type: 'layout_apply', layout: { workspace_id: 'w1', tab_id: 'w1:t9', zoomed: false, focused_pane_id: 'w1:p9', root: { type: 'pane' } } } })
          // The snapshot then lists the new pane, as a real desktop would.
          await send({ t: 'wmsg', id: 'hub', s: JSON.stringify({ type: 'snapshot', snapshot: {
            workspaces: [{ workspace_id: 'w1', label: 'tmp' }],
            tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'old' }, { tab_id: 'w1:t9', workspace_id: 'w1', label: '新会话' }],
            panes: [
              { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', agent: 'claude', agent_status: 'idle', terminal_title_stripped: 'Claude Code', cwd: '/private/tmp' },
              { pane_id: 'w1:p9', workspace_id: 'w1', tab_id: 'w1:t9', agent: 'claude', agent_status: 'working', terminal_title_stripped: 'Claude Code', cwd: '/private/tmp' },
            ],
          } }) })
          return
        }
        await reply(frame.id, { result: rpc.method === 'pane.read' ? { read: { text: '' } } : {} })
        return
      }
      if (frame.t === 'wopen') {
        await send({ t: 'wopened', id: frame.id })
        if (frame.path === '/ws/herdr') await send({ t: 'wmsg', id: frame.id, s: JSON.stringify({ type: 'snapshot', snapshot: {
          workspaces: [{ workspace_id: 'w1', label: 'tmp' }],
          tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'old' }],
          panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', agent: 'claude', agent_status: 'idle', terminal_title_stripped: 'Claude Code', cwd: '/private/tmp' }],
        } }) })
        if (frame.path.startsWith('/ws/herdr/screen')) await send({ t: 'wmsg', id: frame.id, s: JSON.stringify({ type: 'screen', read: { text: '' } }) })
      }
    })
  })
})

try {
  await page.goto(`http://127.0.0.1:${process.env.APP_PORT ?? 5174}`)
  await addDesktop(page, '测试节点', `alma://connect?u=https://relay.invalid&k=${code}&e2e=1`)
  await page.waitForTimeout(900)

  await page.getByRole('button', { name: '新建会话' }).first().click()
  await page.getByLabel('会话名称', { exact: true }).waitFor()
  const defaultCwd = await page.getByLabel('目录', { exact: true }).inputValue()
  await page.getByLabel('会话名称', { exact: true }).fill('发布流程')
  await page.getByRole('button', { name: '创建' }).click()

  // A successful create opens the new pane's conversation.
  await page.waitForFunction(() => document.body.innerText.includes('新建的会话已就绪'), undefined, { timeout: 15000 })
  const inSession = await page.getByRole('tab', { name: '消息' }).isVisible().catch(() => false)
  const headerTitle = await page.locator('.conversation-header h1').innerText().catch(() => '')
  const failure = await page.locator('.notice-error').innerText().catch(() => '')
  await page.screenshot({ path: 'test-artifacts/new-session.png' })

  const apply = calls.find((call) => call.method === 'layout.apply')
  const create = calls.find((call) => call.method === 'tab.create')
  const start = calls.find((call) => call.method === 'agent.start')
  console.log(JSON.stringify({
    defaultCwd,
    triedLayoutApply: Boolean(apply),
    usedTabCreate: Boolean(create),
    createCwd: create?.params?.cwd,
    createLabel: create?.params?.label,
    startedAgent: start?.params?.kind,
    focus: apply?.params?.focus,
    inSession,
    headerTitle,
    failure,
    pageErrors: errors,
  }))
} finally {
  await browser.close()
}
