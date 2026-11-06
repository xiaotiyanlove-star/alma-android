// Drives the shipped scanner with a real MediaStream produced by
// canvas.captureStream(), so the app's own video/canvas/jsQR path is used.
import { launchBrowser } from './browser.ts'
import { writeFile } from 'node:fs/promises'
import { screenshotDir } from './artifacts.ts'

const link = 'alma://connect?u=https%3A%2F%2Frelay.example.workers.dev&k=TESTONLY_fake_key_for_camera_check_000000&e2e=1'
// A fixed QR fixture generated from the link above. Keeping the bytes in the
// test removes the macOS-only `qrencode` and BSD `base64` command dependency.
const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAZoAAAGaAQMAAAAMyBcgAAAABlBMVEUAAAD///+l2Z/dAAAAAnRSTlP//8i138cAAAAJcEhZcwAACxIAAAsSAdLdfvwAAAJdSURBVHic7ZpBjuwwCESRfIAcKVfPkXyASJ42FJh09KU/s8TFImo7PK9KFLgj4w8hhAgR2gjqgjjH/Xkec7u3gc2vpTRC9aEGcZzdt6/jzi8m+TkSOKENIE3F9kCCHpCWeuRJaCtItyP/ir30ltBW0LjhPPMd8r3EENoKQv3wLNfN//sToVKQICCefzwQhOpDKe5UZ3SJXy4oBKHaULQXMz4tx4xpMJeOKmtpD0L1oamW6TLY0YhGQ/cuwVv4DaHaUBcnx8ha0iXIOy8JFYdmfN9jmcHE3DrQrEJkhMpDPoLcsh5eSbQDEas9qRoRqgtp/7lkpGrpuLXwmuJnyEFoA8htRWL7igFFdaPOY0pL/kSoKrQm0+HbX00oxpfmpxGqDUWPYduH/4+OfK8u8BtCG0BoONFtJL9B/rD7LnsMQuWh4S5zJkFJeBBUhUdUI0LFoagp51KVstp/Wsc6sj8Rqgv5jliPYVbzHFnDauwMQsUh3GyOdeGNX56lb3EGoQ2gkFHyG0l33Vlk78JCqByUYn1k5T1pVBe4TCdUH1q6sb7jtppiCfpCvEV9Ww2hmhAc5TmlPEuMxsOfCJWFWlxhRWqMJZoFMi5ECZWHMJGk6jKG32g5hMaU0CbQ6jU7bMXbEMlxdkL1oRWRlZqPJZ7QF6HiUF8akVi2mFJaPm1ZDaHCUDMR2WSKBIysdpMRFQdBqDz00k3EJc84CO0ILauxPlUTVUvvdpTQDtD6lMLmlfi3jNAukAkFnehqOSSgp98QKg65jawbLZORNR/+Afd4XmsRqgv9PggRIrQN9AP/eRNFjyo9MAAAAABJRU5ErkJggg=='
const fixtures = await screenshotDir('scan')
await writeFile(`${fixtures}/scan-fixture.png`, Buffer.from(base64, 'base64'))

const browser = await launchBrowser()
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
await page.goto(`http://127.0.0.1:${process.env.APP_PORT ?? 5174}`)
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
