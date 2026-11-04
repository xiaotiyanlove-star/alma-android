/**
 * The three session-list behaviours added together: stopping an agent from the
 * message view, unread marks on the list and desktop rows, and automatic
 * history loading at the top of the transcript.
 *
 * One file rather than three: they all need the same synthetic desktop, and
 * three browsers for one snapshot would only make the suite slower.
 */
import { chromium } from '@playwright/test'
import { addDesktop } from './helpers.ts'
import { base64url, createKeyPair, deriveSessionKeys, fromBase64url, openFrame, sealFrame } from '../client/crypto.ts'

const code = base64url(new Uint8Array(32).fill(77))
const CWD = '/Users/dev/projects/alma-android'

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
await context.addInitScript({ content: `try { localStorage.setItem('herdr.prefs.locale', 'zh-CN') } catch (e) {}` })
const page = await context.newPage()
const errors: string[] = []
page.on('pageerror', (error: Error) => errors.push(error.message))

// Mutable so the test can move the agent through states.
let working = true
let historyRequests = 0
const sentKeys: string[] = []
/** Set once the socket is open, so the test can push a status change. */
let pushStatus: ((status: string) => Promise<void>) | undefined

function state(): { working: boolean } { return { working } }

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
  const snapshot = () => ({ type: 'snapshot', snapshot: {
    workspaces: [{ workspace_id: 'w1', label: 'alma-android', cwd: CWD }],
    tabs: [{ tab_id: 't1', workspace_id: 'w1', label: '主会话' }],
    panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 't1', agent: 'claude', agent_status: state().working ? 'working' : 'done', cwd: CWD }],
  } })
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
        else if (frame.path.startsWith('/api/herdr/chat')) {
          // `before=` means the view asked for history; count it so the test
          // can prove scrolling loaded a page by itself.
          if (frame.path.includes('before=')) {
            historyRequests++
            await reply(frame.id, { session_id: 's1', page: { start: 0, end: 1, items: [{ id: 'old1', kind: 'assistant', text: '更早的一条', time: '2026-11-01T09:00:00Z' }] } })
          } else {
            // Enough rows to overflow the viewport: a short transcript cannot
            // scroll, so the auto-load path would never be exercised.
            const items = Array.from({ length: 40 }, (_, index) => ({ id: `m${index}`, kind: 'assistant', text: `第 ${index + 1} 条消息`, time: '2026-11-02T10:00:00Z' }))
            await reply(frame.id, { session_id: 's1', page: { start: 40, end: 80, items } })
          }
        } else if (frame.path === '/api/herdr/rpc') {
          // The body is raw bytes either way: JSON in the base64 form, JSON in
          // the binary form.
          const body = frame.b ? JSON.parse(new TextDecoder().decode(fromBase64url(frame.b))) : {}
          if (body.method === 'pane.send_keys') sentKeys.push(JSON.stringify(body.params?.keys ?? []))
          await reply(frame.id, { result: { ok: true } })
        } else await reply(frame.id, { result: { read: { text: 'terminal' } } })
      }
      if (frame.t === 'wopen') {
        await send({ t: 'wopened', id: frame.id })
        if (frame.path === '/ws/herdr') {
          await send({ t: 'wmsg', id: frame.id, s: JSON.stringify(snapshot()) })
          pushStatus = (status: string) => send({ t: 'wmsg', id: frame.id, s: JSON.stringify({ type: 'status', change: { pane_id: 'w1:p1', to: status } }) })
        }
        if (frame.path.startsWith('/ws/herdr/screen')) await send({ t: 'wmsg', id: frame.id, s: JSON.stringify({ type: 'screen', read: { text: 'token 12k · claude-opus' } }) })
      }
    })
  })
})

const result: Record<string, unknown> = {}
try {
  await page.goto(`http://127.0.0.1:${process.env.APP_PORT ?? 5174}`)
  await addDesktop(page, '测试节点', `alma://connect?u=https://relay.invalid&k=${code}&e2e=1`)
  await page.locator('.session-row').first().waitFor({ timeout: 20000 })

  // Groups: the header carries the workspace name and the full path.
  result.groupTitle = await page.locator('.session-group-name').first().innerText()
  result.groupPath = await page.locator('.session-group-path').first().innerText()
  result.rowPath = await page.locator('.session-row .session-path').first().innerText()
  result.agentIcon = await page.locator('.session-row .agent-mark img').first().getAttribute('src')
  await page.screenshot({ path: 'test-artifacts/session-groups.png' })

  // A working agent offers stop instead of send.
  await page.locator('.session-row').first().click()
  await page.locator('.stop-button').waitFor({ timeout: 20000 })
  result.stopButtonWhileWorking = true
  await page.screenshot({ path: 'test-artifacts/session-stop-button.png' })
  await page.locator('.stop-button').click()
  await page.waitForTimeout(600)
  result.stopSentCtrlC = sentKeys.some((keys) => keys.includes('ctrl+c'))

  // Scrolling to the top pulls the previous page without a button.
  const before = historyRequests
  // Moving to 0 only fires a scroll event when it was somewhere else, so the
  // test has to go down first — which is also what a reader does.
  await page.locator('.transcript-scroll').evaluate((el) => { el.scrollTop = el.scrollHeight })
  await page.waitForTimeout(200)
  await page.locator('.transcript-scroll').evaluate((el) => { el.scrollTop = 0 })
  await page.waitForTimeout(1500)
  result.autoLoadedHistory = historyRequests > before
  result.olderButtonGone = await page.getByRole('button', { name: '更早的记录' }).count() === 0

  // Back on the list, the finished turn is marked as news. The push is what a
  // desktop does when a turn ends, so it is also the realistic path.
  await page.getByRole('button', { name: '返回会话' }).first().click()
  working = false
  await pushStatus?.('done')
  await page.locator('.news-dot').first().waitFor({ timeout: 20000 })
  result.sessionMarkedNew = await page.locator('.session-row .news-dot').count() > 0
  await page.screenshot({ path: 'test-artifacts/session-unread.png' })
  // The desktop-level mark lives in Settings, where the host rows are.
  await page.getByRole('button', { name: '节点设置' }).click()
  await page.locator('.host-row').first().waitFor({ timeout: 10000 })
  result.desktopMarkedNew = await page.locator('.host-row .news-dot').count() > 0
  await page.getByRole('button', { name: '返回会话' }).first().click()
  await page.locator('.session-row').first().waitFor({ timeout: 10000 })

  // Opening it clears the mark.
  await page.locator('.session-row').first().click()
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: '返回会话' }).first().click()
  await page.waitForTimeout(800)
  result.markClearedAfterVisit = await page.locator('.session-row .news-dot').count() === 0

  const failures: string[] = []
  const must = (key: string, wanted: unknown) => {
    if (result[key] !== wanted) failures.push(`${key}: want ${JSON.stringify(wanted)}, got ${JSON.stringify(result[key])}`)
  }
  must('groupTitle', 'alma-android')
  must('groupPath', CWD)
  must('rowPath', CWD)
  if (!String(result.agentIcon ?? '').includes('claude')) failures.push(`agentIcon: ${result.agentIcon}`)
  must('stopButtonWhileWorking', true)
  must('stopSentCtrlC', true)
  must('autoLoadedHistory', true)
  must('olderButtonGone', true)
  must('sessionMarkedNew', true)
  must('desktopMarkedNew', true)
  must('markClearedAfterVisit', true)
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
