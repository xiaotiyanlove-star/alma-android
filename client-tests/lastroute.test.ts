import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { forgetAllRoutes, forgetRoute, lastRoute, rememberRoute } from '../client/connection/lastroute.ts'

// localStorage shim: these run in node.
const store = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
}

beforeEach(() => store.clear())

test('an address that answered is remembered for that desktop only', () => {
  rememberRoute('A', { host: '192.168.1.20', port: 23019 })
  assert.deepEqual(lastRoute('A'), { host: '192.168.1.20', port: 23019 })
  // The whole point of keying by host: two paired desktops must not share one.
  assert.equal(lastRoute('B'), undefined)
})

test('remembering replaces, so a desktop that moved is not dialled twice', () => {
  rememberRoute('A', { host: '192.168.1.20', port: 23019 })
  rememberRoute('A', { host: '10.0.0.7', port: 23019 })
  assert.deepEqual(lastRoute('A'), { host: '10.0.0.7', port: 23019 })
})

test('forgetting one desktop leaves the others alone', () => {
  rememberRoute('A', { host: '192.168.1.20', port: 23019 })
  rememberRoute('B', { host: '192.168.1.21', port: 23019 })
  forgetRoute('A')
  assert.equal(lastRoute('A'), undefined)
  assert.deepEqual(lastRoute('B'), { host: '192.168.1.21', port: 23019 })
})

test('a network change forgets every address', () => {
  rememberRoute('A', { host: '192.168.1.20', port: 23019 })
  rememberRoute('B', { host: '192.168.1.21', port: 23019 })
  forgetAllRoutes(['A', 'B'])
  assert.equal(lastRoute('A'), undefined)
  assert.equal(lastRoute('B'), undefined)
})

test('a corrupted entry costs a scan, not a broken connection', () => {
  store.set('herdr.lan.last.A', 'not json')
  assert.equal(lastRoute('A'), undefined)
  store.set('herdr.lan.last.A', JSON.stringify({ host: '192.168.1.20', port: 0 }))
  assert.equal(lastRoute('A'), undefined, 'an impossible port is not an address')
  store.set('herdr.lan.last.A', JSON.stringify({ port: 23019 }))
  assert.equal(lastRoute('A'), undefined)
})
