import { test } from 'node:test'
import assert from 'node:assert/strict'
import './locale.ts'
import { probeTargets, scannableSubnet } from '../client/connection/lan.ts'

test('only home-sized subnets are scanned', () => {
  assert.equal(scannableSubnet({ address: '192.168.1.42', prefixLength: 24 }), true)
  assert.equal(scannableSubnet({ address: '10.0.2.16', prefixLength: 24 }), true)
  // A /16 is 65 534 hosts: scanning it would be a denial-of-service on the
  // network, not a discovery.
  assert.equal(scannableSubnet({ address: '10.0.0.1', prefixLength: 16 }), false)
  assert.equal(scannableSubnet({ address: '10.0.0.1', prefixLength: 8 }), false)
  // A /31 has no usable host range, and /32 is the phone itself.
  assert.equal(scannableSubnet({ address: '10.0.0.1', prefixLength: 31 }), false)
  assert.equal(scannableSubnet({ address: '10.0.0.1', prefixLength: 32 }), false)
})

test('a scan covers usable hosts only', () => {
  const targets = probeTargets({ address: '192.168.1.42', prefixLength: 24 })
  assert.equal(targets.length, 254, 'a /24 has 254 usable addresses')
  assert.equal(targets[0], '192.168.1.1')
  assert.equal(targets.at(-1), '192.168.1.254')
  // Never the network or broadcast address.
  assert.ok(!targets.includes('192.168.1.0'))
  assert.ok(!targets.includes('192.168.1.255'))
})

test('the scan stays inside the subnet it was given', () => {
  const targets = probeTargets({ address: '10.0.2.16', prefixLength: 24 })
  assert.ok(targets.every((host) => host.startsWith('10.0.2.')))
  assert.equal(targets.length, 254)
})

test('a subnet too large to scan yields nothing rather than a flood', () => {
  assert.deepEqual(probeTargets({ address: '10.0.0.1', prefixLength: 16 }), [])
  assert.deepEqual(probeTargets({ address: 'not-an-ip', prefixLength: 24 }), [])
})

test('the candidate list can be capped', () => {
  assert.equal(probeTargets({ address: '192.168.1.5', prefixLength: 24 }, 10).length, 10)
})
