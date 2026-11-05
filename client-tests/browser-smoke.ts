import { chromium, expect } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { addDesktop } from './helpers.ts'
import { base64url, createKeyPair, deriveSessionKeys, fromBase64url, openFrame, routingId, sealFrame } from '../client/crypto.ts'
const codes = [base64url(new Uint8Array(32).fill(2)), base64url(new Uint8Array(32).fill(3))]
const names = ['工作电脑 · 中文长名称与会话测试', '家用电脑']
const ids = await Promise.all(codes.map(routingId))
const messages = ['测试历史：中文长路径 /Users/example/Projects/a-very-long-project-name-without-spaces-and-with-code，用于检查窄屏换行。\n```ts\nconst example = "long-code-line-without-wrapping";\n```', '来自第二台电脑的会话内容']
const calls: { host: number; method: string; params: any }[] = []
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, locale: 'zh-CN' })
await context.addInitScript(() => { try { localStorage.setItem('herdr.prefs.locale', 'zh-CN') } catch {} })
const page = await context.newPage()
const errors: string[] = []
page.on('pageerror', (error) => errors.push(error.message))
await page.routeWebSocket('wss://relay.invalid/**', (socket) => {
  const host = ids.findIndex((id) => socket.url().includes(id))
  let keys: Awaited<ReturnType<typeof deriveSessionKeys>>, counter = 0n, chain = Promise.resolve(), chatId = ''
  const send = async (frame: any) => socket.send(Buffer.from(await sealFrame(keys.s2c, counter++, frame)))
  const jsonResponse = async (id: string, body: unknown) => {
    await send({ t: 'hres', id, status: 200, headers: {} }); await send({ t: 'hchunk', id, b: base64url(new TextEncoder().encode(JSON.stringify(body))) }); await send({ t: 'hend', id })
  }
  socket.onMessage((data) => {
    chain = chain.then(async () => {
      if (typeof data === 'string') {
        const hello = JSON.parse(data)
        if (hello.t === 'ok') return
        const pair = await createKeyPair(), nonce = crypto.getRandomValues(new Uint8Array(16))
        keys = await deriveSessionKeys({ connectCode: codes[host], myPrivateKey: pair.privateKey, peerPublic: fromBase64url(hello.epk), initiatorPublic: fromBase64url(hello.epk), responderPublic: pair.publicKey, initiatorNonce: fromBase64url(hello.n), responderNonce: nonce })
        socket.send(JSON.stringify({ t: 'hi', epk: base64url(pair.publicKey), n: base64url(nonce), cr: base64url(keys.confirmResponder) })); return
      }
      const frame = await openFrame(keys.c2s, new Uint8Array(data)) as any
      if (frame.t === 'hreq') {
        if (frame.path === '/api/herdr/info') await jsonResponse(frame.id, { online: true })
        else if (frame.path.startsWith('/api/herdr/chat')) await jsonResponse(frame.id, { session_id: `s${host}`, page: { start: 0, end: 10, items: [{ id: 'm1', kind: 'assistant', text: messages[host] }] } })
        else if (frame.path === '/api/herdr/mutes') await jsonResponse(frame.id, { workspaces: [], tabs: [] })
        else if (frame.path === '/__alma_lan__') await jsonResponse(frame.id, null)
        else {
          // The mute list is a bodyless GET, so a request with no body is not
          // an RPC; decoding `frame.b` unconditionally used to throw here.
          const rpc = frame.b ? JSON.parse(new TextDecoder().decode(fromBase64url(frame.b))) : {}
          calls.push({ host, ...rpc })
          await jsonResponse(frame.id, { result: rpc.method === 'pane.read' ? { read: { text: 'Run synthetic command?\n  1. Yes, once\n  2. No, cancel' } } : { ok: true } })
          if (rpc.method === 'agent.prompt' && chatId) await send({ t: 'wmsg', id: chatId, s: JSON.stringify({ type: 'items', items: [{ id: 'reply', kind: 'assistant', text: '已收到合成测试消息' }], end: 20 }) })
        }
      }
      if (frame.t === 'wopen') {
        await send({ t: 'wopened', id: frame.id })
        if (frame.path === '/ws/herdr') await send({ t: 'wmsg', id: frame.id, s: JSON.stringify({ type: 'snapshot', snapshot: { workspaces: [{ workspace_id: 'w1', label: '项目工作区' }], panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 't1', agent: 'claude', agent_status: 'idle', terminal_title_stripped: host ? '第二节点会话' : '中文长会话标题与真实链路合成验证', agent_session: { value: `s${host}` } }] } }) })
        else if (frame.path.startsWith('/ws/herdr/chat')) chatId = frame.id
        else if (frame.path.startsWith('/ws/herdr/screen')) await send({ t: 'wmsg', id: frame.id, s: JSON.stringify({ type: 'screen', read: { text: 'Synthetic terminal\n> waiting for input' } }) })
      }
    })
  })
})
const screenshots = '/private/tmp/alma-android-dev/test-artifacts'
await mkdir(screenshots, { recursive: true })
try {
  await page.goto(`http://127.0.0.1:${process.env.APP_PORT ?? 5174}`)
  await expect(page.getByText('尚未添加节点').first()).toBeVisible()
  await page.screenshot({ path: `${screenshots}/nodes-empty.png` })
  for (let index = 0; index < 2; index++) {
    if (index) await page.getByRole('button', { name: '节点设置' }).click()
    await addDesktop(page, names[index], `alma://connect?u=https://relay.invalid&k=${codes[index]}&e2e=1`)
    // Saving returns to settings; go back to the list to check the current node.
    if (await page.getByRole('button', { name: '返回会话', exact: true }).isVisible().catch(() => false)) {
      await page.getByRole('button', { name: '返回会话', exact: true }).click()
    }
    await expect(page.getByRole('button', { name: '当前节点' })).toContainText(names[index])
  }
  await page.getByRole('button', { name: '当前节点' }).click()
  await page.getByRole('dialog', { name: '选择节点' }).getByRole('button', { name: new RegExp(names[0]) }).click()
  await page.locator('.session-row-hit').first().click()
  await expect(page.getByText(/测试历史：中文长路径/)).toBeVisible()
  await page.screenshot({ path: `${screenshots}/chat-phone.png` })
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('合成消息')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByText('已收到合成测试消息')).toBeVisible()
  await page.getByRole('tab', { name: '终端', exact: true }).click()
  await page.getByRole('button', { name: '发送向上键' }).click()
  await expect.poll(() => calls.some((call) => call.method === 'pane.send_keys' && call.params.keys[0] === 'up')).toBe(true)
  await page.getByLabel('终端输入', { exact: true }).fill('echo synthetic')
  await page.getByRole('button', { name: '发送并回车', exact: true }).click()
  await expect.poll(() => calls.some((call) => call.method === 'pane.send_text' && call.params.text.includes('echo synthetic'))).toBe(true)
  await expect(page.getByRole('textbox', { name: '终端输入', exact: true })).toHaveValue('')
  await page.screenshot({ path: `${screenshots}/terminal-phone.png` })
  for (const viewport of [{ width: 320, height: 640 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport)
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await expect.poll(() => page.getByRole('textbox', { name: '终端输入', exact: true }).evaluate((el) => el.getBoundingClientRect().bottom <= window.innerHeight)).toBe(true)
  }
  await page.screenshot({ path: `${screenshots}/terminal-desktop.png` })
  expect(errors).toEqual([])
  console.log(JSON.stringify({ screenshots, pageErrors: errors, rpcCount: calls.length, messageHost: calls.find((x) => x.method === 'agent.prompt')?.host }))
} finally { await browser.close() }
