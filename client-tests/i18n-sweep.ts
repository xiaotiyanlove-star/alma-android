import { chromium } from '@playwright/test'
import { addDesktop } from './helpers.ts'
import { base64url } from '../client/crypto.ts'
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const c = await b.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US' })
await c.addInitScript(() => {
  try {
    localStorage.setItem('herdr.prefs.locale', 'en')
    localStorage.setItem('herdr.lastHost', '')
  } catch {}
})
const p = await c.newPage()
await p.goto('http://127.0.0.1:5174')
await p.waitForTimeout(700)
// Add a desktop so the settings and session screens fully render.
await p.getByRole('button', { name: /Add desktop|添加节点/ }).first().click()
await p.getByLabel(/Desktop name|节点名称/).fill('Node A')
await p.getByLabel(/Pairing link|配对链接/).fill(`alma://connect?u=https://relay.invalid&k=${base64url(new Uint8Array(32).fill(77))}&e2e=1`)
await p.getByRole('button', { name: /Add desktop|添加节点/ }).last().click()
await p.waitForTimeout(800)
// Settings screen
await p.getByRole('button', { name: /Settings|节点设置/ }).click()
await p.waitForTimeout(400)
const settingsCjk = await p.evaluate(() => {
  const text = document.body.innerText
  return (text.match(/[一-鿿]+/g) ?? []).slice(0, 12)
})
await p.screenshot({ path: 'test-artifacts/i18n-settings.png', fullPage: true })
await p.getByRole('button', { name: /Back|返回/ }).click()
await p.waitForTimeout(400)
const listCjk = await p.evaluate(() => (document.body.innerText.match(/[一-鿿]+/g) ?? []).slice(0, 12))
await p.screenshot({ path: 'test-artifacts/i18n-sessions.png' })
console.log(JSON.stringify({ settingsCjk, listCjk }))
await b.close()
