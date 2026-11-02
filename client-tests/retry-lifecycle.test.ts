import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_RETRIES, RETRY_DELAYS, isPermanentFailure, nextDelay, retriesLeft } from '../client/backoff.ts'
import { DROP_AFTER_MS, KEEP_WARM_MS, RECONNECT_AFTER_MS, VERIFY_AFTER_MS, initialState, step } from '../client/lifecycle.ts'

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

test('permanent failures are recognised by code, so language cannot break them', () => {
  assert.equal(isPermanentFailure('auth'), 'auth')
  assert.equal(isPermanentFailure('unknown-host'), 'unknown-host')
  assert.equal(isPermanentFailure('network'), null, 'transient failures still retry')
  assert.equal(isPermanentFailure(undefined), null)
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

test('returning at once keeps the live socket', () => {
  // A permission prompt or the file picker hides the page for a moment; the
  // connection was never at risk and should not even be probed.
  let s = step(initialState(), 'hidden', 0).state
  const r = step(s, 'visible', VERIFY_AFTER_MS - 500)
  assert.equal(r.action, 'none')
  assert.equal(r.state.hiddenAt, null)
})

test('a switch long enough to freeze the page probes the existing socket', () => {
  let s = step(initialState(), 'hidden', 0).state
  const r = step(s, 'visible', VERIFY_AFTER_MS + 5000)
  assert.equal(r.action, 'verify', 'the socket may be dead without anything noticing')
  assert.equal(r.awayMs, VERIFY_AFTER_MS + 5000)
})

test('returning after the page was frozen rebuilds the tunnel', () => {
  // Android freezes the WebView while hidden: timers stop, and the relay has
  // already closed the socket the page still believes in. Nothing reports the
  // disconnection, so the length of the absence is the only signal.
  let s = step(initialState(), 'hidden', 0).state
  s = step(s, 'tick', RECONNECT_AFTER_MS - 1000).state
  const r = step(s, 'visible', RECONNECT_AFTER_MS + 5000)
  assert.equal(r.action, 'resume')
  assert.equal(s.suspended, false, 'this is not the suspend path; nothing was released')
})

test('a hidden page that was suspended resumes even after a short gap', () => {
  let s = step(initialState(), 'hidden', 0).state
  s = step(s, 'tick', DROP_AFTER_MS).state
  const r = step(s, 'visible', DROP_AFTER_MS + 1)
  assert.equal(r.action, 'resume')
})

test('ticks while visible are ignored', () => {
  const s = initialState()
  assert.equal(step(s, 'tick', Date.now() + DROP_AFTER_MS * 2).action, 'none')
})
