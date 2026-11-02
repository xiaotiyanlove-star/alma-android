import { chromium } from '@playwright/test'

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo', locale: 'en-US' })
const page = await context.newPage()
const errors: string[] = []
page.on('pageerror', (error: Error) => errors.push(error.message))

await page.goto('http://127.0.0.1:5174')
await page.screenshot({ path: 'test-artifacts/settings-top.png' })

// The settings page is the node screen; language/timezone live under 显示.
const language = page.locator('.select-row').filter({ hasText: '语言' })
const timezone = page.locator('.select-row').filter({ hasText: '时区' })
await language.waitFor({ timeout: 10000 })

const before = {
  language: await language.locator('option:checked').textContent(),
  zone: await timezone.locator('option:checked').textContent(),
  languageHint: (await language.locator('small').textContent())?.trim(),
  zoneHint: (await timezone.locator('small').textContent())?.trim(),
}

// Pick explicit values, then confirm both the control and its hint update.
await language.locator('select').selectOption('zh-CN')
await timezone.locator('select').selectOption('America/New_York')
await page.waitForTimeout(250)
const after = {
  language: await language.locator('option:checked').textContent(),
  zone: await timezone.locator('option:checked').textContent(),
  languageHint: (await language.locator('small').textContent())?.trim(),
  zoneHint: (await timezone.locator('small').textContent())?.trim(),
}

// Back to following the system.
await language.locator('select').selectOption('system')
await timezone.locator('select').selectOption('system')
await page.waitForTimeout(250)
const restored = {
  language: await language.locator('option:checked').textContent(),
  zone: await timezone.locator('option:checked').textContent(),
  zoneHint: (await timezone.locator('small').textContent())?.trim(),
}
await page.screenshot({ path: 'test-artifacts/settings-display.png' })
console.log(JSON.stringify({ before, after, restored, pageErrors: errors }))
await browser.close()
