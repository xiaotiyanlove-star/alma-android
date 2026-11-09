/**
 * The features borrowed from the official client, driven through the real UI.
 *
 * A synthetic relay answers the routes those features use — `settings` on the
 * chat page, the mute list, `restart-agent`, `subagent`, and an image — so the
 * checks exercise the actual screens rather than the helpers behind them.
 */
import { expect } from '@playwright/test'
import { launchBrowser } from './browser.ts'
import { addDesktop } from './helpers.ts'
import { base64url, createKeyPair, deriveSessionKeys, fromBase64url, openFrame, routingId, sealFrame } from '../client/connection/crypto.ts'
import { screenshotDir } from './artifacts.ts'

const code = base64url(new Uint8Array(32).fill(11))
const [id] = await Promise.all([routingId(code)])
const calls: { method: string; params: any }[] = []
const mutes = { workspaces: [] as string[], tabs: [] as string[] }
let subagentRequested: string | undefined
let imageServed = false
// A 1x1 PNG: enough to prove the bytes travelled and became an <img>.
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])

const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
await context.addInitScript(() => { try { localStorage.setItem('herdr.prefs.locale', 'zh-CN') } catch {} })
const page = await context.newPage()
const errors: string[] = []
page.on('pageerror', (error) => errors.push(error.message))

await page.routeWebSocket('wss://relay.invalid/**', (socket) => {
  const matchesHost = socket.url().includes(id)
  let keys: Awaited<ReturnType<typeof deriveSessionKeys>>, counter = 0n, chain = Promise.resolve(), chatId = ''
  const send = async (frame: any) => socket.send(Buffer.from(await sealFrame(keys.s2c, counter++, frame)))
  const json = async (requestId: string, body: unknown, status = 200) => {
    await send({ t: 'hres', id: requestId, status, headers: {} })
    await send({ t: 'hchunk', id: requestId, b: base64url(new TextEncoder().encode(JSON.stringify(body))) })
    await send({ t: 'hend', id: requestId })
  }
  const bytes = async (requestId: string, body: Uint8Array, contentType: string) => {
    await send({ t: 'hres', id: requestId, status: 200, headers: { 'content-type': contentType } })
    // base64 in the JSON inner-frame form; a binary peer sends bytes and the
    // transport normalises both to the same `Uint8Array`.
    await send({ t: 'hchunk', id: requestId, b: base64url(body) })
    await send({ t: 'hend', id: requestId })
  }
  socket.onMessage((data) => {
    chain = chain.then(async () => {
      if (!matchesHost) return
      if (typeof data === 'string') {
        const hello = JSON.parse(data)
        if (hello.t === 'ok') return
        const pair = await createKeyPair(), nonce = crypto.getRandomValues(new Uint8Array(16))
        keys = await deriveSessionKeys({ connectCode: code, myPrivateKey: pair.privateKey, peerPublic: fromBase64url(hello.epk), initiatorPublic: fromBase64url(hello.epk), responderPublic: pair.publicKey, initiatorNonce: fromBase64url(hello.n), responderNonce: nonce })
        socket.send(JSON.stringify({ t: 'hi', epk: base64url(pair.publicKey), n: base64url(nonce), cr: base64url(keys.confirmResponder) }))
        return
      }
      const frame = await openFrame(keys.c2s, new Uint8Array(data)) as any
      if (frame.t === 'hreq') {
        const path: string = frame.path
        if (path === '/api/herdr/info') return json(frame.id, { online: true })
        if (path.startsWith('/api/herdr/chat')) {
          return json(frame.id, {
            session_id: 's1',
            page: { start: 0, end: 10, items: [
              { id: 'm1', kind: 'assistant', text: '第一条回复' },
              // A user picture and a tool result picture: both paths exist in
              // the desktop's payload and both are fetched through the tunnel.
              // A local absolute path, which is what the desktop actually reports
              // for a file on its own disk: the client has to turn it into
              // `/api/herdr/file?path=` itself.
              { id: 'm2', kind: 'user', text: '看这张图', images: [{ url: '/Users/me/pic.png', mediaType: 'image/png' }] },
              // A dispatch that is still running, which is what the header chip
              // and the subagent sheet key on.
              { id: 'm3', kind: 'tool', tool: { id: 'tool-1', name: 'Agent', background: true, done: false, input: { description: 'Security review of main', subagent_type: 'general-purpose' } } },
              // A finished tool whose screenshot is reported under the
              // official client's `result_images` field.
              { id: 'm4', kind: 'tool', tool: { id: 'tool-2', name: 'Bash', done: true, result_images: [{ url: '/Users/me/shot.png' }] } },
            ] },
            queued: [],
            settings: { model: 'claude-opus-5-5', effort: 'high' },
          })
        }
        if (path.startsWith('/api/herdr/file?')) {
          const file = new URL(path, 'https://relay.invalid').searchParams.get('path') ?? ''
          if (!file.startsWith('/Users/me/')) return json(frame.id, { error: 'unexpected path ' + file })
          imageServed = true
          return bytes(frame.id, PNG, 'image/png')
        }
        // Alma's LAN hint route. This fake desktop has no LAN listener, which is
        // what a desktop without one answers.
        if (path === '/__alma_lan__') return json(frame.id, null)
        if (path === '/api/herdr/mutes') {
          if (frame.method === 'GET') return json(frame.id, mutes)
          // The real Alma route is PUT. Accepting anything here is what let a
          // POST 404 ship behind a green UI test.
          if (frame.method !== 'PUT') return json(frame.id, { error: { code: 'not_found', message: 'Cannot POST /api/herdr/mutes' } }, 404)
          const body = JSON.parse(new TextDecoder().decode(fromBase64url(frame.b)))
          calls.push({ method: 'mutes', params: body })
          if (body.tab) { mutes.tabs = body.muted ? [body.tab] : []; }
          if (body.workspace) { mutes.workspaces = body.muted ? [body.workspace] : [] }
          return json(frame.id, mutes)
        }
        if (path.startsWith('/api/herdr/subagent')) {
          const query = new URL(path, 'https://x').searchParams
          subagentRequested = query.get('tool') ?? undefined
          return json(frame.id, {
            agent: { type: 'general-purpose', description: 'Security review of main', finished: false },
            page: { items: [{ id: 's1', kind: 'assistant', text: '子 agent 的独立记录' }] },
          })
        }
        if (path === '/api/herdr/restart-agent') {
          const body = JSON.parse(new TextDecoder().decode(fromBase64url(frame.b)))
          calls.push({ method: 'restart-agent', params: body })
          return json(frame.id, { result: { session_id: 's2' } })
        }
        if (!frame.b) return json(frame.id, { result: {} })
        const rpc = JSON.parse(new TextDecoder().decode(fromBase64url(frame.b)))
        calls.push({ method: rpc.method, params: rpc.params })
        return json(frame.id, { result: rpc.method === 'pane.read' ? { read: { text: 'terminal' } } : { ok: true } })
      }
      if (frame.t === 'wopen') {
        await send({ t: 'wopened', id: frame.id })
        if (frame.path === '/ws/herdr') {
          await send({ t: 'wmsg', id: frame.id, s: JSON.stringify({ type: 'snapshot', snapshot: {
            workspaces: [{ workspace_id: 'w1', label: '项目工作区' }],
            panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 't1', agent: 'claude', agent_status: 'idle', terminal_title_stripped: '合成会话', agent_session: { value: 's1' } }],
          } }) })
        } else if (frame.path.startsWith('/ws/herdr/chat')) chatId = frame.id
        else if (frame.path.startsWith('/ws/herdr/screen')) await send({ t: 'wmsg', id: frame.id, s: JSON.stringify({ type: 'screen', read: { text: 'Synthetic terminal' } }) })
      }
    })
  })
})

const screenshots = process.env.SHOT_DIR ?? await screenshotDir('parity')
try {
  await page.goto(`http://127.0.0.1:${process.env.APP_PORT ?? 5174}`)
  await addDesktop(page, '工作电脑', `alma://connect?u=https://relay.invalid&k=${code}&e2e=1`)
  if (await page.getByRole('button', { name: '返回会话', exact: true }).isVisible().catch(() => false)) {
    await page.getByRole('button', { name: '返回会话', exact: true }).click()
  }
  await page.locator('.session-row-hit').first().click()

  // ── the model chip comes from the desktop, not the screen ──────────────
  // Model and effort sit under the composer, next to the box you type into.
  await expect(page.locator('.composer-facts').getByText('claude-opus-5-5')).toBeVisible()

  // ── transcript images are fetched through the tunnel ───────────────────
  // A user attachment is reported as a local absolute path, which the client
  // has to turn into the file route itself.
  await expect(page.locator('.transcript-image img').first()).toBeVisible()
  expect(imageServed).toBe(true)
  // A tool result is a result, not process: it stays below the folded work
  // group so a user can see the screenshot without opening the call.
  await expect(page.locator('.work-group + .transcript-images.is-run .transcript-image img')).toHaveCount(1)

  // Maintenance actions are deliberately behind one more menu; the toolbar
  // itself is reserved for choosing a view.
  await expect(page.locator('.view-toolbar')).toContainText('消息')
  const maintenanceSummary = page.locator('.view-maintenance > summary')
  await expect(maintenanceSummary).toBeVisible()
  if (!(await maintenanceSummary.evaluate((node) => (node.parentElement as HTMLDetailsElement | null)?.open))) await maintenanceSummary.click()
  // ── mute round-trips through the desktop ───────────────────────────────
  await page.getByRole('button', { name: '静音这个会话' }).click()
  await expect.poll(() => calls.find((call) => call.method === 'mutes')?.params).toEqual({ tab: 't1', muted: true })
  await expect(page.getByRole('button', { name: '恢复提醒' })).toBeVisible()
  await page.getByRole('button', { name: '恢复提醒' }).click()
  await expect.poll(() => calls.filter((call) => call.method === 'mutes').length).toBe(2)
  await expect(page.getByRole('button', { name: '静音这个会话' })).toBeVisible()

  // ── a subagent's own transcript ────────────────────────────────────────
  await page.getByRole('button', { name: /个 agent 运行中/ }).click()
  await page.getByRole('dialog', { name: '运行中的 agent' }).getByRole('button', { name: '查看' }).first().click()
  await expect(page.getByText('子 agent 的独立记录')).toBeVisible()
  expect(subagentRequested).toBe('tool-1')
  await page.screenshot({ path: `${screenshots}/parity-subagent.png` })
  await page.getByRole('dialog', { name: '子 agent 记录' }).getByRole('button', { name: '关闭' }).click()

  // ── restarting the agent reloads the session it lives in ───────────────
  if (!(await maintenanceSummary.evaluate((node) => (node.parentElement as HTMLDetailsElement | null)?.open))) await maintenanceSummary.click()
  await page.getByRole('button', { name: '重启这个 agent' }).click()
  await expect.poll(() => calls.some((call) => call.method === 'restart-agent' && call.params.pane_id === 'w1:p1')).toBe(true)
  await expect(page.getByText('第一条回复')).toBeVisible()
  await page.screenshot({ path: `${screenshots}/parity-session.png` })

  // A setting change restarts the service; open the maintenance menu again.

  // ── the keep-alive default is the self-limiting one ────────────────────
  await page.getByRole('button', { name: '返回会话' }).click()
  await page.getByRole('button', { name: '节点设置' }).click()
  await expect(page.getByLabel('后台保活')).toHaveValue('reply')
  expect(errors).toEqual([])
  console.log(JSON.stringify({ screenshots, pageErrors: errors, calls: calls.map((call) => call.method) }))
} finally {
  await browser.close()
}
