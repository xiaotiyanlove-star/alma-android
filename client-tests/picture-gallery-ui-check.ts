/**
 * Two ways out of the way of the reader.
 *
 * 1. A picture opened full-screen can be swiped to its neighbours. A transcript
 *    is often three screenshots in a row, and closing and reopening the viewer
 *    for each one is the difference between reading the result and giving up.
 * 2. The "more actions" menu closes when the user taps anywhere else. A
 *    `<details>` menu keeps itself open, so the tap meant to dismiss it landed
 *    on the next menu item instead.
 */
import { launchBrowser } from './browser.ts'
import { addDesktop, goHome } from './helpers.ts'
import { base64url, createKeyPair, deriveSessionKeys, fromBase64url, openFrame, sealFrame } from '../client/connection/crypto.ts'

const code = base64url(new Uint8Array(32).fill(93))
const CWD = '/Users/dev/projects/alma-android'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', hasTouch: true })
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
      if (frame.t === 'wopen') {
        await send({ t: 'wopened', id: frame.id })
        if (frame.path === '/ws/herdr') await send({ t: 'wmsg', id: frame.id, s: JSON.stringify({ type: 'snapshot', snapshot: {
          workspaces: [{ workspace_id: 'w1', label: 'alma-android', cwd: CWD }],
          tabs: [{ tab_id: 't1', workspace_id: 'w1', label: '图集' }],
          panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 't1', agent: 'claude', agent_status: 'idle', cwd: CWD }],
        } }) })
        if (frame.path.startsWith('/ws/herdr/screen')) await send({ t: 'wmsg', id: frame.id, s: JSON.stringify({ type: 'screen', read: { text: 'ok' } }) })
        return
      }
      if (frame.t !== 'hreq') return
      if (frame.path === '/api/herdr/info') return reply(frame.id, { online: true })
      if (frame.path === '/api/herdr/mutes') return reply(frame.id, { workspaces: [], tabs: [] })
      if (frame.path === '/__alma_lan__') return reply(frame.id, null)
      if (frame.path.startsWith('/api/herdr/chat')) {
        return reply(frame.id, { session_id: 's1', page: { start: 0, end: 4, items: [
          // Three pictures in reading order, one of them riding on a tool call
          // so the gallery has to interleave the two sources.
          { id: 'm1', kind: 'user', from: 'user', text: '看看这三张', time: '2026-11-02T10:00:00Z' },
          { id: 't1', kind: 'tool', time: '2026-11-02T10:00:04Z', tool: { id: 't1', name: 'Read', done: true, result_images: [{ url: '/api/herdr/image/one.png', mediaType: 'image/png' }] } },
          { id: 'm2', kind: 'assistant', text: '第二张 /Users/me/two.png', time: '2026-11-02T10:00:10Z' },
          { id: 'm3', kind: 'assistant', text: '第三张 /Users/me/three.png', time: '2026-11-02T10:00:20Z' },
        ] } })
      }
      if (frame.path.startsWith('/api/herdr/file') || frame.path.startsWith('/api/herdr/image')) {
        await send({ t: 'hres', id: frame.id, status: 200, headers: { 'content-type': 'image/png' } })
        await send({ t: 'hchunk', id: frame.id, b: PNG })
        await send({ t: 'hend', id: frame.id })
        return
      }
      await reply(frame.id, { result: { read: { text: 'ok' } } })
    })
  })
})

const result: Record<string, unknown> = {}
try {
  await page.goto(`http://127.0.0.1:${process.env.APP_PORT ?? 5174}`)
  await addDesktop(page, '图集节点', `alma://connect?u=https://relay.invalid&k=${code}&e2e=1`)
  await page.locator('.session-row').first().waitFor({ timeout: 20000 })
  await page.locator('.session-row-hit').first().click()
  await page.locator('.conversation-view').waitFor({ timeout: 20000 })
  await page.waitForTimeout(900)

  // ── the gallery ───────────────────────────────────────────────────────
  result.thumbnails = await page.locator('button.transcript-image').count()
  await page.locator('button.transcript-image').first().click()
  const viewer = page.locator('.image-viewer')
  await viewer.waitFor({ timeout: 8000 })
  result.hintAtFirst = (await page.locator('.image-viewer-hint').innerText()).trim()
  result.prevHiddenAtFirst = await page.locator('.image-viewer-nav.is-prev').count() === 0
  result.nextVisibleAtFirst = await page.locator('.image-viewer-nav.is-next').isVisible()

  // Swipe left: the second picture. Dispatched as a string so no bundler
  // helpers are referenced in the page.
  const box = await viewer.boundingBox()
  if (!box) throw new Error('no viewer box')
  const y = box.y + box.height / 2
  const swipe = async (fromRatio: number, toRatio: number) => {
    await page.evaluate(`(() => {
      const element = document.querySelector('.image-viewer')
      const x1 = ${box.x} + ${box.width} * ${fromRatio}, x2 = ${box.x} + ${box.width} * ${toRatio}, yy = ${y}
      const touch = (x) => new Touch({ identifier: 1, target: element, clientX: x, clientY: yy })
      element.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch(x1)], changedTouches: [touch(x1)] }))
      element.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [], changedTouches: [touch(x2)] }))
    })()`)
    await page.waitForTimeout(400)
  }
  await swipe(0.8, 0.15)
  result.hintAfterSwipe = (await page.locator('.image-viewer-hint').innerText()).trim()
  result.prevVisibleAfterSwipe = await page.locator('.image-viewer-nav.is-prev').isVisible()
  result.viewerStillOpen = await page.locator('.image-viewer').count() === 1

  // Swipe left twice more: the third picture, then the end, where the next
  // arrow has to disappear rather than wrap around.
  await swipe(0.8, 0.15)
  result.hintAtThird = (await page.locator('.image-viewer-hint').innerText()).trim()
  await swipe(0.8, 0.15)
  result.hintPastEnd = (await page.locator('.image-viewer-hint').innerText()).trim()
  result.nextHiddenAtEnd = await page.locator('.image-viewer-nav.is-next').count() === 0
  await page.screenshot({ path: 'test-artifacts/image-gallery.png' })

  // Swipe back the other way, then close.
  await swipe(0.15, 0.8)
  result.hintAfterSwipeBack = (await page.locator('.image-viewer-hint').innerText()).trim()
  await page.locator('.image-viewer-close').click()
  result.viewerClosed = await page.locator('.image-viewer').count() === 0

  // ── a vertical drag puts the picture away ─────────────────────────────
  // Only at fit-to-screen: zoomed in, the same drag is how the user reaches
  // the part of the picture they just enlarged.
  await page.locator('button.transcript-image').first().click()
  await page.locator('.image-viewer').waitFor({ timeout: 8000 })
  const drag = async (fromY: number, toY: number) => {
    const viewerBox = await page.locator('.image-viewer').boundingBox()
    if (!viewerBox) throw new Error('no viewer box')
    const cx = viewerBox.x + viewerBox.width / 2
    await page.evaluate(`(() => {
      const element = document.querySelector('.image-viewer')
      const y1 = ${viewerBox.y} + ${viewerBox.height} * ${fromY}, y2 = ${viewerBox.y} + ${viewerBox.height} * ${toY}, xx = ${cx}
      const touch = (y) => new Touch({ identifier: 1, target: element, clientX: xx, clientY: y })
      element.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch(y1)], changedTouches: [touch(y1)] }))
      element.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [], changedTouches: [touch(y2)] }))
    })()`)
    await page.waitForTimeout(400)
  }
  // Zoom in first: the drag must pan, not dismiss.
  await page.locator('.image-viewer-image').dblclick()
  await page.waitForTimeout(250)
  result.zoomScale = await page.locator('.image-viewer-image').evaluate((node) => {
    const match = /scale\(([\d.]+)\)/.exec((node as HTMLElement).style.transform)
    return match ? Number(match[1]) : 1
  })
  await drag(0.45, 0.8)
  result.staysOpenWhileZoomed = await page.locator('.image-viewer').count() === 1
  // Back to fit, then the same gesture closes it.
  await page.locator('.image-viewer-image').dblclick()
  await page.waitForTimeout(250)
  await drag(0.45, 0.85)
  result.closedByVerticalDrag = await page.locator('.image-viewer').count() === 0

  // ── the menu closes on an outside tap ─────────────────────────────────
  const menu = page.locator('.view-maintenance')
  const isOpen = () => menu.evaluate((node) => (node as HTMLDetailsElement).open)
  await menu.locator('summary').click()
  result.menuOpens = await isOpen()
  // A tap on the transcript, nowhere near the menu.
  await page.locator('.transcript-scroll').click({ position: { x: 30, y: 240 } })
  await page.waitForTimeout(200)
  result.menuClosedByOutsideTap = !(await isOpen())

  // Choosing an item keeps the menu open: it holds several related actions.
  await menu.locator('summary').click()
  await page.getByRole('button', { name: '静音这个会话' }).click()
  await page.waitForTimeout(300)
  await menu.locator('summary').click()
  result.menuCollapsesOnSummary = !(await isOpen())

  const failures: string[] = []
  const must = (key: string, wanted: unknown) => {
    if (result[key] !== wanted) failures.push(`${key}: want ${JSON.stringify(wanted)}, got ${JSON.stringify(result[key])}`)
  }
  must('thumbnails', 3)
  must('hintAtFirst', '1/3 · 左右滑动切换，上下滑动关闭')
  must('prevHiddenAtFirst', true)
  must('nextVisibleAtFirst', true)
  must('hintAfterSwipe', '2/3 · 左右滑动切换，上下滑动关闭')
  must('prevVisibleAfterSwipe', true)
  must('viewerStillOpen', true)
  must('hintAtThird', '3/3 · 左右滑动切换，上下滑动关闭')
  must('hintPastEnd', '3/3 · 左右滑动切换，上下滑动关闭')
  must('nextHiddenAtEnd', true)
  must('hintAfterSwipeBack', '2/3 · 左右滑动切换，上下滑动关闭')
  must('viewerClosed', true)
  // 2.5x is the double-tap zoom; anything above 1 proves the drag had a zoom to
  // pan rather than being read as a dismissal.
  must('zoomScale', 2.5)
  must('staysOpenWhileZoomed', true)
  must('closedByVerticalDrag', true)
  must('menuOpens', true)
  must('menuClosedByOutsideTap', true)
  must('menuCollapsesOnSummary', true)
  if (errors.length) failures.push(`page errors: ${errors.join('; ')}`)
  console.log(JSON.stringify({ result, failures }, null, 1))
  if (failures.length) throw new Error(failures.join('\n'))
} finally {
  await browser.close()
}
