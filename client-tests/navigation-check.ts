import { chromium } from '@playwright/test'
import { addDesktop } from './helpers.ts'
import { base64url } from '../client/crypto.ts'

const link = (n: number) => `alma://connect?u=https://relay.invalid&k=${base64url(new Uint8Array(32).fill(n))}&e2e=1`

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
await context.addInitScript(() => { try { localStorage.setItem('herdr.prefs.locale', 'zh-CN') } catch {} })
const page = await context.newPage()
const errors: string[] = []
page.on('pageerror', (error: Error) => errors.push(error.message))

// Count how often the page asked the shell to exit.
await page.addInitScript(() => {
  ;(window as any).__exitCount = 0
  ;(window as any).__herdrExitApp = () => { (window as any).__exitCount++ }
})

await page.goto(`http://127.0.0.1:${process.env.APP_PORT ?? 5174}`)
await page.waitForTimeout(600)
await addDesktop(page, '节点一', link(41))
await page.waitForTimeout(400)

const back = () => page.evaluate(() => (window as any).__almaAndroidBack())
const routeName = () => page.evaluate(() => document.querySelector('.settings-view') ? 'settings' : document.querySelector('.conversation-view') ? 'session' : 'sessions')

// 1. From settings, Back must return to the list and NOT exit.
await page.getByRole('button', { name: '节点设置' }).click()
await page.waitForTimeout(200)
const onSettings = await routeName()
const backFromSettings = await back()
await page.waitForTimeout(250)
const afterSettingsBack = await routeName()
const exitsAfterSettings = await page.evaluate(() => (window as any).__exitCount)

// 2. Overlay first: the forget dialog closes on the first Back.
await page.getByRole('button', { name: '节点设置' }).click()
await page.waitForTimeout(200)
await page.getByRole('button', { name: /忘记 节点一/ }).click()
await page.waitForTimeout(200)
const dialogOpen = await page.getByRole('dialog', { name: '忘记此节点？' }).isVisible()
await back()
await page.waitForTimeout(250)
const dialogClosed = !(await page.getByRole('dialog', { name: '忘记此节点？' }).isVisible().catch(() => false))
const stillSettings = await routeName()

// 3. Back out of settings to the list, then one more Back may exit.
await back()
await page.waitForTimeout(200)
const atHome = await routeName()
const exitAtHome = await page.evaluate(() => { (window as any).__almaAndroidBack(); return (window as any).__exitCount })

console.log(JSON.stringify({
  onSettings, backFromSettings, afterSettingsBack, exitsAfterSettings,
  dialogOpen, dialogClosed, stillSettings,
  atHome, exitAtHome, pageErrors: errors,
}))
await browser.close()
