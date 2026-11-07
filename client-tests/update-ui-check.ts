/**
 * The About sheet's update control: it reads GitHub Releases, says which
 * version is available, and reports a failed hand-off to the installer
 * instead of looking as if the download had started.
 */
import { launchBrowser } from './browser.ts'
import { screenshotDir } from './artifacts.ts'

const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
await context.addInitScript(() => { try { localStorage.setItem('herdr.prefs.locale', 'zh-CN') } catch { /* blocked */ } })
const page = await context.newPage()
const errors: string[] = []
page.on('pageerror', (error: Error) => errors.push(error.message))

const release = {
  tag_name: 'v0.9.9',
  html_url: 'https://github.com/xiaotiyanlove-star/alma-android/releases/tag/v0.9.9',
  published_at: '2026-11-06T00:00:00Z',
  body: 'Synthetic update for the UI check.',
  assets: [
    { name: 'alma-android-v0.9.9.apk', browser_download_url: 'https://github.com/xiaotiyanlove-star/alma-android/releases/download/v0.9.9/alma-android-v0.9.9.apk' },
    { name: 'alma-android-v0.9.9.apk.sha256', browser_download_url: 'https://github.com/xiaotiyanlove-star/alma-android/releases/download/v0.9.9/alma-android-v0.9.9.apk.sha256' },
  ],
}

await page.route('https://api.github.com/repos/xiaotiyanlove-star/alma-android/releases/latest', (route) => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(release),
}))

try {
  await page.goto(`http://127.0.0.1:${process.env.APP_PORT ?? 5174}`)
  await page.getByText('尚未添加节点').first().waitFor({ timeout: 15000 })
  await page.getByRole('heading', { name: '关于' }).waitFor({ timeout: 15000 })
  await page.getByRole('button', { name: '检查更新' }).click()
  await page.getByText('有新版本 0.9.9').waitFor({ timeout: 10000 })
  const install = page.getByRole('button', { name: '下载并安装' })
  const installVisible = await install.isVisible()
  const screenshots = await screenshotDir('update')
  await page.screenshot({ path: `${screenshots}/update-available.png` })

  // Browser preview has no native installer. The page must say so rather than
  // pretending an update is downloading.
  await install.click()
  await page.getByText('无法启动更新，请确认已允许安装未知应用。').waitFor({ timeout: 10000 })
  const failureShown = await page.getByText('无法启动更新，请确认已允许安装未知应用。').isVisible()

  // Native reports "installer" separately from "network": the APK was on disk
  // and the system installer simply did not open. A generic connection message
  // would send the user to check a network that worked.
  const capability = await page.evaluate(() => (window as any).Capacitor?.isNativePlatform?.() === true)
  console.log(JSON.stringify({ installVisible, failureShown, capability, pageErrors: errors }))
  if (!installVisible || !failureShown || errors.length) process.exitCode = 1
} finally {
  await browser.close()
}
