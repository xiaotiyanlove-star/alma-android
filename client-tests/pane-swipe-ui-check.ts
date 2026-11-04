/**
 * One tab, two panes, and a transcript picture.
 *
 * Herdr can split a tab into several panes. On a phone that split has no room,
 * so the panes of the current tab become pages swiped left and right. This
 * check pins that behaviour down, plus the image viewer it sits beside: a
 * picture that is tapped has to open full-screen, and one that is too wide or
 * too tall must not widen the column.
 */
import { chromium } from '@playwright/test'
import { addDesktop } from './helpers.ts'
import { base64url, createKeyPair, deriveSessionKeys, fromBase64url, openFrame, sealFrame } from '../client/crypto.ts'

const code = base64url(new Uint8Array(32).fill(88))
const CWD = '/Users/dev/projects/alma-android'

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', hasTouch: true })
await context.addInitScript({ content: `try { localStorage.setItem('herdr.prefs.locale', 'zh-CN') } catch (e) {}` })
const page = await context.newPage()
const errors: string[] = []
page.on('pageerror', (error: Error) => errors.push(error.message))

// A 1×1 PNG is enough: the viewer only needs a decodable source.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

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
        else if (frame.path.startsWith('/api/herdr/chat')) {
          const pane = new URL('https://x' + frame.path).searchParams.get('pane')
          await reply(frame.id, { session_id: `s-${pane}`, page: { start: 0, end: 1, items: [
            // A tool result picture: this is the case that used to hide the
            // thumbnail inside the folded run.
            { id: `t-${pane}`, kind: 'tool', time: '2026-11-02T09:59:00Z', tool: { id: `t-${pane}`, name: 'Read', done: true, result_images: [{ url: '/api/herdr/image/shot.png', mediaType: 'image/png' }] } },
            { id: `m-${pane}`, kind: 'assistant', text: `来自 ${pane} 的回复`, time: '2026-11-02T10:00:00Z' },
          ] } })
        } else if (frame.path.startsWith('/api/herdr/file') || frame.path.startsWith('/api/herdr/image')) {
          await send({ t: 'hres', id: frame.id, status: 200, headers: { 'content-type': 'image/png' } })
          await send({ t: 'hchunk', id: frame.id, b: PNG })
          await send({ t: 'hend', id: frame.id })
        } else await reply(frame.id, { result: { read: { text: 'token 12k' } } })
      }
      if (frame.t === 'wopen') {
        await send({ t: 'wopened', id: frame.id })
        if (frame.path === '/ws/herdr') await send({ t: 'wmsg', id: frame.id, s: JSON.stringify({ type: 'snapshot', snapshot: {
          workspaces: [{ workspace_id: 'w1', label: 'alma-android', cwd: CWD }],
          tabs: [{ tab_id: 't1', workspace_id: 'w1', label: '分屏' }],
          // Same tab, two panes: the case swipe navigation is for.
          panes: [
            { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 't1', agent: 'claude', agent_status: 'idle', cwd: CWD },
            { pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 't1', agent: 'codex', agent_status: 'idle', cwd: `${CWD}/packages/app/src/features/session-view/components` },
          ],
        } }) })
        if (frame.path.startsWith('/ws/herdr/screen')) await send({ t: 'wmsg', id: frame.id, s: JSON.stringify({ type: 'screen', read: { text: 'token 12k' } }) })
      }
    })
  })
})

const result: Record<string, unknown> = {}
try {
  await page.goto(`http://127.0.0.1:${process.env.APP_PORT ?? 5174}`)
  await addDesktop(page, '测试节点', `alma://connect?u=https://relay.invalid&k=${code}&e2e=1`)
  await page.locator('.session-row').first().waitFor({ timeout: 20000 })
  // One row per tab, even though the tab holds two panes.
  result.rowsInList = await page.locator('.session-row').count()
  result.paneBadge = await page.locator('.session-pane-count').first().innerText()

  await page.locator('.session-row').first().click()
  await page.locator('.conversation-view').waitFor({ timeout: 20000 })
  await page.waitForTimeout(600)
  // The counter says which page of the tab this is.
  result.pagerLabel = await page.locator('.session-chip.is-panes').first().innerText()

  // Swipe left: the next pane in the same tab.
  const box = await page.locator('.conversation-view').boundingBox()
  if (!box) throw new Error('no conversation box')
  const y = box.y + box.height * 0.45
  await page.touchscreen.tap(box.x + box.width / 2, y)
  // Injected as a string: a bundled arrow function would reference esbuild's
  // helpers, which do not exist in the page.
  await page.evaluate(`(() => {
    const element = document.querySelector('.conversation-view')
    const x1 = ${box.x + box.width - 40}, x2 = ${box.x + 40}, yy = ${y}
    const touch = (x) => new Touch({ identifier: 1, target: element, clientX: x, clientY: yy })
    element.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch(x1)], changedTouches: [touch(x1)] }))
    element.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [], changedTouches: [touch(x2)] }))
  })()`)
  // The route answers the gesture immediately; the list must never flash.
  await page.waitForTimeout(60)
  result.listVisibleDuringSwipe = await page.locator('.session-row').count() > 0
  result.pagerRightAfterSwipe = await page.locator('.session-chip.is-panes').first().innerText().catch(() => '')
  await page.waitForTimeout(1200)
  result.pagerAfterSwipe = await page.locator('.session-chip.is-panes').first().innerText().catch(() => '')
  result.headerAfterSwipe = await page.locator('.conversation-header h1').first().innerText()
  result.workspaceAfterSwipe = await page.locator('.session-workspace').first().innerText().catch(() => '')
  result.headerOverflows = await page.locator('.session-workspace').first().evaluate((el) => el.scrollWidth > el.clientWidth).catch(() => false)
  result.headerStyle = await page.locator('.session-workspace').first().evaluate((el) => {
    const st = getComputedStyle(el)
    return { overflowX: st.overflowX, whiteSpace: st.whiteSpace, maxWidth: st.maxWidth, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }
  }).catch(() => null)

  // A transcript picture: bounded by the column, visible without expanding the
  // folded run, and tappable.
  await page.locator('button.transcript-image').first().waitFor({ timeout: 15000 }).catch(() => undefined)
  result.runImageCount = await page.locator('.transcript-images.is-run button.transcript-image').count()
  result.anyImageCount = await page.locator('button.transcript-image').count()
  result.thumbnailVisibleWithoutOpening = await page.locator('.transcript-images.is-run button.transcript-image').first().isVisible().catch(() => false)
  result.workGroupClosed = await page.locator('.work-group').first().evaluate((el) => !(el as HTMLDetailsElement).open).catch(() => false)
  const hasImage = await page.locator('button.transcript-image').count() > 0
  result.hasTappableImage = hasImage
  if (hasImage) {
    const width = await page.locator('button.transcript-image img').first().evaluate((el) => el.getBoundingClientRect().width)
    const column = await page.locator('.transcript-scroll').first().evaluate((el) => el.getBoundingClientRect().width)
    result.imageWithinColumn = width <= column
    await page.locator('button.transcript-image').first().click()
    await page.locator('.image-viewer').waitFor({ timeout: 5000 })
    result.viewerOpened = true
    await page.screenshot({ path: 'test-artifacts/image-viewer.png' })
    // The hardware Back must close the viewer, not leave the app. The shell
    // calls this bridge; in the browser the same function is called directly.
    const backHandled = await page.evaluate(`(() => window.__almaAndroidBack ? window.__almaAndroidBack() : 'missing')()`)
    result.backClosedViewer = backHandled === true && await page.locator('.image-viewer').count() === 0
    result.viewerClosed = await page.locator('.image-viewer').count() === 0
  }

  const failures: string[] = []
  const must = (key: string, wanted: unknown) => {
    if (result[key] !== wanted) failures.push(`${key}: want ${JSON.stringify(wanted)}, got ${JSON.stringify(result[key])}`)
  }
  must('rowsInList', 1)
  must('paneBadge', '+1')
  must('pagerLabel', '1/2')
  // The gesture is answered on the next frame, and the list never appears.
  must('pagerRightAfterSwipe', '2/2')
  must('listVisibleDuringSwipe', false)
  must('pagerAfterSwipe', '2/2')
  // The pane's own directory, not the workspace root.
  must('workspaceAfterSwipe', `${CWD}/packages/app/src/features/session-view/components`)
  must('headerOverflows', true)
  must('hasTappableImage', true)
  must('thumbnailVisibleWithoutOpening', true)
  must('workGroupClosed', true)
  must('backClosedViewer', true)
  must('imageWithinColumn', true)
  must('viewerOpened', true)
  must('viewerClosed', true)
  const style = result.headerStyle as { overflowX?: string; whiteSpace?: string } | null
  if (style?.overflowX !== 'auto' || style?.whiteSpace !== 'nowrap') failures.push(`headerStyle: ${JSON.stringify(style)}`)
  failures.push(...errors.map((error) => `pageError: ${error}`))
  if (failures.length) {
    console.error('RESULT', JSON.stringify(result))
    console.error(failures.join('\n'))
    process.exitCode = 1
  } else {
    console.log(JSON.stringify({ ...result, pageErrors: errors }))
  }
} finally {
  await browser.close()
}
