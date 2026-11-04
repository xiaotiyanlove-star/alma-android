import { test } from 'node:test'
import assert from 'node:assert/strict'
import { looksLikePairingLink, rememberPairingLink, takePendingLink } from '../client/pending-link.ts'

const link = (relay = 'https://relay.invalid') => `alma://connect?u=${encodeURIComponent(relay)}&k=${'A'.repeat(43)}&e2e=1`

test('only a connect link is queued', () => {
  assert.equal(looksLikePairingLink(link()), true)
  assert.equal(looksLikePairingLink(`  ${link().toUpperCase()}`), true, 'case and padding do not matter')
  assert.equal(looksLikePairingLink('https://relay.invalid'), false)
  assert.equal(looksLikePairingLink('alma://other'), false)
  assert.equal(rememberPairingLink('https://relay.invalid'), false)
  assert.equal(takePendingLink(), '', 'a refused link is not queued')
})

test('the link is read once and then gone', () => {
  assert.equal(rememberPairingLink(link()), true)
  assert.equal(takePendingLink(), link())
  assert.equal(takePendingLink(), '', 'a consumed link must not be replayed')
})

test('the credential is held in memory, not written to storage', () => {
  // `sessionStorage` is disk-backed and can outlive the tap it arrived with.
  const writes: string[] = []
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: { setItem: (key: string) => writes.push(key), getItem: () => null, removeItem() {} },
  })
  try {
    assert.equal(rememberPairingLink(link()), true)
    assert.equal(takePendingLink(), link())
    assert.deepEqual(writes, [], 'nothing may be persisted')
  } finally {
    if (original) Object.defineProperty(globalThis, 'sessionStorage', original)
    else delete (globalThis as { sessionStorage?: unknown }).sessionStorage
  }
})
