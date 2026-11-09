import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RELEASE_TIMEOUT_MS, checkForUpdate, compareVersions } from '../client/updates.ts'

test('versions compare numerically, not as strings', () => {
  assert.ok(compareVersions('0.1.10', '0.1.9') > 0)
  assert.ok(compareVersions('v0.2.0', '0.1.22') > 0)
  assert.equal(compareVersions('0.1.22', 'v0.1.22'), 0)
  assert.ok(compareVersions('0.1.21', '0.1.22') < 0)
})

test('missing or extra components do not change the answer', () => {
  assert.equal(compareVersions('1', '1.0.0'), 0)
  assert.ok(compareVersions('1.0.1', '1') > 0)
})

test('an update check that never answers times out instead of pinning the button', async () => {
  // The WebView can lose a request without settling it. The settings screen
  // sets a busy flag before awaiting this call; without a ceiling that flag
  // stayed true forever, which is exactly the stalled UI seen on a device.
  const original = globalThis.fetch
  globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
  })
  try {
    const started = Date.now()
    await assert.rejects(checkForUpdate('0.1.0'))
    assert.ok(Date.now() - started >= RELEASE_TIMEOUT_MS - 100, 'it waited for the deadline')
  } finally {
    globalThis.fetch = original
  }
})
