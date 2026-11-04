import { test } from 'node:test'
import assert from 'node:assert/strict'
import { candidateKey, LAN_CANDIDATE_PATH, parseLanCandidate, usableCandidateHosts } from '../client/candidates.ts'

test('the desktop’s answer is read strictly', () => {
  assert.deepEqual(parseLanCandidate({ port: 23019, hosts: ['192.168.1.20'] }), { port: 23019, hosts: ['192.168.1.20'] })
  // Trimmed and de-duplicated, so two spellings of one address are one guess.
  assert.deepEqual(parseLanCandidate({ port: 23019, hosts: [' 192.168.1.20 ', '192.168.1.20'] }), { port: 23019, hosts: ['192.168.1.20'] })
})

test('anything malformed is "no answer", not an error to surface', () => {
  for (const value of [null, undefined, 'x', [], {}, { port: 0, hosts: ['10.0.0.1'] }, { port: 70000, hosts: ['10.0.0.1'] },
    { port: 23019 }, { port: 23019, hosts: [] }, { port: 23019, hosts: [1, 2] }, { port: 23019, hosts: ['  '] }]) {
    assert.equal(parseLanCandidate(value), null, JSON.stringify(value))
  }
})

test('.local names are dropped, because an Android WebView cannot resolve them', () => {
  // The desktop reports them (mDNS works on a Mac); the phone would spend a
  // full timeout on an address that can only fail, in front of a working one.
  assert.deepEqual(usableCandidateHosts({ port: 23019, hosts: ['macbook.local', '192.168.1.20', 'Studio.LOCAL'] }), ['192.168.1.20'])
})

test('an address is identified by address and port together', () => {
  // Two desktops on one network can both listen on 23019; the address is what
  // tells them apart, and it is what a route is remembered by.
  assert.equal(candidateKey('192.168.1.20', 23019), '192.168.1.20:23019')
  assert.notEqual(candidateKey('192.168.1.20', 23019), candidateKey('192.168.1.21', 23019))
  assert.equal(candidateKey('192.168.1.20', 23019), candidateKey(' 192.168.1.20 '.trim(), 23019))
})

test('the route path is the one the desktop serves', () => {
  assert.equal(LAN_CANDIDATE_PATH, '/__alma_lan__')
})
