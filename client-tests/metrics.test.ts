import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Metrics } from '../client/metrics.ts'

test('stale detection is measured from when the UI started lying', () => {
  const m = new Metrics()
  m.markUnhealthy(1_000)
  m.markHealthy(5_500)
  assert.deepEqual(m.snapshot(), [{ staleDetectMs: 4_500 }])
})

test('a second mark does not restart the clock', () => {
  // Every send while the link is suspect calls this; the first moment is the
  // one that matters, otherwise a chatty session hides the real delay.
  const m = new Metrics()
  m.markUnhealthy(1_000)
  m.markUnhealthy(3_000)
  m.markHealthy(4_000)
  assert.deepEqual(m.snapshot(), [{ staleDetectMs: 3_000 }])
})

test('a recovery with nothing to recover records nothing', () => {
  const m = new Metrics()
  m.markHealthy(5_000)
  assert.deepEqual(m.snapshot(), [])
})

test('retries are counted per five-minute window', () => {
  const m = new Metrics()
  for (let i = 0; i < 6; i++) m.countRetry(0)
  // The window closes once five minutes have passed.
  m.countRetry(5 * 60_000)
  assert.deepEqual(m.snapshot(), [{ retryBurst: 7 }])
})

test('the summary reports a median, not an average, so one outlier cannot hide a problem', () => {
  const m = new Metrics()
  for (const ms of [1_000, 2_000, 3_000, 60_000]) m.record({ staleDetectMs: ms })
  m.record({ retryBurst: 3 })
  m.record({ retryBurst: 9 })
  const summary = m.summary()
  assert.equal(summary.staleDetectMs, 3_000, 'upper median of four samples')
  assert.equal(summary.staleSamples, 4)
  assert.equal(summary.retryBurstMax, 9)
})

test('old samples are dropped rather than growing without bound', () => {
  const m = new Metrics()
  for (let i = 0; i < 200; i++) m.record({ retryBurst: i })
  assert.equal(m.snapshot().length, 50)
  assert.deepEqual(m.summary().retryBurstMax, 199, 'the newest samples are the ones kept')
})

test('the median of nothing is nothing', () => {
  assert.equal(Metrics.median([]), undefined)
})
