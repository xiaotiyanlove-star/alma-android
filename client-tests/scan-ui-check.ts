import { chromium } from '@playwright/test'
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
// Simulate the "camera denied" path so the UI fallback is what gets verified.
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: () => Promise.reject(Object.assign(new DOMException('denied', 'NotAllowedError'))) },
    configurable: true,
  })
})
const page = await context.newPage()
const errors: string[] = []
page.on('pageerror', (e) => errors.push(e.message))
await page.goto(`http://127.0.0.1:${process.env.APP_PORT ?? 5174}`)
await page.getByLabel('节点名称', { exact: true }).fill('扫码测试')
await page.getByRole('button', { name: '扫码' }).click()
await page.getByRole('dialog', { name: '扫描二维码' }).waitFor()
await page.screenshot({ path: 'test-artifacts/scan-sheet.png' })
const denied = await page.getByText(/相机权限被拒绝/).isVisible().catch(() => false)
const hint = await page.getByText(/把 Alma「远程访问」里的二维码/).isVisible()
await page.getByRole('button', { name: '关闭扫描' }).click()
const closed = await page.getByRole('dialog', { name: '扫描二维码' }).isVisible().catch(() => false)
// Paste still works after scanning is cancelled.
await page.getByLabel('配对链接', { exact: true }).fill('alma://connect?u=https%3A%2F%2Frelay.invalid&k=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&e2e=1')
const enabled = await page.getByRole('button', { name: '添加节点', exact: true }).last().isEnabled()
console.log(JSON.stringify({ deniedShown: denied, hint, closed, pasteStillWorks: enabled, pageErrors: errors }))
await browser.close()
