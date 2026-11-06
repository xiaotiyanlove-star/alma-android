import { launchBrowser } from './browser.ts'
import { addDesktop } from './helpers.ts'
import { base64url } from '../client/crypto.ts'

const link = (n: number) => `alma://connect?u=https://relay.invalid&k=${base64url(new Uint8Array(32).fill(n))}&e2e=1`

const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
// The labels below are the Chinese source strings; pin the language rather
// than depending on the machine's locale.
await context.addInitScript({ content: `try { localStorage.setItem('herdr.prefs.locale', 'zh-CN') } catch (error) {}` })
const page = await context.newPage()
const errors: string[] = []
page.on('pageerror', (error: Error) => errors.push(error.message))
await page.goto(`http://127.0.0.1:${process.env.APP_PORT ?? 5174}`)

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

const selectRows = await page.locator('.select-row').count()
const selectGeometry = await page.locator('.select-row select').evaluateAll((selects) => selects.map((select) => {
  const box = select.getBoundingClientRect()
  const style = getComputedStyle(select)
  return { width: box.width, height: box.height, paddingRight: parseFloat(style.paddingRight), paddingLeft: parseFloat(style.paddingLeft), visual: style.appearance }
}))
console.log(JSON.stringify({
  groups,
  selectRows,
  selectGeometry,
  about: about.split('\n').join(' | '),
  mentionsYetone: thanks.includes('yetone'),
  mentionsAuthor: about.includes('xiaotiyan'),
  pageErrors: errors,
}))
await browser.close()
