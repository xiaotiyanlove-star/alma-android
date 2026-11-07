import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * The HTTP verb belongs to the route.
 *
 * The tunnel sends a body as POST unless told otherwise, which matches the
 * RPC-shaped mutations. The desktop also has REST-shaped routes, and guessing
 * wrong produces Express's 404: a healthy tunnel, a valid payload, and a
 * control that looks broken. This pins the two that are known to differ.
 */
const controller = readFileSync('client/controller.ts', 'utf8')

test('muting uses PUT, the verb Alma mounts that route with', () => {
  assert.match(controller, /\/api\/herdr\/mutes', body, \{ kind: 'mutation', method: 'PUT' \}/)
})

test('rpc-shaped mutations keep the POST default', () => {
  // These are declared without a method on purpose: adding PUT here would break
  // the routes that are really POST.
  const restart = controller.match(/\/api\/herdr\/restart-agent'[^\n]*/)?.[0] ?? ''
  assert.ok(restart, 'restart-agent is still called')
  assert.doesNotMatch(restart, /method:/, 'POST is its verb, so the default is correct')
})
