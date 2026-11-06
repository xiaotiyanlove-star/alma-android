import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FAST_DELAYS, MAX_RETRIES, SLOW_DELAY_MS, SESSION_DELAYS, jitter, isPermanentFailure, nextDelay, retriesLeft, sessionDelay } from '../client/backoff.ts'
import { DROP_AFTER_MS, VERIFY_AFTER_MS, initialState, step } from '../client/lifecycle.ts'

const fixed = (value: number) => () => value

test('the burst stage is short, so a tunnel is bridged without a tap', () => {
  assert.equal(MAX_RETRIES, FAST_DELAYS.length)
  assert.deepEqual([...FAST_DELAYS], [1_000, 2_000, 4_000, 8_000])
  // Every burst delay is jittered around its target, never above it.
  for (const [index, base] of FAST_DELAYS.entries()) {
    const delay = nextDelay(index, { foreground: true })!
    assert.ok(delay <= base && delay >= base / 4, `${delay} outside the window for ${base}`)
  }
})

test('past the burst a visible app keeps trying, at a patient pace', () => {
  const delay = nextDelay(FAST_DELAYS.length, { foreground: true })
  assert.ok(delay !== null, 'a visible app must not give up for good')
  assert.ok(delay! >= SLOW_DELAY_MS / 4 && delay! <= SLOW_DELAY_MS)
  // And it never stops, no matter how many attempts have failed.
  assert.ok(nextDelay(500, { foreground: true }) !== null)
})

test('a hidden app stops retrying, so a pocket costs no battery', () => {
  assert.equal(nextDelay(FAST_DELAYS.length, { foreground: false }), null)
  assert.equal(nextDelay(500, { foreground: false }), null)
  // Exactly one grace attempt: Android keeps the page alive for a moment after
  // the screen turns off, and losing that first reconnect makes returning slow.
  assert.ok(nextDelay(0, { foreground: false }) !== null)
  assert.equal(nextDelay(1, { foreground: false }), null, 'but no more than that')
})

test('jitter spreads clients but never collapses a wait to nothing', () => {
  assert.equal(jitter(8_000, fixed(0)), 2_000, 'floor a quarter of the window')
  assert.equal(jitter(8_000, fixed(1)), 8_000, 'ceiling is the window itself')
  assert.equal(jitter(8_000, fixed(0.5)), 5_000)
  // A pure full-jitter draw can return milliseconds, which would hammer a
  // relay that is already down. The floor rules that out.
  for (let i = 0; i < 200; i++) assert.ok(jitter(8_000) >= 2_000)
})

test('session refreshes back off and cap instead of hammering', () => {
  assert.deepEqual([...SESSION_DELAYS], [1_800, 3_000, 6_000, 12_000, 30_000])
  // Growing, and capped rather than unbounded.
  const delays = [0, 1, 2, 3, 4, 5, 50].map((failures) => sessionDelay(failures, fixed(1)))
  assert.deepEqual(delays.slice(0, 5), [...SESSION_DELAYS])
  assert.equal(delays[5], 30_000, 'past the ladder it stays at the cap')
  assert.equal(delays[6], 30_000)
  for (let i = 1; i < 5; i++) assert.ok(delays[i] > delays[i - 1], 'each retry waits longer')
})

test('the remaining count is what the UI shows', () => {
  assert.equal(retriesLeft(0), MAX_RETRIES)
  assert.equal(retriesLeft(1), MAX_RETRIES - 1)
  assert.equal(retriesLeft(MAX_RETRIES), 0)
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
  r = step(s, 'tick', 1000 + DROP_AFTER_MS / 6)
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

test('a long absence still only probes while nothing was released', () => {
  // The absence used to be read as "the page was frozen, so the socket is
  // dead" and rebuilt the tunnel after a minute. That cost a working
  // connection on every return: the route fell back to the relay and the
  // session reloaded. One read answers the same question without guessing, so
  // a return that never released anything asks the socket instead of
  // replacing it — however long the absence was.
  let s = step(initialState(), 'hidden', 0).state
  s = step(s, 'tick', DROP_AFTER_MS - 1000).state
  const r = step(s, 'visible', DROP_AFTER_MS + 5000)
  assert.equal(r.action, 'verify', 'the live socket is checked, not rebuilt')
  assert.equal(s.suspended, false, 'nothing was released, so nothing to dial')
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
