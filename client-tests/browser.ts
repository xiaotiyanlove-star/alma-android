import { existsSync } from 'node:fs'
import { chromium, type Browser } from '@playwright/test'

const localChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/**
 * Use the installed Chrome on macOS and Playwright's managed Chromium on CI.
 *
 * A fixed macOS executable path made every UI flow fail on Linux runners.
 * Omitting executablePath lets Playwright use the browser it installed.
 */
export function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    ...(existsSync(localChrome) ? { executablePath: localChrome } : {}),
    headless: true,
  })
}
