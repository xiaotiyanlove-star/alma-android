import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import './locale.ts'
import { BREAKER_COOLDOWN_MS, BREAKER_THRESHOLD, clearAllBreakers, directAllowed, recordDirect } from '../client/breaker.ts'

// localStorage shim, since these run in node.
const store = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size },
}
beforeEach(() => { store.clear() })

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

test('corrupt or blocked storage never blocks the path outright', () => {
  store.set('herdr.lan.breaker.h1', 'not json')
  assert.equal(directAllowed('h1'), true)
})
