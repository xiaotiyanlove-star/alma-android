import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const activity = readFileSync('android/app/src/main/java/local/almaandroid/app/MainActivity.java', 'utf8')
const manifest = readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8')

test('camera access is declared and granted through the WebView permission bridge', () => {
  assert.match(manifest, /uses-permission android:name="android\.permission\.CAMERA"/)
  assert.match(activity, /RequestPermission\(\)/)
  assert.match(activity, /runOnUiThread\(\(\) -> handleCameraRequest\(request\)\)/)
  assert.match(activity, /RESOURCE_VIDEO_CAPTURE/)
  assert.match(activity, /request\.grant\(new String\[\]\{android\.webkit\.PermissionRequest\.RESOURCE_VIDEO_CAPTURE\}\)/)
})

test('returning from unknown-sources settings does not relaunch the settings page forever', () => {
  assert.match(activity, /installPermissionFlow = true/)
  assert.match(activity, /installPermissionFlow = false/)
  assert.match(activity, /pendingInstall = null/)
  assert.match(activity, /State\.set\("failed", "permission", 0\)/)
})

test('canceling the system installer returns update polling to idle', () => {
  assert.match(activity, /if \("installing"\.equals\(DownloaderPlugin\.State\.phase\)\)/)
  assert.match(activity, /State\.set\("idle", "", 0\)/)
})
