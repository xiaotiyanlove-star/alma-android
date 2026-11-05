import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MediaCache } from '../client/media-cache.ts'

test('media cache coalesces concurrent reads for one host and path', async () => {
  const cache = new MediaCache()
  let calls = 0
  let resolve!: (value: string) => void
  const read = () => { calls++; return new Promise<string>((done) => { resolve = done }) }
  const first = cache.load('A', '/a.png', read)
  const second = cache.load('A', '/a.png', read)
  assert.equal(calls, 1)
  resolve('data:image/png;base64,AA==')
  assert.equal(await first, 'data:image/png;base64,AA==')
  assert.equal(await second, 'data:image/png;base64,AA==')
})

test('media cache is scoped by host and evicts only the host asked to clear', async () => {
  const cache = new MediaCache(4)
  await cache.load('A', '/same.png', async () => 'a')
  await cache.load('B', '/same.png', async () => 'b')
  cache.clear('A')
  assert.equal(cache.get('A', '/same.png'), undefined)
  assert.equal(cache.get('B', '/same.png'), 'b')
})

test('media cache has a bounded least-recently-used store', async () => {
  const cache = new MediaCache(2)
  await cache.load('A', '/one', async () => '1')
  await cache.load('A', '/two', async () => '2')
  assert.equal(cache.get('A', '/one'), '1')
  await cache.load('A', '/three', async () => '3')
  assert.equal(cache.cachedSize, 2)
  assert.equal(cache.get('A', '/one'), '1')
  assert.equal(cache.get('A', '/two'), undefined)
})

test('clearing a host prevents an in-flight read from repopulating its cache', async () => {
  const cache = new MediaCache(2)
  let finish!: (value: string) => void
  const pending = cache.load('A', '/a.png', () => new Promise((resolve) => { finish = resolve }))
  cache.clear('A')
  finish('data:image/png;base64,AA==')
  assert.equal(await pending, 'data:image/png;base64,AA==')
  assert.equal(cache.get('A', '/a.png'), undefined)
  assert.equal(cache.cachedSize, 0)
})
