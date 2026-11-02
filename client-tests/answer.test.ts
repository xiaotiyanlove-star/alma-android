import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Controller } from '../client/controller.ts'
import type { Host } from '../client/model.ts'
import type { Transport } from '../client/transport.ts'
import { parsePrompt } from '../client/prompt.ts'

const host: Host = { id: 'A', name: 'A', relayUrl: 'https://a.invalid', connectCode: 'A'.repeat(43), addedAt: 0 }
const menu = (cursor: number, question = 'Run this command?') => [
  question,
  ...[1, 2, 3].map((n) => `${n === cursor ? '❯ ' : '  '}${n}. ${['Yes, run command', 'Yes, always allow', 'No, cancel'][n - 1]}`),
].join('\n')

class Fake implements Transport {
  calls: { body?: any }[] = []
  screen = menu(1)
  async connect() {}
  async request<T>(path: string, body?: unknown): Promise<T> {
    this.calls.push({ body })
    if (path === '/api/herdr/info') return { online: true } as T
    if (path.startsWith('/api/herdr/chat')) return { session_id: 's', page: { start: 0, end: 1, items: [] } } as T
    const rpc = body as any
    if (rpc?.method === 'pane.read') return { result: { read: { text: this.screen } } } as T
    return { result: {} } as T
  }
  subscribe() { return { close() {} } }
  close() {}
}
const sent = (fake: Fake) => fake.calls.filter((call) => call.body?.method === 'pane.send_keys').flatMap((call) => call.body.params.keys)
const wait = () => new Promise((resolve) => setTimeout(resolve, 2))

async function setup(screen = menu(1)) {
  const fake = new Fake()
  fake.screen = screen
  const controller = new Controller({ persistent: true, async load() { return [host] }, async save() {} }, () => fake)
  await controller.initialize(); await wait()
  controller.selectHost('A'); await controller.selectPane('w1:p1')
  return { fake, controller }
}

test('answering the highlighted first option sends its number', async () => {
  const { fake, controller } = await setup(menu(1))
  try {
    const prompt = parsePrompt(menu(1))!
    await controller.answerPrompt(prompt, 1)
    assert.deepEqual(sent(fake), ['1'])
  } finally { controller.dispose() }
})

test('answering a lower row moves the cursor then commits', async () => {
  const { fake, controller } = await setup(menu(1))
  try {
    const prompt = parsePrompt(menu(1))!
    await controller.answerPrompt(prompt, 3)
    assert.deepEqual(sent(fake), ['down', 'down', 'enter'])
  } finally { controller.dispose() }
})

test('stale screen aborts without sending anything', async () => {
  const { fake, controller } = await setup(menu(1))
  try {
    const stale = parsePrompt(menu(1))!
    fake.screen = menu(2)
    await controller.answerPrompt(stale, 1)
    assert.deepEqual(sent(fake), [], 'cursor moved underneath the tap')
    assert.match(controller.getState().session?.error ?? '', /已变化/)
  } finally { controller.dispose() }
})

test('a different question aborts even when the cursor matches', async () => {
  const { fake, controller } = await setup(menu(1))
  try {
    const stale = parsePrompt(menu(1))!
    fake.screen = menu(1, 'Delete the database?')
    await controller.answerPrompt(stale, 1)
    assert.deepEqual(sent(fake), [])
  } finally { controller.dispose() }
})

test('multi-select rows toggle instead of submitting', async () => {
  const screen = 'Pick files\n❯ 1. [ ] app.ts\n  2. [ ] test.ts'
  const { fake, controller } = await setup(screen)
  try {
    const prompt = parsePrompt(screen)!
    await controller.answerPrompt(prompt, 1)
    assert.deepEqual(sent(fake), ['space'])
  } finally { controller.dispose() }
})

test('unknown option number is refused', async () => {
  const { fake, controller } = await setup(menu(1))
  try {
    await assert.rejects(controller.answerPrompt(parsePrompt(menu(1))!, 9), /选项不存在/)
    assert.deepEqual(sent(fake), [])
  } finally { controller.dispose() }
})

test('multi-select never sends Enter, even when the cursor must move', async () => {
  // Row 1 is highlighted; the user taps row 3. Moving there must not submit.
  const screen = 'Pick files\n❯ 1. [ ] app.ts\n  2. [ ] test.ts\n  3. [ ] readme.md'
  const { fake, controller } = await setup(screen)
  try {
    const prompt = parsePrompt(screen)!
    await controller.answerPrompt(prompt, 3)
    const keys = sent(fake)
    assert.ok(!keys.includes('enter'), `Enter would submit the whole form; got ${JSON.stringify(keys)}`)
    assert.ok(keys.includes('space'), 'the row is toggled with space')
    assert.deepEqual(keys, ['down', 'down', 'space'])
  } finally { controller.dispose() }
})

test('single-choice still commits with Enter after moving', async () => {
  const screen = 'Run this command?\n❯ 1. Yes, run command\n  2. No, cancel'
  const { fake, controller } = await setup(screen)
  try {
    await controller.answerPrompt(parsePrompt(screen)!, 2)
    assert.deepEqual(sent(fake), ['down', 'enter'], 'single-choice needs Enter to commit')
  } finally { controller.dispose() }
})
