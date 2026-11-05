/**
 * Build Android launcher assets from Alma's canonical 512px app icon.
 *
 * Adaptive icons receive a 108dp canvas but launchers visibly crop it to a
 * mask smaller than the full square. Keeping the Alma square in the bitmap at
 * 512px makes the old white rounded tile look like a border inside that mask.
 * The source keeps its own rounded square and shadow. Legacy icons use it
 * directly; adaptive icons use their full 108dp canvas, exactly as a normal
 * launcher icon does. Keeping the same artwork at the same scale prevents the
 * background from appearing as a border around a shrunken portrait.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const source = process.env.ALMA_ICON_SOURCE ?? '/Applications/Alma.app/Contents/Resources/AppIcons/alma.png'
const root = new URL('../android/app/src/main/res/', import.meta.url).pathname
const densities = {
  mdpi: { legacy: 48, adaptive: 108 },
  hdpi: { legacy: 72, adaptive: 162 },
  xhdpi: { legacy: 96, adaptive: 216 },
  xxhdpi: { legacy: 144, adaptive: 324 },
  xxxhdpi: { legacy: 192, adaptive: 432 },
}

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
const data = await readFile(source)
const sourceUrl = `data:image/png;base64,${data.toString('base64')}`

async function render(size, draw) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })
  await page.setContent(`<html><body style="margin:0;background:transparent;width:${size}px;height:${size}px;overflow:hidden">${draw}</body></html>`)
  const png = await page.screenshot({ omitBackground: true })
  await page.close()
  return png
}

try {
  const image = `<img src="${sourceUrl}" style="display:block;width:100%;height:100%;object-fit:contain">`

  // Legacy launcher icons: the Alma artwork already includes its own rounded
  // square. Scale it to the launcher bitmap instead of layering a second mask.
  for (const [density, sizes] of Object.entries(densities)) {
    const directory = join(root, `mipmap-${density}`)
    await mkdir(directory, { recursive: true })
    const square = await render(sizes.legacy, image)
    await writeFile(join(directory, 'ic_launcher.png'), square)
    await writeFile(join(directory, 'ic_launcher_round.png'), square)

    // The adaptive foreground is the same artwork at the normal full-canvas
    // scale. Launchers apply the platform mask; the app must not pre-shrink it.
    const art = sizes.adaptive
    const foreground = await render(
      sizes.adaptive,
      `<div style="display:grid;width:100%;height:100%;place-items:center"><img src="${sourceUrl}" style="display:block;width:${art}px;height:${art}px;object-fit:contain"></div>`,
    )
    await writeFile(join(directory, 'ic_launcher_foreground.png'), foreground)
  }
} finally {
  await browser.close()
}
