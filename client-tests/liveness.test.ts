import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IDLE_PROBE_MS, LIVENESS_TICK_MS, PROBE_TIMEOUT_MS, shouldProbe } from '../client/liveness.ts'

const idle = (overrides: Partial<Parameters<typeof shouldProbe>[0]> = {}) => shouldProbe({
  online: true, lastInboundAt: 1_000, probeInFlight: false, now: 1_000 + IDLE_PROBE_MS, foreground: true, ...overrides,
})

test('a silent tunnel is probed once it has been quiet long enough', () => {
  assert.equal(idle(), true)
  assert.equal(idle({ now: 1_000 + IDLE_PROBE_MS - 1 }), false, 'not before the threshold')
})

test('a live tunnel is never probed, because its traffic already proves it', () => {
  // One second of silence is normal: a session streaming frames looks like this.
  assert.equal(idle({ now: 1_000 + 1_000 }), false)
})

test('nothing is probed for a host that is not online, or one already probing', () => {
  assert.equal(idle({ online: false }), false)
  assert.equal(idle({ probeInFlight: true }), false, 'never stack probes')
})

test('a hidden app does not probe: it cannot act and should not spend radio', () => {
  assert.equal(idle({ foreground: false }), false)
})

test('a tunnel that never carried traffic is left to its connect deadline', () => {
  // `lastInboundAt === 0` means the clock has not started yet; probing here
  // would race the handshake and report a healthy connection as dead.
  assert.equal(idle({ lastInboundAt: 0 }), false)
})

test('the whole detection path must beat the 20 s deadline it replaces', () => {
  // Otherwise a dead link is reported later than before and the change is
  // worse than doing nothing.
  const REQUEST_DEADLINE = 20_000
  const total = IDLE_PROBE_MS + PROBE_TIMEOUT_MS + LIVENESS_TICK_MS
  assert.ok(total < REQUEST_DEADLINE, `quiet ${IDLE_PROBE_MS} + probe ${PROBE_TIMEOUT_MS} + tick ${LIVENESS_TICK_MS} = ${total} ms`)
  assert.ok(LIVENESS_TICK_MS < IDLE_PROBE_MS / 2, 'the tick must not decide the detection time')
  assert.ok(PROBE_TIMEOUT_MS < IDLE_PROBE_MS, 'a probe must give up before the next one is due')
})
