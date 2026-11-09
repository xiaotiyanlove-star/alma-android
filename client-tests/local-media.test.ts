import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addLocalMedia, clearLocalMedia, evictOldestLocalMedia, localCopy, localMediaOwner } from '../client/session/local-media.ts'

const created: string[] = []
const url = () => {
  const value = `blob:test-${crypto.randomUUID()}`
  created.push(value)
  return value
}

test('a same-named picture never crosses pane ownership', () => {
  const firstOwner = localMediaOwner('A', 'p1')
  const secondOwner = localMediaOwner('A', 'p2')
  const firstUrl = url()
  const secondUrl = url()
  const first = addLocalMedia({}, firstOwner, '/tmp/hash-a/screenshot.png', 'screenshot.png', firstUrl)
  const both = addLocalMedia(first, secondOwner, '/tmp/hash-b/screenshot.png', 'screenshot.png', secondUrl)

  assert.equal(localCopy(both, firstOwner, '/tmp/hash-a/screenshot.png'), firstUrl)
  assert.equal(localCopy(both, secondOwner, '/tmp/hash-b/screenshot.png'), secondUrl)
  assert.equal(localCopy(both, secondOwner, '/tmp/hash-b/screenshot.png'), secondUrl)
  assert.equal(localCopy(both, localMediaOwner('A', 'p3'), '/tmp/screenshot.png'), undefined)
})

test('a desktop-renamed copy can still be found within its pane', () => {
  const owner = localMediaOwner('A', 'p1')
  const localUrl = url()
  const images = addLocalMedia({}, owner, '/tmp/hash-a/screenshot.png', 'screenshot.png', localUrl)
  assert.equal(localCopy(images, owner, '/tmp/renamed/screenshot.png'), localUrl)
})

test('clearing one pane revokes only its pictures', () => {
  const firstUrl = url()
  const secondUrl = url()
  const first = localMediaOwner('A', 'p1')
  const second = localMediaOwner('A', 'p2')
  const both = addLocalMedia(addLocalMedia({}, first, '/tmp/a.png', 'a.png', firstUrl), second, '/tmp/b.png', 'b.png', secondUrl)
  const cleared = clearLocalMedia(both, first)
  assert.equal(Object.values(cleared).length, 1)
  assert.equal(localCopy(cleared, second, '/tmp/b.png'), secondUrl)
  assert.equal(created.includes(firstUrl), true)
})

test('the local-copy store has a bounded number of entries', () => {
  const owner = localMediaOwner('A', 'p1')
  let images = {}
  for (let index = 0; index < 14; index++) {
    images = addLocalMedia(images, owner, `/tmp/${index}.png`, `${index}.png`, url())
  }
  images = evictOldestLocalMedia(images, 12)
  assert.equal(Object.values(images).length, 12)
  assert.equal(localCopy(images, owner, '/tmp/0.png'), undefined)
  assert.equal(localCopy(images, owner, '/tmp/13.png'), created.at(-1))
})
