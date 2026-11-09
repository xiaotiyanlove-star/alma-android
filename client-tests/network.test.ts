import { test } from 'node:test'
import assert from 'node:assert/strict'
import { linkKind, shouldRedial } from '../client/connection/network.ts'

test('link types are normalised to the ones that change routing', () => {
  assert.equal(linkKind('wifi'), 'wifi')
  assert.equal(linkKind('WiFi'), 'wifi')
  assert.equal(linkKind('cellular'), 'cellular')
  assert.equal(linkKind('ethernet'), 'ethernet')
  assert.equal(linkKind('none'), 'none')
  assert.equal(linkKind(undefined), 'unknown')
  assert.equal(linkKind('bluetooth'), 'other')
})

test('a handover keeps the app online but must redial', () => {
  // Still connected, different interface: every open socket is now dead even
  // though `navigator.onLine` never changed and no close event will fire.
  assert.equal(shouldRedial({ connected: true, connectionType: 'wifi' }, { connected: true, connectionType: 'cellular' }), true)
  assert.equal(shouldRedial({ connected: true, connectionType: 'cellular' }, { connected: true, connectionType: 'wifi' }), true)
})

test('reconnecting after a loss redials; the same link does not', () => {
  assert.equal(shouldRedial({ connected: false, connectionType: 'none' }, { connected: true, connectionType: 'wifi' }), true)
  // The first status has nothing to compare against, so it counts as a change.
  assert.equal(shouldRedial(undefined, { connected: true, connectionType: 'wifi' }), true)
  // Nothing to do when the same path is reported again.
  assert.equal(shouldRedial({ connected: true, connectionType: 'wifi' }, { connected: true, connectionType: 'wifi' }), false)
})

test('losing the network never triggers a redial', () => {
  assert.equal(shouldRedial({ connected: true, connectionType: 'wifi' }, { connected: false, connectionType: 'none' }), false)
  assert.equal(shouldRedial(undefined, { connected: false, connectionType: 'none' }), false)
})
