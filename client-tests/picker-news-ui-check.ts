/**
 * What is waiting on each desktop, on the "choose a desktop" sheet.
 *
 * The session list already marks a row that needs the user; this screen asks
 * the question one step earlier — which machine should be opened — and the two
 * kinds of news here lead to different next steps. An agent blocked on an
 * answer is something to act on; a turn that finished while the user was away
 * is something to read. Both are counted, side by side, and neither is a dot.
 */
import { launchBrowser } from './browser.ts'
import { addDesktop, goHome } from './helpers.ts'
import { base64url, createKeyPair, deriveSessionKeys, fromBase64url, openFrame, sealFrame } from '../client/crypto.ts'

const CODE_A = base64url(new Uint8Array(32).fill(81))
const CODE_B = base64url(new Uint8Array(32).fill(82))
const link = (relay: string, code: string) => `alma://connect?u=${encodeURIComponent(`https://${relay}`)}&k=${code}&e2e=1`

const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
await context.addInitScript(() => { try { localStorage.setItem('herdr.prefs.locale', 'zh-CN') } catch {} })
const page = await context.newPage()
const errors: string[] = []
page.on('pageerror', (error: Error) => errors.push(error.message))

/** A synthetic desktop: HTTP plus the snapshot the picker reads. */
async function desktop(relayHost: string, code: string, snapshot: () => unknown) {
  await page.routeWebSocket(`wss://${relayHost}/**`, (socket) => {
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
          const hello = JSON.parse(data)
          if (hello.t === 'ok') return
          const pair = await createKeyPair()
          const nonce = crypto.getRandomValues(new Uint8Array(16))
          keys = await deriveSessionKeys({ connectCode: code, myPrivateKey: pair.privateKey, peerPublic: fromBase64url(hello.epk), initiatorPublic: fromBase64url(hello.epk), responderPublic: pair.publicKey, initiatorNonce: fromBase64url(hello.n), responderNonce: nonce })
          socket.send(JSON.stringify({ t: 'hi', epk: base64url(pair.publicKey), n: base64url(nonce), cr: base64url(keys.confirmResponder) }))
          return
        }
        const frame = await openFrame(keys.c2s, new Uint8Array(data as unknown as ArrayBuffer)) as Record<string, any>
        if (frame.t === 'wopen') {
          await send({ t: 'wopened', id: frame.id })
          if (frame.path === '/ws/herdr') await send({ t: 'wmsg', id: frame.id, s: JSON.stringify(snapshot()) })
          return
        }
        if (frame.t !== 'hreq') return
        if (frame.path === '/api/herdr/info') return reply(frame.id, { online: true })
        if (frame.path === '/api/herdr/mutes') return reply(frame.id, { workspaces: [], tabs: [] })
        if (frame.path === '/__alma_lan__') return reply(frame.id, null)
        if (frame.path.startsWith('/api/herdr/chat')) return reply(frame.id, { session_id: 's', page: { start: 0, end: 0, items: [] } })
        if (frame.path.startsWith('/api/herdr/rpc')) return reply(frame.id, { result: {} })
        await reply(frame.id, { result: { read: { text: '' } } })
      })
    })
  })
}

await desktop('relay-a.invalid', CODE_A, () => ({ type: 'snapshot', snapshot: {
  workspaces: [{ workspace_id: 'w1', label: '工作', cwd: '/work/a' }],
  tabs: [{ tab_id: 't1', workspace_id: 'w1', label: '主会话' }],
  panes: [
    { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 't1', agent: 'claude', agent_status: 'blocked', cwd: '/work/a' },
    { pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 't1', agent: 'codex', agent_status: 'done', cwd: '/work/a' },
  ],
} }))
await desktop('relay-b.invalid', CODE_B, () => ({ type: 'snapshot', snapshot: {
  workspaces: [{ workspace_id: 'w2', label: '备用', cwd: '/work/b' }],
  tabs: [{ tab_id: 't2', workspace_id: 'w2', label: '空闲' }],
  panes: [{ pane_id: 'w2:p1', workspace_id: 'w2', tab_id: 't2', agent: 'codex', agent_status: 'idle', cwd: '/work/b' }],
} }))

await page.goto(`http://127.0.0.1:${process.env.APP_PORT ?? 5174}`)
await page.waitForTimeout(1_200)
await addDesktop(page, '工作电脑', link('relay-a.invalid', CODE_A))
await page.waitForTimeout(1_000)
// Adding the second goes through settings, which is where the add entry lives
// once a desktop exists.
if (await page.getByRole('button', { name: '节点设置' }).isVisible().catch(() => false)) {
  await page.getByRole('button', { name: '节点设置' }).click()
  await page.waitForTimeout(200)
}
await addDesktop(page, '备用电脑', link('relay-b.invalid', CODE_B))
await page.waitForTimeout(1_000)

await goHome(page)
await page.waitForTimeout(400)
await page.getByRole('button', { name: '当前节点' }).click()
const sheet = page.getByRole('dialog', { name: '选择桌面' })
await sheet.waitFor()

const rows = await sheet.locator('.sheet-option').evaluateAll((options) => options.map((option) => ({
  name: option.querySelector('strong')?.textContent ?? '',
  tags: [...option.querySelectorAll('.news-tag')].map((tag) => tag.textContent ?? ''),
  waiting: option.querySelectorAll('.news-tag.is-waiting').length,
  done: option.querySelectorAll('.news-tag.is-done').length,
})))
const workingRow = rows.find((row) => row.name === '工作电脑')
if (!workingRow) throw new Error(`missing row: ${JSON.stringify(rows)}`)
if (workingRow.waiting !== 1 || workingRow.done !== 1) throw new Error(`counters wrong: ${JSON.stringify(workingRow)}`)
if (!workingRow.tags.some((tag) => tag.includes('等待你处理'))) throw new Error(`no waiting label: ${JSON.stringify(workingRow.tags)}`)
if (!workingRow.tags.some((tag) => tag.includes('新结果'))) throw new Error(`no result label: ${JSON.stringify(workingRow.tags)}`)
const quietRow = rows.find((row) => row.name === '备用电脑')
if (!quietRow || quietRow.tags.length) throw new Error(`a quiet desktop must show nothing: ${JSON.stringify(quietRow)}`)
await page.screenshot({ path: 'test-artifacts/picker-news-zh.png' })

// The English copy is asserted by the unit suite (`i18n.test.ts`), because the
// browser preview keeps desktops in memory only: a reload to switch language
// would lose the pairings this check just made.
await browser.close()
console.log(JSON.stringify({ rows, pageErrors: errors }))
