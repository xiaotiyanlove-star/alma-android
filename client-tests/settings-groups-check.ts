import { chromium } from '@playwright/test'
import { addDesktop } from './helpers.ts'
import { base64url } from '../client/crypto.ts'

const link = (n: number) => `alma://connect?u=https://relay.invalid&k=${base64url(new Uint8Array(32).fill(n))}&e2e=1`

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
const page = await context.newPage()
const errors: string[] = []
page.on('pageerror', (error: Error) => errors.push(error.message))
await page.goto('http://127.0.0.1:5174')

// Two pairings, chosen deliberately so the "no auto-pick" path is exercised.
for (const [index, name] of ['工作电脑', '家里 Mac'].entries()) {
  if (index) await page.getByRole('button', { name: '节点设置' }).click()
  await addDesktop(page, name, link(index + 11))
  if (await page.getByRole('button', { name: '返回会话', exact: true }).isVisible().catch(() => false)) {
    await page.getByRole('button', { name: '返回会话', exact: true }).click()
  }
}

// Node-selection semantics are covered by host-selection.test.ts; the browser
// preview keeps hosts in memory, so a reload cannot be used to test restore.
// Settings is grouped and carries the About block.
await page.getByRole('button', { name: '节点设置' }).click()
await page.waitForTimeout(300)
const groups = await page.locator('.group-title').allTextContents()
const about = await page.locator('.about-list').first().innerText()
const thanks = await page.locator('.about-thanks').innerText()
await page.screenshot({ path: 'test-artifacts/settings-grouped.png', fullPage: true })

console.log(JSON.stringify({
  groups,
  about: about.split('\n').join(' | '),
  mentionsYetone: thanks.includes('yetone'),
  mentionsAuthor: about.includes('xiaotiyan'),
  pageErrors: errors,
}))
await browser.close()
