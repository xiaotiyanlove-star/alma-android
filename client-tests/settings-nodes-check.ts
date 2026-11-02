import { chromium } from '@playwright/test'
import { addDesktop } from './helpers.ts'
import { base64url } from '../client/crypto.ts'

const link = (n: number) => `alma://connect?u=https://relay.invalid&k=${base64url(new Uint8Array(32).fill(n))}&e2e=1`
const names = ['工作电脑', '家里 Mac', '笔记本', '测试机', '备用机', '第六台', '第七台']

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
await context.addInitScript(() => { try { localStorage.setItem('herdr.prefs.locale', 'zh-CN') } catch {} })
const page = await context.newPage()
const errors: string[] = []
page.on('pageerror', (error: Error) => errors.push(error.message))
await page.goto(`http://127.0.0.1:${process.env.APP_PORT ?? 5174}`)

// Add seven desktops to cross the collapse threshold.
for (const [index, name] of names.entries()) {
  if (index) {
    // Whether we land on settings or the session list depends on how many
    // desktops exist; normalise by looking for the settings entry point.
    if (await page.getByRole('button', { name: '节点设置' }).isVisible().catch(() => false)) {
      await page.getByRole('button', { name: '节点设置' }).click()
    }
  }
  await addDesktop(page, name, link(index + 20))
}

if (await page.getByRole('button', { name: '节点设置' }).isVisible().catch(() => false)) {
  await page.getByRole('button', { name: '节点设置' }).click()
}
await page.waitForTimeout(300)

const collapsedCount = await page.locator('.host-row').count()
const toggle = page.locator('.host-toggle')
const toggleLabel = (await toggle.textContent())?.trim()
await page.screenshot({ path: 'test-artifacts/nodes-collapsed.png' })

await toggle.click()
await page.waitForTimeout(250)
const expandedCount = await page.locator('.host-row').count()
const collapseLabel = (await page.locator('.host-toggle').textContent())?.trim()
await page.screenshot({ path: 'test-artifacts/nodes-expanded.png' })

// Rename the first desktop.
await page.getByRole('button', { name: /重命名 工作电脑/ }).click()
await page.getByRole('dialog', { name: '重命名节点' }).waitFor()
await page.locator('#rename-input').fill('办公室 Mac')
await page.getByRole('button', { name: '保存' }).click()
await page.waitForTimeout(300)
const renamed = await page.locator('.host-open strong').first().textContent()
await page.screenshot({ path: 'test-artifacts/nodes-renamed.png' })

console.log(JSON.stringify({ collapsedCount, expandedCount, toggleLabel, collapseLabel, renamed, pageErrors: errors }))
await browser.close()
