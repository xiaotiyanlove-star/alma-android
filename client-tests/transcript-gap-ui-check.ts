import { launchBrowser } from './browser.ts'
import { addDesktop } from './helpers.ts'
import { base64url, createKeyPair, deriveSessionKeys, fromBase64url, openFrame, sealFrame } from '../client/connection/crypto.ts'

// Three panes with no transcript: a shell, an agent that has not reported an
// id yet, and an agent that has started work but still has never reported one.
const code = base64url(new Uint8Array(32).fill(11))
const PANES = [
  { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', terminal_title_stripped: 'zsh', cwd: '/tmp' },
  { pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 'w1:t2', agent: 'claude', agent_status: 'idle', terminal_title_stripped: 'Claude Code', cwd: '/tmp' },
  { pane_id: 'w1:p3', workspace_id: 'w1', tab_id: 'w1:t3', agent: 'claude', agent_status: 'working', terminal_title_stripped: 'Claude Code', cwd: '/tmp' },
]
const snapshot = {
  workspaces: [{ workspace_id: 'w1', label: 'tmp' }],
  tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: '1' }, { tab_id: 'w1:t2', workspace_id: 'w1', label: '草稿' }, { tab_id: 'w1:t3', workspace_id: 'w1', label: '进行中' }],
  panes: PANES,
}

const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
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
        else if (frame.path.startsWith('/api/herdr/chat')) await reply(frame.id, { error: { code: 'no_agent_session', message: 'no session' } })
        else await reply(frame.id, { result: { read: { text: '' } } })
      }
      if (frame.t === 'wopen') {
        await send({ t: 'wopened', id: frame.id })
        if (frame.path === '/ws/herdr') await send({ t: 'wmsg', id: frame.id, s: JSON.stringify({ type: 'snapshot', snapshot }) })
      }
    })
  })
})

async function openPane(name: string) {
  await page.getByRole('button', { name: new RegExp(name) }).first().click()
  await page.waitForTimeout(700)
}
async function notice(): Promise<string> {
  const text = await page.locator('.session-notices').innerText().catch(() => '')
  return text.replace(/\s+/g, ' ').trim()
}
async function goBack() {
  await page.getByRole('button', { name: '返回会话' }).click()
  await page.waitForTimeout(400)
}

const report: Record<string, unknown> = {}

try {
  await page.goto(`http://127.0.0.1:${process.env.APP_PORT ?? 5174}`)
  await addDesktop(page, '测试节点', `alma://connect?u=https://relay.invalid&k=${code}&e2e=1`)
  await page.waitForTimeout(900)

  // A plain shell: no transcript, and no mention of an integration.
  await openPane('zsh')
  report.shell = {
    notice: await notice(),
    messagesTabDisabled: await page.getByRole('tab', { name: '消息' }).isDisabled(),
    terminalShown: await page.locator('.terminal-screen, .empty-state').first().isVisible().catch(() => false),
  }
  await page.screenshot({ path: 'test-artifacts/gap-shell.png', fullPage: true })
  await goBack()

  // An agent with no session id yet stays in the message view, so its first
  // prompt can be written, and says it is waiting rather than blaming anything.
  await openPane('草稿')
  report.waiting = {
    notice: await notice(),
    messagesTabDisabled: await page.getByRole('tab', { name: '消息' }).isDisabled(),
    messagesSelected: await page.getByRole('tab', { name: '消息' }).getAttribute('aria-selected'),
    composerVisible: await page.getByRole('textbox', { name: '消息' }).isVisible().catch(() => false),
  }
  await page.screenshot({ path: 'test-artifacts/gap-waiting.png', fullPage: true })

  // Sending is what turns "still starting" into "never reported an id": the
  // pane's status here is already working, so the same prompt becomes the
  // integration one liner.
  await page.getByRole('textbox', { name: '消息' }).fill('synthetic prompt')
  await page.locator('.send-button').click()
  // The pane is refreshed on its next scheduled retry; the gap is reclassified
  // then, and the message that was just sent is what makes it the integration.
  await page.waitForFunction(() => document.querySelector('.session-notices')?.textContent?.includes('Herdr integration'), undefined, { timeout: 12000 }).catch(() => undefined)
  report.afterSend = {
    notice: await notice(),
    messagesSelected: await page.getByRole('tab', { name: '消息' }).getAttribute('aria-selected'),
    messagesTabDisabled: await page.getByRole('tab', { name: '消息' }).isDisabled(),
    composerVisible: await page.getByRole('textbox', { name: '消息' }).isVisible().catch(() => false),
  }
  await page.screenshot({ path: 'test-artifacts/gap-integration.png', fullPage: true })

  console.log(JSON.stringify({ ...report, pageErrors: errors }))
} finally {
  await browser.close()
}
