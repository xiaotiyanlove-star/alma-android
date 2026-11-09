import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * A download has to outlive the screen that started it.
 *
 * The page used to poll a native thread that lived in the app process: hide the
 * app long enough and Android could freeze or reclaim it. The foreground
 * service is what makes the same download continue, and it must be limited to
 * the update itself so it does not become a second always-on service.
 */
const manifest = readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8')
const strings = readFileSync('android/app/src/main/res/values/strings.xml', 'utf8')
const plugin = readFileSync('android/app/src/main/java/local/almaandroid/app/DownloaderPlugin.java', 'utf8')
const service = readFileSync('android/app/src/main/java/local/almaandroid/app/UpdateDownloadService.java', 'utf8')

test('the download service is a declared dataSync foreground service', () => {
  const block = manifest.match(/<service\s+android:name="\.UpdateDownloadService"[\s\S]*?\/>/)?.[0] ?? ''
  assert.ok(block, 'the service is registered')
  assert.match(block, /foregroundServiceType="dataSync"/)
  assert.match(block, /android:exported="false"/, 'nothing outside the app may start it')
})

test('the service stops itself when the transfer ends', () => {
  assert.match(service, /stopForeground\(/, 'a finished update must not keep a notification')
  assert.match(service, /stopSelf\(/)
})

test('the notification is about the update, not the connection keep-alive', () => {
  assert.match(strings, /update_channel_name/)
  assert.match(strings, /update_title/)
  assert.match(service, /update_channel_name/)
  assert.match(service, /update_title/)
})

test('the plugin hands the transfer to the service instead of a bare thread', () => {
  assert.match(plugin, /UpdateDownloadService/, 'the plugin starts the service')
  assert.doesNotMatch(plugin, /new Thread\(\(\) ->/, 'the download no longer lives only in the page process')
})

test('a download that finishes in the background waits for a foreground', () => {
  // Android refuses to start an installer from a background app. The verified
  // file is parked and installed on the next resume, with a notification as the
  // way back — otherwise a background download ends with no visible next step.
  const activity = readFileSync('android/app/src/main/java/local/almaandroid/app/MainActivity.java', 'utf8')
  const service = readFileSync('android/app/src/main/java/local/almaandroid/app/UpdateDownloadService.java', 'utf8')
  assert.match(activity, /static volatile File pendingInstall/)
  assert.match(activity, /public void onResume\(\)[\s\S]{0,400}pendingInstall/)
  assert.match(activity, /private static volatile boolean resumed/, 'foreground state is tracked')
  assert.match(activity, /!resumed/, 'the installer is not attempted from the background')
  assert.match(service, /installUpdateIfAlive\(target\)/)
  assert.match(activity, /pendingInstall = apk/)
  assert.match(strings, /update_ready_title/)
})

test('the result notification has its own id, so stopping the service cannot erase it', () => {
  // Both used 7201. `stopForeground(REMOVE)` clears the foreground notification,
  // which also removed "downloaded, tap to install" a frame after it appeared —
  // a finished background download looked like it did nothing.
  assert.match(service, /static final int NOTIFICATION_ID = 7201/)
  assert.match(service, /static final int RESULT_NOTIFICATION_ID = 7202/)
  const result = service.slice(service.indexOf('static void notifyReady'))
  assert.match(result.slice(0, 2000), /notify\(RESULT_NOTIFICATION_ID/)
  assert.match(service.slice(service.indexOf('private void notifyFailure')).slice(0, 2000), /notify\(RESULT_NOTIFICATION_ID/)
})

test('the progress text is formatted, not string-replaced', () => {
  // `update_text` is "已完成 %d%%": `%%` is an escaped percent for Android's
  // own formatter. Calling `getString(id)` without arguments skips that
  // formatter and returns the raw `%%`, so the shade showed "已完成 42%%".
  // Passing the value through `getString(id, args)` is what un-escapes it.
  assert.match(strings, /<string name="update_text">[^<]*%d%%[^<]*<\/string>/)
  assert.match(service, /getString\(R\.string\.update_text, percent\)/)
  assert.doesNotMatch(service, /getString\(R\.string\.update_text\)\.replace/)
})
