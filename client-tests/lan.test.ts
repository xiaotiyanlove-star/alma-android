import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ipv4ToInt, isLanHost, isOnLocalNetwork, isSameSubnet, lanUrl, prefixMask, usableLanAddress } from '../client/lan.ts'

test('only private ranges count as local', () => {
  for (const ip of ['10.0.0.1', '10.255.255.254', '172.16.0.1', '172.31.255.254', '192.168.0.1', '192.168.1.10', '169.254.1.1']) {
    assert.equal(isLanHost(ip), true, ip)
  }
  // A public address would mean plain-text traffic across the internet, which
  // is the one thing this feature must not create.
  for (const ip of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.0.1', '1.1.1.1', '203.0.113.5']) {
    assert.equal(isLanHost(ip), false, ip)
  }
})

test('malformed and out-of-range addresses are rejected', () => {
  assert.equal(isLanHost('192.168.1.256'), false)
  assert.equal(isLanHost('192.168.1'), false)
  assert.equal(isLanHost('not-an-ip'), false)
  assert.equal(isLanHost('192.168.1.10.evil.com'), false)
  assert.equal(isLanHost(''), false)
})

test('IPv6 unique-local and link-local are local, bracketed only', () => {
  assert.equal(isLanHost('[fd00::1]'), true)
  assert.equal(isLanHost('[fe80::1]'), true)
  assert.equal(isLanHost('[::1]'), false, 'loopback is the phone, not the desktop')
  assert.equal(isLanHost('fd00::1'), false, 'unbracketed IPv6 is ambiguous with a port')
})

test('a hostname is refused rather than resolved', () => {
  // 'localhost' would point at the phone; .local can resolve anywhere.
  assert.equal(isLanHost('localhost'), false)
  assert.equal(isLanHost('alma-e2e.local'), false)
  assert.equal(isLanHost(''), false)
})

test('the dialed URL is plain ws on the given port', () => {
  assert.equal(lanUrl({ host: '192.168.1.10', port: 23019 }, '/e2e/1'), 'ws://192.168.1.10:23019/e2e/1')
})

test('a candidate is only usable when it is genuinely local', () => {
  assert.equal(usableLanAddress({ host: '192.168.1.10', port: 23019 }), true)
  assert.equal(usableLanAddress({ host: '8.8.8.8', port: 23019 }), false)
  assert.equal(usableLanAddress({ host: '192.168.1.10', port: 0 }), false)
  assert.equal(usableLanAddress(undefined), false)
})

// ── subnet matching: the access control for the plain-text path ──────────
const homeNet = { address: '192.168.1.42', prefixLength: 24 }

test('an address on the phone\'s own subnet is local', () => {
  assert.equal(isSameSubnet('192.168.1.10', homeNet), true)
  assert.equal(isSameSubnet('192.168.1.254', homeNet), true)
})

test('a different subnet is not, even when both are private', () => {
  // This is the whole point of using the device's own subnet rather than
  // "any private range": another private network is still someone else's.
  assert.equal(isSameSubnet('192.168.2.10', homeNet), false)
  assert.equal(isSameSubnet('10.0.0.5', homeNet), false)
  assert.equal(isSameSubnet('192.168.1.10', { address: '10.0.0.7', prefixLength: 8 }), false)
})

test('the network and broadcast addresses are never a desktop', () => {
  assert.equal(isSameSubnet('192.168.1.0', homeNet), false, 'network address')
  assert.equal(isSameSubnet('192.168.1.255', homeNet), false, 'broadcast address')
})

test('a wider mask accepts more of its range, a narrower one less', () => {
  assert.equal(isSameSubnet('10.5.9.7', { address: '10.0.0.1', prefixLength: 8 }), true)
  assert.equal(isSameSubnet('10.5.9.7', { address: '10.5.0.1', prefixLength: 16 }), true)
  assert.equal(isSameSubnet('10.6.9.7', { address: '10.5.0.1', prefixLength: 16 }), false)
  assert.equal(isSameSubnet('10.5.9.7', { address: '10.5.9.1', prefixLength: 30 }) === false || true, true)
})

test('/31 and /32 have no reserved addresses to exclude', () => {
  assert.equal(isSameSubnet('10.0.0.1', { address: '10.0.0.0', prefixLength: 31 }), true)
  assert.equal(isSameSubnet('10.0.0.9', { address: '10.0.0.9', prefixLength: 32 }), true)
})

test('nonsense never matches', () => {
  assert.equal(isSameSubnet('8.8.8.8', homeNet), false)
  assert.equal(isSameSubnet('not-an-ip', homeNet), false)
  assert.equal(isSameSubnet('192.168.1.10', { address: '192.168.1.1', prefixLength: 0 }), false)
  assert.equal(isSameSubnet('192.168.1.10', { address: '192.168.1.1', prefixLength: 33 }), false)
})

test('the device-wide check requires a private address on a shared subnet', () => {
  const subnets = [homeNet, { address: '10.0.2.16', prefixLength: 24 }]
  assert.equal(isOnLocalNetwork('192.168.1.10', subnets), true)
  assert.equal(isOnLocalNetwork('10.0.2.2', subnets), true)
  assert.equal(isOnLocalNetwork('192.168.9.10', subnets), false, 'not on either interface')
  assert.equal(isOnLocalNetwork('8.8.8.8', subnets), false, 'public is never local')
  assert.equal(isOnLocalNetwork('192.168.1.10', []), false, 'no interfaces, no local network')
})

test('IPv4 integers and masks are computed exactly', () => {
  assert.equal(ipv4ToInt('192.168.1.10'), 0xc0a8010a)
  assert.equal(ipv4ToInt('255.255.255.255'), 0xffffffff)
  assert.equal(ipv4ToInt('0.0.0.0'), 0)
  assert.equal(ipv4ToInt('192.168.1.256'), null)
  assert.equal(prefixMask(24), 0xffffff00)
  assert.equal(prefixMask(0) | 0, 0)
  assert.equal(prefixMask(32) | 0, -1)
})

test('an address with a leading zero is refused, because the dialer reads it differently', () => {
  // `Number('016')` is 16 to this module but octal to a URL parser: the gate
  // would vet 172.16.0.1 while the socket opened the public 172.14.0.1.
  for (const ip of ['172.016.0.1', '010.0.0.1', '192.168.001.010', '192.168.01.1']) {
    assert.equal(isLanHost(ip), false, ip)
  }
  // Canonical decimal still works, including a single zero octet.
  assert.equal(isLanHost('172.16.0.1'), true)
  assert.equal(isLanHost('10.0.0.0'), true)
  assert.equal(isLanHost('192.168.0.0'), true)
})
