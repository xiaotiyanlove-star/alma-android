import { test } from 'node:test'
import assert from 'node:assert/strict'
import { timeline } from '../client/timeline.ts'

const tool = (id: string, name: string, done = true, text?: string) => ({ id, kind: 'tool', time: '2026-11-02T00:00:00Z', text, tool: { id, name, done } })

test('a turn folds its steps and keeps the final answer visible', () => {
  const entries = timeline([
    { id: 'm1', kind: 'assistant', text: 'looking' },
    tool('t1', 'Read'), tool('t2', 'Grep'), tool('t3', 'Edit'),
    { id: 'm2', kind: 'assistant', text: 'done' },
  ])
  assert.deepEqual(entries.map((entry) => entry.kind), ['work', 'item'])
  const group = entries[0]
  assert.equal(group.kind, 'work')
  if (group.kind === 'work') {
    // The narration and the three calls form one step; the answer does not.
    assert.equal(group.items.length, 4)
    assert.equal(group.tools.length, 3)
    assert.equal(group.running, false)
  }
  assert.equal(entries[1].kind === 'item' ? entries[1].item.id : '', 'm2')
})

test('a single tool call is folded too, not left in the transcript', () => {
  const entries = timeline([{ id: 'm1', kind: 'assistant', text: 'x' }, tool('t1', 'Read'), { id: 'm2', kind: 'assistant', text: 'y' }])
  assert.deepEqual(entries.map((entry) => entry.kind), ['work', 'item'])
})

test('a burst with an unfinished call is running', () => {
  const entries = timeline([tool('t1', 'Read'), tool('t2', 'Bash', false)])
  assert.equal(entries.length, 1)
  assert.equal(entries[0].kind, 'work')
  if (entries[0].kind === 'work') assert.equal(entries[0].running, true)
})

test('a tool row that carries text is still part of the work, not lost', () => {
  // The agent's narration rides on the same row as the call. It belongs to the
  // step rather than to the conversation, so it is folded with it.
  const entries = timeline([tool('t1', 'Read', true, 'the file says…'), tool('t2', 'Read')])
  assert.deepEqual(entries.map((entry) => entry.kind), ['work'])
  if (entries[0].kind === 'work') {
    assert.equal(entries[0].items.length, 2)
    assert.equal(entries[0].tools.length, 2)
  }
})

test('an explicitly final event closes the group', () => {
  const entries = timeline([tool('t1', 'Read'), { id: 'm1', kind: 'assistant', text: 'ok', is_final: true }])
  assert.deepEqual(entries.map((entry) => entry.kind), ['work', 'item'])
})

test('a turn with no tool calls is shown, never folded', () => {
  // Folding a plain answer behind a tap would make the transcript look empty —
  // which is exactly what a code-heavy reply without tools did once.
  const entries = timeline([
    { id: 'u1', kind: 'user', text: 'do it' },
    { id: 'm1', kind: 'assistant', text: 'looking' },
    { id: 'm2', kind: 'assistant', text: 'done' },
    { id: 'u2', kind: 'user', text: 'again' },
  ])
  assert.deepEqual(entries.map((entry) => entry.kind), ['item', 'item', 'item', 'item'])
  assert.deepEqual(entries.map((entry) => entry.kind === 'item' ? entry.item.id : ''), ['u1', 'm1', 'm2', 'u2'])
})

test('work before a user message is folded, the answer after it is not', () => {
  const entries = timeline([
    { id: 'u1', kind: 'user', text: 'go' },
    tool('t1', 'Read'),
    { id: 'm1', kind: 'assistant', text: 'result' },
    { id: 'u2', kind: 'user', text: 'again' },
  ])
  assert.deepEqual(entries.map((entry) => entry.kind), ['item', 'work', 'item', 'item'])
})
