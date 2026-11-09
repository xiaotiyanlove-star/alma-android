import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withDeadline } from '../client/connection/deadline.ts'

test('an answer that arrives in time is passed through untouched', async () => {
  assert.equal(await withDeadline(Promise.resolve('yes'), 100, 'no'), 'yes')
})

test('an answer that never arrives is replaced by the fallback', async () => {
  // The whole point: a native bridge callback can be lost while the page is
  // frozen, and every later caller would inherit the same pending future.
  const stalled = new Promise<string>(() => {})
  const started = Date.now()
  assert.equal(await withDeadline(stalled, 60, 'no'), 'no')
  assert.ok(Date.now() - started >= 50, 'it waited, it did not answer early')
})

test('a rejection takes the fallback rather than escaping', async () => {
  assert.equal(await withDeadline(Promise.reject(new Error('bridge gone')), 100, 'no'), 'no')
})

test('the deadline does not leak a timer into the next call', async () => {
  // A deadline that fired must not keep the event loop alive, or a hundred
  // reconnects leave a hundred pending timers behind them.
  let timers = 0
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  ;(globalThis as any).setTimeout = (...args: any[]) => { timers++; return (realSet as any)(...args) }
  ;(globalThis as any).clearTimeout = (handle: any) => { timers--; return (realClear as any)(handle) }
  try {
    assert.equal(await withDeadline(Promise.resolve('yes'), 50, 'no'), 'yes')
    assert.equal(timers, 0, 'the winning branch cleared its deadline')
  } finally {
    ;(globalThis as any).setTimeout = realSet
    ;(globalThis as any).clearTimeout = realClear
  }
})
