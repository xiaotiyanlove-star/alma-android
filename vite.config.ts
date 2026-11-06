import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'

// One source of truth: the Android versionName. The About screen and the APK
// metadata therefore always match.
const gradle = readFileSync('android/app/build.gradle', 'utf8')
const versionName = /versionName\s+"([^"]+)"/.exec(gradle)?.[1] ?? '0.0.0'
const appId = /applicationId\s+"([^"]+)"/.exec(gradle)?.[1] ?? 'local.almaandroid.herdr'
const builtAt = new Date().toISOString().slice(0, 10)

// The development APK installs beside the release under `<id>.dev`. Gradle
// applies that suffix at packaging time, which the regex above cannot see, so
// the dev build passes the final id in. The page needs it: a release APK can
// never replace a differently identified app, so the in-app updater must know
// not to offer one.
const effectiveAppId = process.env.ALMA_APP_ID ?? appId
// The version suffix is derived rather than passed: `versionNameSuffix` is
// applied at packaging time, after this file has been read, so About would
// otherwise claim `0.1.23` for a build whose APK says `0.1.23-dev`. The
// gradle versionName stays the single source of the number itself.
const effectiveVersion = process.env.ALMA_APP_ID ? `${versionName}-dev` : versionName

export default defineConfig({
  root: 'client',
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(effectiveVersion),
    __APP_ID__: JSON.stringify(effectiveAppId),
    __BUILD_TIME__: JSON.stringify(builtAt),
  },
  build: { outDir: '../client-dist', emptyOutDir: true },
  server: { strictPort: true },
})
