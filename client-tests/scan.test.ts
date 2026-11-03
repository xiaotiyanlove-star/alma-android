import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractPairingLink } from '../client/ScanPairs.tsx'

const link = 'alma://connect?u=https%3A%2F%2Frelay.example.workers.dev&k=abcDEF123_xyz&e2e=1'

test('accepts a bare pairing link', () => {
  assert.equal(extractPairingLink(link), link)
  assert.equal(extractPairingLink(`  ${link}  `), link)
})

test('accepts uppercase scheme', () => {
  assert.equal(extractPairingLink(link.replace('alma://', 'ALMA://')), link.replace('alma://', 'ALMA://'))
})

test('extracts the link from a wrapped QR payload', () => {
  assert.equal(extractPairingLink(`Alma Desktop\n${link}\n请保管好`), link)
})

test('rejects unrelated QR content', () => {
  assert.equal(extractPairingLink('https://example.com'), null)
  assert.equal(extractPairingLink('WIFI:S:home;T:WPA;P:secret;;'), null)
  assert.equal(extractPairingLink(''), null)
  assert.equal(extractPairingLink('alma://settings'), null)
})

test('a saved desktop can be turned back into the link that paired it', async () => {
  const { pairingLink, parsePairing } = await import('../client/pairing.ts')
  const link = `alma://connect?u=https%3A%2F%2Frelay.example&k=${'K'.repeat(43)}&e2e=1`
  const host = await parsePairing('家', link)
  const again = pairingLink(host)
  // Round-trips through the same parser, so the link works where a QR would.
  const parsed = await parsePairing('公司', again)
  assert.equal(parsed.relayUrl, host.relayUrl)
  assert.equal(parsed.connectCode, host.connectCode)
  assert.equal(parsed.id, host.id, 'the same desktop, so re-pairing replaces rather than duplicates')
})

test('a re-exported link is still an e2e pairing link', async () => {
  const { pairingLink, parsePairing } = await import('../client/pairing.ts')
  const host = await parsePairing('x', `alma://connect?u=https%3A%2F%2Fr.example&k=${'M'.repeat(32)}&e2e=1`)
  const url = new URL(pairingLink(host))
  assert.equal(url.protocol, 'alma:')
  assert.equal(url.hostname, 'connect')
  assert.equal(url.searchParams.get('e2e'), '1')
  assert.equal(url.searchParams.get('u'), host.relayUrl)
})
