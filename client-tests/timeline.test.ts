import { test } from 'node:test'
import assert from 'node:assert/strict'
import { timeline } from '../client/timeline.ts'

const tool = (id: string, name: string, done = true, text?: string) => ({ id, kind: 'tool', time: '2026-11-02T00:00:00Z', text, tool: { id, name, done } })

test('a run of tool calls becomes one folded entry', () => {
  const entries = timeline([
    { id: 'm1', kind: 'assistant', text: 'looking' },
    tool('t1', 'Read'), tool('t2', 'Grep'), tool('t3', 'Edit'),
    { id: 'm2', kind: 'assistant', text: 'done' },
  ])
  assert.deepEqual(entries.map((entry) => entry.kind), ['item', 'tools', 'item'])
  const group = entries[1]
  assert.equal(group.kind, 'tools')
  if (group.kind === 'tools') {
    assert.equal(group.items.length, 3)
    assert.equal(group.running, false)
  }
})

test('a single tool call is not worth folding', () => {
  const entries = timeline([{ id: 'm1', kind: 'assistant', text: 'x' }, tool('t1', 'Read'), { id: 'm2', kind: 'assistant', text: 'y' }])
  assert.deepEqual(entries.map((entry) => entry.kind), ['item', 'item', 'item'])
})

test('a burst with an unfinished call is running', () => {
  const entries = timeline([tool('t1', 'Read'), tool('t2', 'Bash', false)])
  assert.equal(entries.length, 1)
  assert.equal(entries[0].kind, 'tools')
  if (entries[0].kind === 'tools') assert.equal(entries[0].running, true)
})

test('a tool row that carries text stays a message', () => {
  // The agent's narration rides on the same row as the call; folding it would
  // hide an answer, not scaffolding.
  const entries = timeline([tool('t1', 'Read', true, 'the file says…'), tool('t2', 'Read')])
  assert.deepEqual(entries.map((entry) => entry.kind), ['item', 'item'])
})
