import type { Page } from '@playwright/test'

/**
 * Opens the add-desktop screen and fills in the form.
 * The form lives on its own page now, reached from the settings header or the
 * empty state, so every test goes through here instead of assuming layout.
 */
export async function addDesktop(page: Page, name: string, link: string) {
  const nameField = page.getByLabel('节点名称', { exact: true })
  if (!(await nameField.isVisible().catch(() => false))) {
    // Whichever entry point is on screen: compact-add or the empty state.
    const entry = page.getByRole('button', { name: '添加节点', exact: true })
    await entry.first().click()
    await nameField.waitFor({ timeout: 10000 })
  }
  await nameField.fill(name)
  await page.getByLabel('配对链接', { exact: true }).fill(link)
  await page.getByRole('button', { name: '添加节点', exact: true }).last().click()
  await page.waitForTimeout(500)
}

/** Returns to the session list from wherever the app currently is. */
export async function goHome(page: Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.getByRole('button', { name: '当前节点' }).isVisible().catch(() => false)) return
    const back = page.getByRole('button', { name: '返回会话', exact: true })
    if (await back.isVisible().catch(() => false)) { await back.click(); await page.waitForTimeout(300); continue }
    break
  }
}
