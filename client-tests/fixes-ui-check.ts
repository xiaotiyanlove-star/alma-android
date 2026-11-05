import { chromium } from '@playwright/test'
import { addDesktop } from './helpers.ts'
import { base64url, createKeyPair, deriveSessionKeys, fromBase64url, openFrame, routingId, sealFrame } from '../client/crypto.ts'

const code = base64url(new Uint8Array(32).fill(6))
const SCREEN = [
  '│ model: claude-opus-5-5 │ context left: 74% │',
  '> waiting',
].join('\n')

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
const page = await context.newPage()
const errors: string[] = []
page.on('pageerror', (error: Error) => errors.push(error.message))

await page.routeWebSocket('wss://relay.invalid/**', (socket) => {
  let keys: Awaited<ReturnType<typeof deriveSessionKeys>>
  let counter = 0n
  let chain = Promise.resolve()
  let chatId = ''
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
        else if (frame.path.startsWith('/api/herdr/chat')) await reply(frame.id, { session_id: 's1', page: { start: 0, end: 1, items: [{ id: 'm1', kind: 'assistant', text: 'reply' }] } })
        else await reply(frame.id, { result: { read: { text: SCREEN } } })
      }
      if (frame.t === 'wopen') {
        await send({ t: 'wopened', id: frame.id })
        if (frame.path === '/ws/herdr') {
          await send({ t: 'wmsg', id: frame.id, s: JSON.stringify({ type: 'snapshot', snapshot: { workspaces: [{ workspace_id: 'w1', label: 'ws' }], panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 't1', agent: 'claude', agent_status: 'idle', terminal_title_stripped: '会话 A' }] } }) })
        }
        if (frame.path.startsWith('/ws/herdr/chat')) chatId = frame.id
        if (frame.path.startsWith('/ws/herdr/screen')) {
          await send({ t: 'wmsg', id: frame.id, s: JSON.stringify({ type: 'screen', read: { text: SCREEN } }) })
        }
      }
    })
  })
})

try {
  await page.goto(`http://127.0.0.1:${process.env.APP_PORT ?? 5174}`)
  await addDesktop(page, '测试节点', `alma://connect?u=https://relay.invalid&k=${code}&e2e=1`)
  await page.locator('.session-row').filter({ hasText: '会话 A' }).click()
  await page.waitForTimeout(700)

  // Session info comes from the terminal status line. The model and context
  // live on their own row under the title; the pane's state stays beside it.
  const chips = await page.locator('.composer-facts, .session-chip').allTextContents()
  const toolbar = await page.locator('.view-toolbar').evaluate((element) => {
    const segments = element.querySelector('.view-segments')
    const first = segments?.querySelector('button')
    if (!(segments instanceof HTMLElement) || !(first instanceof HTMLElement)) return null
    return {
      toolbarHeight: element.getBoundingClientRect().height,
      segmentHeight: segments.getBoundingClientRect().height,
      buttonHeight: first.getBoundingClientRect().height,
      label: first.textContent?.trim(),
    }
  })
  const restoredToolbar = toolbar !== null
    && toolbar.toolbarHeight <= 49
    && toolbar.segmentHeight <= 39
    && toolbar.buttonHeight <= 33
    && toolbar.label === '消息'
  const maintenance = page.locator('.view-maintenance')
  const primaryActions = await page.locator('.view-toolbar .view-actions > button').count()
  await maintenance.locator('summary').click()
  const maintenanceMenu = maintenance.locator('.view-maintenance-menu')
  const menuBox = await maintenanceMenu.boundingBox()
  const maintenanceItemHeight = await maintenance.locator('.maintenance-action').first().evaluate((node) => node.getBoundingClientRect().height)
  const menuVisible = await maintenanceMenu.evaluate((node) => {
    const box = node.getBoundingClientRect()
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + 10)
    return Boolean(top && node.contains(top))
  })
  await page.screenshot({ path: 'test-artifacts/session-maintenance-menu.png' })
  await maintenance.locator('summary').click()
  const maintenanceCollapsed = !(await maintenance.locator('.view-maintenance-menu').isVisible())
  const segmentHitArea = await page.locator('.view-segments button').evaluateAll((nodes) => nodes.map((node) => {
    const after = getComputedStyle(node, '::after')
    return node.getBoundingClientRect().height + Math.abs(parseFloat(after.top)) * 2
  }))
  const composerFontSizes = await page.locator('.composer-fact, .composer-status').evaluateAll((nodes) => nodes.map((node) => parseFloat(getComputedStyle(node).fontSize)))

  // Draft survives leaving the session and coming back.
  const composer = page.getByRole('textbox', { name: '消息' })
  await composer.fill('未发送的草稿')
  await page.getByRole('button', { name: '返回会话' }).click()
  await page.locator('.session-row').filter({ hasText: '会话 A' }).click()
  await page.waitForTimeout(500)
  const draftRestored = await page.getByRole('textbox', { name: '消息' }).inputValue()

  // The pending indicator appears after sending and disappears on arrival.
  await page.getByRole('textbox', { name: '消息' }).fill('hi')
  const sendBtnDisabled = await page.getByRole('button', { name: '发送', exact: true }).isDisabled()
  const draftBefore = await page.getByRole('textbox', { name: '消息' }).inputValue()
  // Poll immediately: the mock replies fast, so the indicator is short-lived.
  await page.getByRole('button', { name: '发送', exact: true }).click()
  let thinkingShown = false
  for (let i = 0; i < 40 && !thinkingShown; i++) {
    thinkingShown = await page.locator('.thinking').isVisible().catch(() => false)
    if (!thinkingShown) await page.waitForTimeout(25)
  }
  await page.screenshot({ path: 'test-artifacts/pending-thinking.png' })

  // Language switch translates the whole app.
  await page.getByRole('button', { name: '返回会话' }).click()
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: '节点设置' }).click()
  await page.waitForTimeout(200)
  await page.locator('.select-row').filter({ hasText: '语言' }).locator('select').selectOption('en')
  await page.waitForTimeout(500)
  const english = await page.locator('.group-title').allTextContents()
  await page.screenshot({ path: 'test-artifacts/settings-english.png' })

  console.log(JSON.stringify({ chips, toolbar, restoredToolbar, menuBox, menuVisible, maintenanceItemHeight, primaryActions, maintenanceCollapsed, segmentHitArea, composerFontSizes, draftRestored, thinkingShown, englishGroups: english, pageErrors: errors }))
  if (!restoredToolbar || primaryActions !== 0 || !menuVisible || !menuBox || menuBox.height === 0 || maintenanceItemHeight < 44 || !maintenanceCollapsed) process.exitCode = 1
  if (segmentHitArea.some((height) => height < 48)) process.exitCode = 1
  if (composerFontSizes.some((size) => size < 12)) process.exitCode = 1
} finally {
  await browser.close()
}
