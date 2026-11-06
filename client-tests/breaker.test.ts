import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import './locale.ts'
import { BREAKER_COOLDOWN_MS, BREAKER_THRESHOLD, clearAllBreakers, directAllowed, recordDirect } from '../client/breaker.ts'

beforeEach(() => { clearAllBreakers() })

test('a path that has not failed is allowed', () => {
  assert.equal(directAllowed('h1'), true)
})

test('a success clears past failures', () => {
  recordDirect('h1', false)
  recordDirect('h1', true)
  recordDirect('h1', false)
  assert.equal(directAllowed('h1'), true, 'the success reset the count')
})

test('consecutive failures suspend the path', () => {
  for (let i = 0; i < BREAKER_THRESHOLD; i++) recordDirect('h1', false)
  assert.equal(directAllowed('h1'), false)
})

test('the suspension lifts on its own, without the user doing anything', () => {
  const started = 1_000_000
  for (let i = 0; i < BREAKER_THRESHOLD; i++) recordDirect('h1', false, started)
  assert.equal(directAllowed('h1', started + 1_000), false)
  assert.equal(directAllowed('h1', started + BREAKER_COOLDOWN_MS), true, 'the cooldown expired')
  // And the next verdict starts from a clean slate.
  assert.equal(directAllowed('h1', started + BREAKER_COOLDOWN_MS), true)
})

test('a suspension is short enough to survive one bad moment', () => {
  // A wrong verdict costs latency, and the failures behind it are usually
  // transient: a handover, a busy radio, a listener that has not come back.
  // Half an hour of it, on a cached address that suppressed every new search,
  // is what kept a session on `relay` for the rest of the day.
  assert.ok(BREAKER_COOLDOWN_MS <= 5 * 60_000, 'a suspended path must come back on its own, quickly')
})

test('a verdict does not outlive the process', () => {
  // Persisting it meant a phone that failed to reach its own desk while the
  // Wi-Fi was still waking up stayed on the relay after a restart.
  const storageWrites: string[] = []
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  ;(globalThis as any).localStorage = {
    getItem: () => null,
    setItem: (key: string) => { storageWrites.push(key) },
    removeItem: () => undefined,
    key: () => null,
    length: 0,
  }
  try {
    for (let i = 0; i < BREAKER_THRESHOLD; i++) recordDirect('h1', false)
    assert.equal(directAllowed('h1'), false)
    assert.deepEqual(storageWrites, [], 'the verdict is memory, not a saved preference')
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else delete (globalThis as any).localStorage
  }
})

test('hosts do not share a suspension', () => {
  for (let i = 0; i < BREAKER_THRESHOLD; i++) recordDirect('h1', false)
  assert.equal(directAllowed('h1'), false)
  assert.equal(directAllowed('h2'), true)
})

test('a network change clears every suspension', () => {
  // The address may be reachable again precisely because the network moved,
  // so a verdict reached on the old link must not carry over.
  for (let i = 0; i < BREAKER_THRESHOLD; i++) recordDirect('h1', false)
  for (let i = 0; i < BREAKER_THRESHOLD; i++) recordDirect('h2', false)
  clearAllBreakers()
  assert.equal(directAllowed('h1'), true)
  assert.equal(directAllowed('h2'), true)
})

