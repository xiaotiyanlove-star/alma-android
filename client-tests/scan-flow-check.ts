// Drives the shipped scanner with a real MediaStream produced by
// canvas.captureStream(), so the app's own video/canvas/jsQR path is used.
import { chromium } from '@playwright/test'
import { execFileSync } from 'node:child_process'

const link = 'alma://connect?u=https%3A%2F%2Frelay.example.workers.dev&k=TESTONLY_fake_key_for_camera_check_000000&e2e=1'
execFileSync('qrencode', ['-o', 'test-artifacts/scan-fixture.png', '-s', '10', '-m', '2', link])
const base64 = execFileSync('base64', ['-i', 'test-artifacts/scan-fixture.png']).toString()

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
await context.addInitScript(() => { try { localStorage.setItem('herdr.prefs.locale', 'zh-CN') } catch {} })
await context.addInitScript(({ data }) => {
  if (!('__scanPatched' in window)) {
    Object.assign(window, { __scanPatched: true })
    const realGetUserMedia = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      // Any video request resolves to a synthetic stream painting a real QR.
      const qr = new Image()
      qr.src = `data:image/png;base64,${data}`
      await qr.decode()
      const canvas = document.createElement('canvas')
      canvas.width = 410
      canvas.height = 410
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, 410, 410)
      ctx.drawImage(qr, 0, 0)
      const stream = canvas.captureStream(15)
      return stream
    }
  }
}, { data: base64 })

const page = await context.newPage()
const errors: string[] = []
page.on('pageerror', (error) => errors.push(error.message))
await page.goto('http://127.0.0.1:5174')
// The scan button lives on the dedicated add-desktop page.
await page.getByRole('button', { name: '添加节点', exact: true }).first().click()
await page.getByLabel('节点名称', { exact: true }).waitFor({ timeout: 10000 })
await page.getByLabel('节点名称', { exact: true }).fill('扫码测试')
await page.getByRole('button', { name: '扫码' }).click()
await page.getByRole('dialog', { name: '扫描二维码' }).waitFor()
await page.screenshot({ path: 'test-artifacts/scan-dialog.png' })
await page.waitForFunction(() => {
  const field = document.querySelector<HTMLTextAreaElement>('#pairing-link')
  return Boolean(field && field.value.startsWith('alma://connect'))
}, undefined, { timeout: 20000 })
await page.waitForTimeout(800)
const filled = await page.getByLabel('配对链接', { exact: true }).inputValue()
const closed = !(await page.getByRole('dialog', { name: '扫描二维码' }).isVisible().catch(() => false))
const canSubmit = await page.getByRole('button', { name: '添加节点', exact: true }).last().isEnabled()
await page.screenshot({ path: 'test-artifacts/scan-filled.png' })
console.log(JSON.stringify({ decodedMatches: filled === link, closed, canSubmit, pageErrors: errors }))
await browser.close()
