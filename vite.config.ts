import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'

// One source of truth: the Android versionName. The About screen and the APK
// metadata therefore always match.
const gradle = readFileSync('android/app/build.gradle', 'utf8')
const versionName = /versionName\s+"([^"]+)"/.exec(gradle)?.[1] ?? '0.0.0'
const appId = /applicationId\s+"([^"]+)"/.exec(gradle)?.[1] ?? 'local.almaandroid.herdr'
const builtAt = new Date().toISOString().slice(0, 10)

export default defineConfig({
  root: 'client',
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(versionName),
    __APP_ID__: JSON.stringify(appId),
    __BUILD_TIME__: JSON.stringify(builtAt),
  },
  build: { outDir: '../client-dist', emptyOutDir: true },
  server: { strictPort: true },
})
