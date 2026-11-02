import { test } from 'node:test'
import assert from 'node:assert/strict'
import { back, closeOverlay, getOverlay, getRoute, openOverlay, push, replace, resetForTests } from '../client/router.ts'

const settings = () => ({ name: 'settings' } as const)
const session = (paneId = 'w1:p1') => ({ name: 'session', hostId: 'A', paneId } as const)

test('back leaves the app only from the home screen', () => {
  resetForTests()
  assert.equal(getRoute().name, 'sessions')
  assert.equal(back(), false, 'nothing left to pop at home')
})

test('settings returns to where it was opened from', () => {
  resetForTests()
  push(settings())
  assert.equal(getRoute().name, 'settings')
  assert.equal(back(), true, 'settings must consume Back')
  assert.equal(getRoute().name, 'sessions')
})

test('a session goes back to the list, not out of the app', () => {
  resetForTests()
  push(session())
  assert.equal(back(), true)
  assert.equal(getRoute().name, 'sessions')
})

test('settings -> session -> back retraces the path', () => {
  resetForTests()
  push(settings())
  push(session())
  back()
  assert.equal(getRoute().name, 'settings', 'returned to settings, the previous screen')
  back()
  assert.equal(getRoute().name, 'sessions')
  assert.equal(back(), false, 'now it may leave')
})

test('overlays are dismissed before the screen changes', () => {
  resetForTests()
  push(settings())
  openOverlay({ kind: 'forget' })
  assert.equal(getOverlay()?.kind, 'forget')
  assert.equal(back(), true)
  assert.equal(getOverlay(), null, 'first Back closes the dialog')
  assert.equal(getRoute().name, 'settings', 'and stays on the screen')
  assert.equal(back(), true)
  assert.equal(getRoute().name, 'sessions', 'second Back leaves the screen')
})

test('every overlay kind is dismissible', () => {
  for (const kind of ['scan', 'rename', 'forget', 'hostPicker'] as const) {
    resetForTests()
    openOverlay({ kind })
    assert.equal(back(), true)
    assert.equal(getOverlay(), null, `${kind} closed`)
  }
})

test('replace does not grow history', () => {
  resetForTests()
  push(settings())
  replace({ name: 'sessions' })
  assert.equal(getRoute().name, 'sessions')
  assert.equal(back(), false, 'nothing was stacked')
})

test('history is bounded', () => {
  resetForTests()
  for (let i = 0; i < 30; i++) push(session(`p${i}`))
  let steps = 0
  while (back()) steps++
  assert.ok(steps <= 13, `bounded stack, got ${steps}`)
})

test('closing an overlay directly leaves the route alone', () => {
  resetForTests()
  push(session())
  openOverlay({ kind: 'hostPicker' })
  closeOverlay()
  assert.equal(getOverlay(), null)
  assert.equal(getRoute().name, 'session')
})

test('pushing the same route does not duplicate history', () => {
  resetForTests()
  push(session())
  const before = getRoute()
  push(session())
  assert.equal(back(), true)
  assert.equal(getRoute().name, 'sessions', 'one pop is enough because it was not stacked twice')
  assert.notEqual(before, undefined)
})
