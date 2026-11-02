import { chromium } from '@playwright/test'
import { addDesktop } from './helpers.ts'
import { base64url, createKeyPair, deriveSessionKeys, fromBase64url, openFrame, sealFrame } from '../client/crypto.ts'

// Two panes: one tab Herdr numbered itself, one the user already named.
const code = base64url(new Uint8Array(32).fill(7))
function snapshot(renamed?: string) {
  return {
    workspaces: [{ workspace_id: 'w1', label: 'tmp' }],
    tabs: [
      { tab_id: 'w1:t3', workspace_id: 'w1', label: '3' },
      { tab_id: 'w1:t4', workspace_id: 'w1', label: renamed ?? '部署脚本' },
    ],
    panes: [
      { pane_id: 'w1:p3', workspace_id: 'w1', tab_id: 'w1:t3', agent: 'claude', agent_status: 'working', terminal_title_stripped: 'Claude Code', cwd: '/tmp' },
      { pane_id: 'w1:p4', workspace_id: 'w1', tab_id: 'w1:t4', agent: 'claude', agent_status: 'done', terminal_title_stripped: 'Claude Code', cwd: '/tmp' },
    ],
  }
}

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
const page = await context.newPage()
const errors: string[] = []
page.on('pageerror', (error: Error) => errors.push(error.message))
const renames: unknown[] = []

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
      const body = frame.b ? JSON.parse(new TextDecoder().decode(typeof frame.b === 'string' ? fromBase64url(frame.b) : frame.b)) : undefined
      if (frame.t === 'hreq') {
        if (frame.path === '/api/herdr/info') await reply(frame.id, { online: true })
        else if (frame.path.startsWith('/api/herdr/chat')) await reply(frame.id, { session_id: 's1', page: { start: 0, end: 1, items: [{ id: 'm1', kind: 'assistant', text: 'reply' }] } })
        else if (body?.method === 'tab.rename') {
          renames.push(body.params)
          await reply(frame.id, { result: { tab: body.params } })
          // A real desktop pushes a fresh snapshot after the rename.
          await send({ t: 'wmsg', id: 'hub', s: JSON.stringify({ type: 'snapshot', snapshot: snapshot(body.params.label) }) })
        } else await reply(frame.id, { result: { read: { text: '' } } })
      }
      if (frame.t === 'wopen') {
        await send({ t: 'wopened', id: frame.id })
        if (frame.path === '/ws/herdr') await send({ t: 'wmsg', id: frame.id, s: JSON.stringify({ type: 'snapshot', snapshot: snapshot() }) })
      }
    })
  })
})

try {
  await page.goto(`http://127.0.0.1:${process.env.APP_PORT ?? 5174}`)
  await addDesktop(page, '测试节点', `alma://connect?u=https://relay.invalid&k=${code}&e2e=1`)
  await page.waitForTimeout(700)
  const names = await page.locator('.session-row-copy strong').allInnerTexts()
  await page.screenshot({ path: 'test-artifacts/sessions-named.png', fullPage: true })

  await page.getByRole('button', { name: '重命名 部署脚本' }).click()
  await page.waitForTimeout(400)
  const prefilled = await page.getByLabel('会话名称', { exact: true }).inputValue()
  await page.screenshot({ path: 'test-artifacts/session-rename.png', fullPage: true })
  await page.getByLabel('会话名称', { exact: true }).fill('发布流程')
  await page.getByRole('button', { name: '保存' }).click()
  await page.waitForTimeout(800)
  const afterRename = await page.locator('.session-row-copy strong').allInnerTexts()

  // A tab Herdr numbered itself must not prefill as if it were a name.
  await page.getByRole('button', { name: '重命名 Claude Code' }).click()
  await page.waitForTimeout(400)
  const numberedPrefill = await page.getByLabel('会话名称', { exact: true }).inputValue()
  await page.getByRole('button', { name: '取消' }).click()

  // The composer opens a new session with an optional name.
  await page.getByRole('button', { name: '新建会话' }).first().click()
  await page.waitForTimeout(300)
  const hasNameField = await page.locator('#new-label').count()
  await page.screenshot({ path: 'test-artifacts/session-new.png', fullPage: true })

  console.log(JSON.stringify({ names, prefilled, afterRename, numberedPrefill, hasNameField, renames, pageErrors: errors }))
} finally {
  await browser.close()
}
