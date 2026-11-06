import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareVersions } from '../client/updates.ts'

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
