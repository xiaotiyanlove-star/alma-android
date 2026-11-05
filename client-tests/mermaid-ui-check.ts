/**
 * Mermaid fences are drawn, not printed.
 *
 * The interesting cases are the ones that used to fail silently: a fence with
 * the language name, one without it, and a diagram whose source is broken. A
 * broken diagram has to stay readable — showing the source and the reason —
 * rather than turning into an empty box or a crash.
 */
import { chromium } from '@playwright/test'
import { addDesktop } from './helpers.ts'
import { base64url, createKeyPair, deriveSessionKeys, fromBase64url, openFrame, sealFrame } from '../client/crypto.ts'

const code = base64url(new Uint8Array(32).fill(73))
const DIAGRAM = ['flowchart TD', '  A["手机无法访问桌面"] --> B{"Relay 在线?"}', '  B -->|否| C["检查容器与证书"]', '  B -->|是| D["检查配对"]'].join('\n')
const UNTAGGED = ['graph LR', '  X --> Y'].join('\n')
const BROKEN = ['flowchart TD', '  A[[[ --> ]['].join('\n')

const REPLY = [
  '## 排查流程',
  '',
  '```mermaid',
  DIAGRAM,
  '```',
  '',
  '不带语言名的：',
  '',
  '```',
  UNTAGGED,
  '```',
  '',
  '画不出来的：',
  '',
  '```mermaid',
  BROKEN,
  '```',
].join('\n')

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', colorScheme: 'dark' })
await context.addInitScript({ content: `try { localStorage.setItem('herdr.prefs.locale','zh-CN'); localStorage.setItem('herdr.prefs.theme','dark') } catch (e) {}` })
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
        else if (frame.path.startsWith('/api/herdr/chat')) await reply(frame.id, { session_id: 's1', page: { start: 0, end: 1, items: [
          { id: 'm1', kind: 'assistant', text: REPLY, time: '2026-11-02T10:00:00Z' },
        ] } })
        else await reply(frame.id, { result: { read: { text: '' } } })
      }
      if (frame.t === 'wopen') {
        await send({ t: 'wopened', id: frame.id })
        if (frame.path === '/ws/herdr') await send({ t: 'wmsg', id: frame.id, s: JSON.stringify({ type: 'snapshot', snapshot: {
          workspaces: [{ workspace_id: 'w1', label: 'demo', cwd: '/p' }],
          tabs: [{ tab_id: 't1', workspace_id: 'w1', label: '图表' }],
          panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 't1', agent: 'claude', agent_status: 'idle', cwd: '/p' }],
        } }) })
        if (frame.path.startsWith('/ws/herdr/screen')) await send({ t: 'wmsg', id: frame.id, s: JSON.stringify({ type: 'screen', read: { text: '' } }) })
      }
    })
  })
})

const result: Record<string, unknown> = {}
try {
  await page.goto(`http://127.0.0.1:${process.env.APP_PORT ?? 5174}`)
  await addDesktop(page, '测试节点', `alma://connect?u=https://relay.invalid&k=${code}&e2e=1`)
  await page.locator('.session-row-hit').first().click()
  await page.locator('.markdown-body').first().waitFor({ timeout: 20000 })

  // Two diagrams, the second one untagged.
  await page.locator('.mermaid-diagram svg').first().waitFor({ timeout: 30000 })
  await page.waitForFunction(() => document.querySelectorAll('.mermaid-diagram svg').length >= 2, undefined, { timeout: 30000 })
  result.drawnCount = await page.locator('.mermaid-diagram svg').count()
  result.untaggedDrawn = result.drawnCount === 2
  // A drawn diagram is not a code card; the broken one falls back to a figure,
  // not to a language bar with a copy button.
  result.codeCards = await page.locator('.md-code').count()
  result.failedCount = await page.locator('.mermaid-figure.is-failed').count()
  result.failedShowsSource = (await page.locator('.mermaid-figure.is-failed pre').first().innerText().catch(() => '')).includes('flowchart TD')

  await page.screenshot({ path: 'test-artifacts/mermaid.png', fullPage: true })

  // The diagram must fit the column: a wide graph may not widen the page.
  const fits = await page.evaluate(`(() => {
    const svg = document.querySelector('.mermaid-diagram svg')
    const column = document.querySelector('.markdown-body')
    if (!svg || !column) return false
    return svg.getBoundingClientRect().width <= column.getBoundingClientRect().width + 1
  })()`)
  result.diagramFitsColumn = fits
  // A diagram loading into an empty 90px placeholder used to move the reader.
  // Its reserved ratio must already account for the final diagram.
  result.noJumpAfterRender = await page.evaluate(`(() => {
    const figure = document.querySelector('.mermaid-figure')
    const diagram = figure?.querySelector('.mermaid-diagram svg')
    if (!figure || !diagram) return false
    return figure.querySelector('.mermaid-placeholder') === null
      && Math.abs(figure.getBoundingClientRect().height - diagram.getBoundingClientRect().height) < 60
  })()`)

  const failures: string[] = []
  if (result.drawnCount !== 2) failures.push(`drawnCount: ${result.drawnCount}`)
  if (result.codeCards !== 0) failures.push(`codeCards: ${result.codeCards}`)
  if (result.failedCount !== 1) failures.push(`failedCount: ${result.failedCount}`)
  for (const key of ['untaggedDrawn', 'failedShowsSource', 'diagramFitsColumn', 'noJumpAfterRender']) {
    if (result[key] !== true) failures.push(`${key}: ${result[key]}`)
  }
  failures.push(...errors.map((error) => `pageError: ${error}`))
  if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1 }
  else console.log(JSON.stringify({ ...result, pageErrors: errors }))
} finally {
  await browser.close()
}
