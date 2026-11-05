/**
 * A diagram follows the app's light/dark choice.
 *
 * Mermaid caches its palette inside the renderer, so changing only the page CSS
 * left a dark diagram on a light card until the app restarted. This drives the
 * real Markdown path and checks the delivered SVG colours after a live switch.
 */
import { chromium } from '@playwright/test'
import { addDesktop } from './helpers.ts'
import { base64url, createKeyPair, deriveSessionKeys, fromBase64url, openFrame, sealFrame } from '../client/crypto.ts'

const code = base64url(new Uint8Array(32).fill(74))
const DIAGRAM = ['flowchart LR', '  A["开始"] --> B["完成"]'].join('\n')
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
        else if (frame.path.startsWith('/api/herdr/chat')) await reply(frame.id, { session_id: 's1', page: { start: 0, end: 1, items: [{ id: 'm1', kind: 'assistant', text: `\`\`\`mermaid\n${DIAGRAM}\n\`\`\`` }] } })
        else if (frame.path === '/__alma_lan__') await reply(frame.id, null)
        else await reply(frame.id, { result: { read: { text: '' } } })
      }
      if (frame.t === 'wopen') {
        await send({ t: 'wopened', id: frame.id })
        if (frame.path === '/ws/herdr') await send({ t: 'wmsg', id: frame.id, s: JSON.stringify({ type: 'snapshot', snapshot: {
          workspaces: [{ workspace_id: 'w1', label: 'demo', cwd: '/p' }],
          panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 't1', agent: 'claude', agent_status: 'idle', cwd: '/p' }],
        } }) })
        if (frame.path.startsWith('/ws/herdr/screen')) await send({ t: 'wmsg', id: frame.id, s: JSON.stringify({ type: 'screen', read: { text: '' } }) })
      }
    })
  })
})

try {
  await page.goto(`http://127.0.0.1:${process.env.APP_PORT ?? 5174}`)
  await addDesktop(page, '测试节点', `alma://connect?u=https://relay.invalid&k=${code}&e2e=1`)
  await page.locator('.session-row-hit').first().click()
  await page.locator('.mermaid-diagram svg').waitFor({ timeout: 30000 })

  const darkBackground = await page.locator('.mermaid-diagram svg').evaluate((svg) => {
    const shape = svg.querySelector('.node rect, .node polygon, .node path, .actor')
    return shape ? getComputedStyle(shape).fill : ''
  })
  await page.evaluate(() => {
    localStorage.setItem('herdr.prefs.theme', 'light')
    document.documentElement.dataset.theme = 'light'
  })
  await page.waitForFunction((dark) => {
    const shape = document.querySelector('.mermaid-diagram svg .node rect, .mermaid-diagram svg .node polygon, .mermaid-diagram svg .node path')
    return Boolean(shape && getComputedStyle(shape).fill !== dark)
  }, darkBackground, { timeout: 30000 }).catch(() => undefined)
  const lightBackground = await page.locator('.mermaid-diagram svg').evaluate((svg) => {
    const shape = svg.querySelector('.node rect, .node polygon, .node path, .actor')
    return shape ? getComputedStyle(shape).fill : ''
  })
  const contrastChanged = Boolean(darkBackground && lightBackground && darkBackground !== lightBackground)
  if (!contrastChanged || errors.length) {
    console.error(JSON.stringify({ darkBackground, lightBackground, errors }))
    process.exitCode = 1
  } else console.log(JSON.stringify({ darkBackground, lightBackground }))
} finally {
  await browser.close()
}
