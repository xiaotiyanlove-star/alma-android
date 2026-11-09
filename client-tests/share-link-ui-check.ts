// The "connect on another device" flow: open a saved desktop's link, copy it,
// and prove the copied text re-pairs to the same desktop.
import { launchBrowser } from './browser.ts'
import { addDesktop } from './helpers.ts'
import { base64url } from '../client/connection/crypto.ts'
import { parsePairing } from '../client/platform/pairing.ts'

const code = base64url(new Uint8Array(32).fill(81))
const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', permissions: ['clipboard-read', 'clipboard-write'] })
await context.addInitScript({ content: `try { localStorage.setItem('herdr.prefs.locale', 'zh-CN') } catch (e) {}` })
const page = await context.newPage()
const errors: string[] = []
page.on('pageerror', (error: Error) => errors.push(error.message))

try {
  await page.goto(`http://127.0.0.1:${process.env.APP_PORT ?? 5174}`)
  await addDesktop(page, '家里的 Mac', `alma://connect?u=https://relay.invalid&k=${code}&e2e=1`)
  await page.getByRole('button', { name: '节点设置' }).click().catch(() => undefined)
  await page.waitForTimeout(400)

  // The pairing link now lives inside the desktop's own sheet.
  await page.getByRole('button', { name: '设置 家里的 Mac' }).click()
  await page.getByRole('dialog', { name: '桌面设置' }).waitFor()
  await page.getByRole('button', { name: /中继地址/ }).click()
  await page.getByRole('dialog', { name: '连接与中继' }).waitFor()
  const shown = await page.getByRole('textbox', { name: '中继地址' }).inputValue()
  await page.screenshot({ path: 'test-artifacts/share-link.png' })
  const sheetGeometry = await page.getByRole('dialog', { name: '连接与中继' }).evaluate((dialog) => {
    const box = dialog.getBoundingClientRect()
    const footer = dialog.querySelector('.sheet-footer')?.getBoundingClientRect()
    return {
      top: box.top,
      bottom: box.bottom,
      viewport: window.innerHeight,
      footerVisible: footer ? footer.bottom <= window.innerHeight + 1 : false,
      sameStandardClasses: dialog.classList.contains('sheet-standard'),
    }
  })
  if (!sheetGeometry.sameStandardClasses || !sheetGeometry.footerVisible) throw new Error(`relay sheet geometry: ${JSON.stringify(sheetGeometry)}`)

  await page.getByRole('dialog', { name: '连接与中继' }).getByRole('button', { name: '复制地址' }).click()
  await page.waitForTimeout(300)
  const copied = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '')
  const copiedButton = await page.getByRole('button', { name: '已复制' }).isVisible().catch(() => false)

  await page.getByRole('dialog', { name: '连接与中继' }).getByRole('button', { name: '关闭', exact: true }).last().click()
  await page.waitForTimeout(300)
  const closed = !(await page.getByRole('dialog', { name: '连接与中继' }).isVisible().catch(() => false))

  // The whole point: what was copied must pair to the same desktop.
  const reparsed = await parsePairing('公司电脑', copied || shown).catch(() => null)
  const original = await parsePairing('家里', `alma://connect?u=https://relay.invalid&k=${code}&e2e=1`)
  console.log(JSON.stringify({
    shownLooksLikeLink: /^alma:\/\/connect\?/.test(shown),
    showsRelay: shown.includes('relay.invalid'),
    copiedMatchesShown: copied === shown,
    copiedButton,
    closed,
    sheetGeometry,
    sameDesktop: reparsed?.id === original.id,
    pageErrors: errors,
  }))
} finally {
  await browser.close()
}
