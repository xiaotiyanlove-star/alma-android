/**
 * The hardware Back button, sheet by sheet.
 *
 * The native shell asks `window.__almaAndroidBack` first and exits only when
 * that returns false. Anything that looks like a dialog but lives outside the
 * router is therefore invisible to Back: the sheet stays on screen and the app
 * quits behind it. Each sheet here is opened the way a user opens it, then Back
 * is called through the same bridge the shell uses.
 */
import { chromium } from '@playwright/test'
import { addDesktop } from './helpers.ts'
import { base64url, createKeyPair, deriveSessionKeys, fromBase64url, openFrame, sealFrame } from '../client/crypto.ts'

const code = base64url(new Uint8Array(32).fill(44))
// A second desktop needs a different code: the routing id derives from it, so
// the same code is the same desktop and would be merged, not added.
const codeB = base64url(new Uint8Array(32).fill(45))
const CWD = '/Users/dev/projects/alma-android'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
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
        else if (frame.path.startsWith('/api/herdr/chat')) await reply(frame.id, {
          session_id: 's1',
          page: { start: 0, end: 7, items: [
            { id: 'm1', kind: 'user', from: 'user', text: '跑一下', time: '2026-11-02T10:00:00Z' },
            // A background subagent: the sheet is reached from this row.
            { id: 'a1', kind: 'tool', time: '2026-11-02T10:00:04Z', tool: { id: 'a1', name: 'Agent', background: true, done: false, input: { description: '调研一下', subagent_type: 'general-purpose' } } },
            { id: 't1', kind: 'tool', time: '2026-11-02T10:00:06Z', tool: { id: 't1', name: 'Read', done: true, result_images: [{ url: '/api/herdr/image/x.png', mediaType: 'image/png' }] } },
            { id: 'm2', kind: 'assistant', text: '好了。', time: '2026-11-02T10:00:20Z' },
          ] },
        })
        else if (frame.path.startsWith('/api/herdr/image')) {
          await send({ t: 'hres', id: frame.id, status: 200, headers: { 'content-type': 'image/png' } })
          await send({ t: 'hchunk', id: frame.id, b: PNG })
          await send({ t: 'hend', id: frame.id })
        } else await reply(frame.id, { result: { read: { text: '' } } })
      }
      if (frame.t === 'wopen') {
        await send({ t: 'wopened', id: frame.id })
        if (frame.path === '/ws/herdr') await send({ t: 'wmsg', id: frame.id, s: JSON.stringify({ type: 'snapshot', snapshot: {
          workspaces: [{ workspace_id: 'w1', label: 'alma-android', cwd: CWD }],
          tabs: [{ tab_id: 't1', workspace_id: 'w1', label: '主会话' }],
          panes: [
            { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 't1', agent: 'claude', agent_status: 'working', cwd: CWD },
            { pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 't1', agent: 'codex', agent_status: 'idle', cwd: `${CWD}/packages/app` },
          ],
        } }) })
        if (frame.path.startsWith('/ws/herdr/screen')) await send({ t: 'wmsg', id: frame.id, s: JSON.stringify({ type: 'screen', read: { text: '' } }) })
      }
    })
  })
})

/** Calls the bridge exactly as the Android shell does; false means "exit". */
const hardwareBack = () => page.evaluate(() => (window as unknown as { __almaAndroidBack?: () => boolean }).__almaAndroidBack?.() ?? false)

const result: Record<string, boolean> = {}
try {
  await page.goto(`http://127.0.0.1:${process.env.APP_PORT ?? 5174}`)
  await addDesktop(page, '节点甲', `alma://connect?u=https://relay.invalid&k=${code}&e2e=1`)
  await page.locator('.session-row').first().waitFor({ timeout: 20000 })

  // ── node picker ──────────────────────────────────────────────────────
  // Two desktops are needed for the picker to be tappable, so add a second.
  // The list's own "+" is the new-session form; settings owns adding desktops.
  await page.getByRole('button', { name: '节点设置', exact: true }).click()
  await page.getByRole('button', { name: '添加节点', exact: true }).first().click()
  await page.getByLabel('节点名称', { exact: true }).fill('节点乙')
  await page.getByLabel('配对链接', { exact: true }).fill(`alma://connect?u=https://relay.invalid&k=${codeB}&e2e=1`)
  await page.getByRole('button', { name: '添加节点', exact: true }).last().click()
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: '返回会话', exact: true }).first().click().catch(() => undefined)
  await page.locator('.host-picker').waitFor({ timeout: 10000 })
  await page.locator('.host-picker').click()
  await page.locator('.host-sheet').waitFor({ timeout: 5000 })
  result.pickerHandled = await hardwareBack()
  result.pickerClosed = await page.locator('.host-sheet').count() === 0
  // Dismissing the picker must leave the app on a screen, not exit it.
  result.stillInApp = await page.locator('main').isVisible()
  // Adding the second desktop left it selected; the rest of the flow needs the
  // one that is actually connected.
  await page.locator('.host-picker').click()
  await page.locator('.host-sheet').waitFor({ timeout: 5000 })
  await page.getByRole('button', { name: /节点甲/ }).first().click()
  await page.locator('.session-row').first().waitFor({ timeout: 15000 })
  await page.waitForFunction(() => {
    const button = document.querySelector('button[aria-label="新建会话"]')
    return button instanceof HTMLButtonElement && !button.disabled
  }, undefined, { timeout: 20000 })

  // ── new session ──────────────────────────────────────────────────────
  await page.getByRole('button', { name: '新建会话' }).click()
  await page.getByRole('dialog', { name: '新建会话' }).waitFor({ timeout: 5000 })
  result.newSessionHandled = await hardwareBack()
  result.newSessionClosed = await page.getByRole('dialog', { name: '新建会话' }).count() === 0

  // ── rename ───────────────────────────────────────────────────────────
  await page.locator('.session-rename').first().click()
  await page.getByRole('dialog', { name: '重命名会话' }).waitFor({ timeout: 5000 })
  result.renameHandled = await hardwareBack()
  result.renameClosed = await page.getByRole('dialog', { name: '重命名会话' }).count() === 0

  // ── session: image, agents, subagent ─────────────────────────────────
  await page.locator('.session-row').first().click()
  await page.locator('.conversation-view').waitFor({ timeout: 20000 })
  await page.locator('button.transcript-image').first().waitFor({ timeout: 15000 })

  await page.locator('button.transcript-image').first().click()
  await page.locator('.image-viewer').waitFor({ timeout: 5000 })
  result.imageHandled = await hardwareBack()
  result.imageClosed = await page.locator('.image-viewer').count() === 0

  await page.locator('.composer-fact.is-agents').click()
  await page.getByRole('dialog', { name: '运行中的 agent' }).waitFor({ timeout: 5000 })
  result.agentsHandled = await hardwareBack()
  result.agentsClosed = await page.getByRole('dialog', { name: '运行中的 agent' }).count() === 0

  await page.locator('.composer-fact.is-agents').click()
  await page.getByRole('dialog', { name: '运行中的 agent' }).waitFor({ timeout: 5000 })
  await page.getByRole('button', { name: '查看' }).first().click()
  await page.getByRole('dialog', { name: '子 agent 记录' }).waitFor({ timeout: 8000 })
  result.subagentHandled = await hardwareBack()
  result.subagentClosed = await page.getByRole('dialog', { name: '子 agent 记录' }).count() === 0

  // ── composer: stop, and send alongside it when something is typed ────
  result.stopOnlyWhenEmpty = await page.locator('.send-button.is-stop').count() === 1
    && await page.locator('.send-button:not(.is-stop)').count() === 0
  await page.locator('#message-input').fill('顺便看一下日志')
  await page.waitForTimeout(250)
  result.sendOfferedWithDraft = await page.locator('.send-button:not(.is-stop)').count() === 1
  result.stopStillOfferedWithDraft = await page.locator('.send-button.is-stop').count() === 1
  await page.locator('#message-input').fill('')
  await page.waitForTimeout(200)

  // Back on the session screen with nothing open still has to reach the list,
  // not exit — that is the behaviour these sheets had been stealing.
  result.sessionBackHandled = await hardwareBack()
  result.backReachedList = await page.locator('.session-row').first().isVisible()

  const failures: string[] = []
  for (const [name, value] of Object.entries(result)) {
    if (value !== true) failures.push(`${name}: want true, got ${value}`)
  }
  failures.push(...errors.map((error) => `pageError: ${error}`))
  if (failures.length) {
    console.error(failures.join('\n'))
    process.exitCode = 1
  } else {
    console.log(JSON.stringify({ ...result, pageErrors: errors }))
  }
} finally {
  await browser.close()
}
