import { chromium } from '@playwright/test'
import { base64url } from '../client/crypto.ts'
const link = (n: number) => `alma://connect?u=https://relay.invalid&k=${base64url(new Uint8Array(32).fill(n))}&e2e=1`
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })

async function run(locale: 'zh-CN' | 'en') {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale })
  await context.addInitScript((l) => { try { localStorage.setItem('herdr.prefs.locale', l) } catch {} }, locale === 'zh-CN' ? 'zh-CN' : 'en')
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('http://127.0.0.1:5174')
  await page.waitForTimeout(700)
  const out: Record<string, unknown> = { locale }

  // Empty settings offers a button into the dedicated page.
  await page.getByRole('button', { name: /Add desktop|添加节点/ }).first().click()
  await page.getByLabel(/Desktop name|节点名称/).waitFor()
  out.addPageOpened = true
  const addHeader = await page.locator('.page-header h1').textContent()
  out.addHeader = addHeader
  await page.screenshot({ path: `test-artifacts/add-page-${locale}.png` })

  await page.getByLabel(/Desktop name|节点名称/).fill('Node A')
  await page.getByLabel(/Pairing link|配对链接/).fill(link(88))
  await page.getByRole('button', { name: /Add desktop|添加节点/ }).last().click()
  await page.waitForTimeout(700)

  // Status text must be translated.
  const body = await page.locator('body').innerText()
  out.statusSample = locale === 'en'
    ? (body.match(/Connected|Connecting|Offline|Herdr offline/g) ?? []).slice(0, 3)
    : (body.match(/已连接|连接中|未连接/g) ?? []).slice(0, 3)
  out.cjkInEnglish = locale === 'en' ? (body.match(/[一-鿿]+/g) ?? []).slice(0, 6) : []

  // The node picker offers an add entry (needs a second desktop to open).
  await page.getByRole('button', { name: /Settings|节点设置/ }).first().click().catch(() => {})
  await page.waitForTimeout(300)
  out.errors = errors
  await context.close()
  return out
}

const zh = await run('zh-CN')
const en = await run('en')
console.log(JSON.stringify({ zh, en }, null, 1))
await browser.close()
