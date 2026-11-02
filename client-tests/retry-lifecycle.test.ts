import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_RETRIES, RETRY_DELAYS, isPermanentFailure, nextDelay, retriesLeft } from '../client/backoff.ts'
import { DROP_AFTER_MS, KEEP_WARM_MS, initialState, step } from '../client/lifecycle.ts'

test('retry delays stay under 30 seconds and stop after three', () => {
  assert.equal(MAX_RETRIES, 3)
  for (const delay of RETRY_DELAYS) assert.ok(delay <= 30_000, `${delay} exceeds the 30 s cap`)
  assert.deepEqual([0, 1, 2].map(nextDelay), [...RETRY_DELAYS])
})

test('the fourth failure gets no delay at all', () => {
  assert.equal(nextDelay(3), null)
  assert.equal(nextDelay(99), null)
})

test('the remaining count is what the UI shows', () => {
  assert.equal(retriesLeft(0), 3)
  assert.equal(retriesLeft(1), 2)
  assert.equal(retriesLeft(3), 0)
  assert.equal(retriesLeft(10), 0, 'never negative')
})

test('permanent failures are recognised so waiting does not waste battery', () => {
  assert.equal(isPermanentFailure('配对验证失败，请重新导入配对链接'), 'auth')
  assert.equal(isPermanentFailure('Handshake authentication failed (auth-failed)'), 'auth')
  assert.equal(isPermanentFailure('relay 502: desktop offline'), 'unknown-host')
  assert.equal(isPermanentFailure('连接已断开'), null, 'transient failures still retry')
  assert.equal(isPermanentFailure('Encrypted connection timed out'), null)
})

test('a short absence keeps the connection warm', () => {
  let s = initialState()
  let r = step(s, 'hidden', 1000)
  s = r.state
  assert.equal(r.action, 'none')
  // Still hidden, but well under the drop threshold.
  r = step(s, 'tick', 1000 + KEEP_WARM_MS)
  s = r.state
  assert.equal(r.action, 'none', 'no suspend while inside the warm window')
  assert.equal(s.suspended, false)
})

test('a long absence releases the connection', () => {
  let s = step(initialState(), 'hidden', 1000).state
  const r = step(s, 'tick', 1000 + DROP_AFTER_MS)
  assert.equal(r.action, 'suspend')
  s = r.state
  assert.equal(s.suspended, true)
})

test('suspend happens once, not on every tick', () => {
  let s = step(initialState(), 'hidden', 0).state
  s = step(s, 'tick', DROP_AFTER_MS).state
  assert.equal(step(s, 'tick', DROP_AFTER_MS * 2).action, 'none')
})

test('returning after a suspend asks for a reconnect', () => {
  let s = step(initialState(), 'hidden', 0).state
  s = step(s, 'tick', DROP_AFTER_MS).state
  const r = step(s, 'visible', DROP_AFTER_MS + 1000)
  assert.equal(r.action, 'resume')
  assert.equal(r.state.suspended, false)
  assert.equal(r.state.hiddenAt, null)
})

test('returning after a short absence does not reconnect', () => {
  let s = step(initialState(), 'hidden', 0).state
  s = step(s, 'tick', KEEP_WARM_MS).state
  const r = step(s, 'visible', KEEP_WARM_MS + 1000)
  assert.equal(r.action, 'none', 'the socket was never released')
  assert.equal(r.state.hiddenAt, null)
})

test('ticks while visible are ignored', () => {
  const s = initialState()
  assert.equal(step(s, 'tick', Date.now() + DROP_AFTER_MS * 2).action, 'none')
})
