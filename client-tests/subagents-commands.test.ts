import { test } from 'node:test'
import assert from 'node:assert/strict'
import { backgroundAgents, runningAgents } from '../client/session/subagents.ts'
import { COMMANDS, commandsFor, filterCommands, slashQuery } from '../client/agents/commands.ts'
import type { ChatItem } from '../client/core/model.ts'

const agent = (id: string, done: boolean, description: string, background = true): ChatItem => ({
  id: `row-${id}`,
  kind: 'tool',
  tool: { id, name: 'Agent', done, background, input: { description, subagent_type: 'general-purpose' } },
})

test('a running background agent is reported with its title', () => {
  const found = backgroundAgents([agent('a1', false, 'Security review of main')])
  assert.equal(found.length, 1)
  assert.equal(found[0].title, 'Security review of main')
  assert.equal(found[0].kind, 'general-purpose')
  assert.equal(found[0].background, true)
})

test('finished agents drop out of the count', () => {
  const items = [agent('a1', false, 'one'), agent('a2', true, 'two'), agent('a3', false, 'three')]
  assert.equal(backgroundAgents(items).length, 2)
  assert.deepEqual(backgroundAgents(items).map((a) => a.title), ['one', 'three'])
})

test('foreground agents are listed but not counted as background', () => {
  const items = [agent('a1', false, 'fg', false), agent('a2', false, 'bg', true)]
  assert.equal(runningAgents(items).length, 2, 'both are running')
  assert.equal(backgroundAgents(items).length, 1, 'only one is backgrounded')
})

test('the older Task tool name is still recognised', () => {
  const task: ChatItem = { id: 't', kind: 'tool', tool: { id: 't1', name: 'Task', done: false, background: true, input: { description: 'legacy' } } }
  assert.equal(backgroundAgents([task]).length, 1, 'Task was listed as a background agent by name match')
})

test('non-agent tools are ignored', () => {
  const bash: ChatItem = { id: 'b', kind: 'tool', tool: { id: 'b1', name: 'Bash', done: false } }
  assert.equal(runningAgents([bash]).length, 0)
})

test('duplicate tool ids count once', () => {
  const a = agent('same', false, 'dup')
  assert.equal(runningAgents([a, { ...a, id: 'row2' }]).length, 1)
})

test('a row without a description falls back to the summary', () => {
  const row: ChatItem = { id: 'r', kind: 'tool', summary: 'Fallback title', tool: { id: 'r1', name: 'Agent', done: false, background: true, input: {} } }
  assert.equal(backgroundAgents([row])[0].title, 'Fallback title')
})

test('the picker opens only for a bare slash word', () => {
  assert.equal(slashQuery('/'), '')
  assert.equal(slashQuery('/mo'), 'mo')
  assert.equal(slashQuery('/model'), 'model')
  assert.equal(slashQuery('/model gpt'), null, 'arguments close the picker')
  assert.equal(slashQuery('hello /model'), null)
  assert.equal(slashQuery(''), null)
  assert.equal(slashQuery('/mo del'), null)
})

test('commands are filtered by prefix, case-insensitively', () => {
  const all = commandsFor('claude')
  assert.ok(filterCommands(all, '').length === all.length)
  assert.deepEqual(filterCommands(all, 'mo').map((c) => c.name), ['model'])
  assert.deepEqual(filterCommands(all, 'MOD').map((c) => c.name), ['model'])
  assert.deepEqual(filterCommands(all, 'zzz'), [])
})

test('each agent sees only what it is known to support', () => {
  const claude = commandsFor('claude').map((c) => c.name)
  assert.ok(claude.includes('cost'), 'Claude Code has /cost')
  assert.ok(claude.includes('context'))
  const codex = commandsFor('codex').map((c) => c.name)
  assert.ok(!codex.includes('cost'), 'Codex does not')
  assert.ok(codex.includes('model'))
})

test('no destructive command ships in the first release', () => {
  const names = COMMANDS.map((c) => c.name)
  for (const dangerous of ['clear', 'compact', 'rewind', 'reset', 'quit', 'exit']) {
    assert.ok(!names.includes(dangerous), `${dangerous} must not be offered`)
  }
})

test('a menu command is marked so the UI can warn', () => {
  const model = COMMANDS.find((c) => c.name === 'model')!
  assert.equal(model.risk, 'menu')
  assert.equal(COMMANDS.filter((c) => c.risk === 'read').length > 0, true)
})
