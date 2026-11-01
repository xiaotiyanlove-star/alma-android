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
