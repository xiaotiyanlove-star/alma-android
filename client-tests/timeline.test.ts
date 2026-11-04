import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countWork, imagePaths, isThinking, timeline, withoutImagePaths, workKind } from '../client/timeline.ts'

const tool = (id: string, name: string, done = true, text?: string, input?: Record<string, unknown>) =>
  ({ id, kind: 'tool', time: '2026-11-02T00:00:00Z', text, tool: { id, name, done, input } })
const think = (id: string, text: string) => ({ id, kind: 'thinking', text })
const say = (id: string, text: string) => ({ id, kind: 'assistant', text })

test('a run of work becomes one folded entry', () => {
  const entries = timeline([say('m1', 'looking'), tool('t1', 'Read'), tool('t2', 'Grep'), tool('t3', 'Edit'), say('m2', 'done')])
  assert.deepEqual(entries.map((entry) => entry.kind), ['item', 'work', 'item'])
  const group = entries[1]
  assert.equal(group.kind, 'work')
  if (group.kind === 'work') {
    assert.equal(group.items.length, 3)
    assert.equal(group.running, false)
    assert.deepEqual(group.counts, [{ kind: 'edit', count: 1 }, { kind: 'read', count: 1 }, { kind: 'search', count: 1 }])
  }
})

test('a single tool call is folded too', () => {
  // Showing one call inline reintroduces the noise the fold exists to remove,
  // and the run is where the counts come from.
  const entries = timeline([say('m1', 'x'), tool('t1', 'Read'), say('m2', 'y')])
  assert.deepEqual(entries.map((entry) => entry.kind), ['item', 'work', 'item'])
})

test('a burst with an unfinished call is running', () => {
  const entries = timeline([tool('t1', 'Read'), tool('t2', 'Bash', false)])
  assert.equal(entries.length, 1)
  assert.equal(entries[0].kind, 'work')
  if (entries[0].kind === 'work') assert.equal(entries[0].running, true)
})

test('a tool row that carries text stays a message', () => {
  // The agent's narration rides on the same row as the call; folding it would
  // hide an answer, not scaffolding.
  const entries = timeline([tool('t1', 'Read', true, 'the file says…'), tool('t2', 'Read')])
  assert.deepEqual(entries.map((entry) => entry.kind), ['item', 'work'])
})

test('the agent thinking is process, not an answer', () => {
  const entries = timeline([say('m1', 'ok'), think('k1', 'let me check'), think('k2', 'and again'), say('m2', 'done')])
  assert.deepEqual(entries.map((entry) => entry.kind), ['item', 'work', 'item'])
  const group = entries[1]
  if (group.kind === 'work') {
    assert.equal(group.items.length, 2)
    // Thinking has no tool name, so it contributes no counts: the summary is
    // about what the agent *did*, not what it thought.
    assert.deepEqual(group.counts, [])
    assert.equal(isThinking(group.items[0]), true)
  }
})

test('a run that is only thinking still gets a line, and does not claim to be running', () => {
  const entries = timeline([think('k1', 'hmm')])
  assert.equal(entries[0].kind, 'work')
  if (entries[0].kind === 'work') assert.equal(entries[0].running, false, 'no unfinished tool call')
})

test('tools are classified the way the desktop classifies them', () => {
  assert.equal(workKind('Bash'), 'command')
  assert.equal(workKind('shell'), 'command')
  assert.equal(workKind('Edit'), 'edit')
  assert.equal(workKind('apply_patch'), 'edit')
  assert.equal(workKind('Read'), 'read')
  assert.equal(workKind('Grep'), 'search')
  assert.equal(workKind('glob'), 'search')
  assert.equal(workKind('WebFetch'), 'fetch')
  assert.equal(workKind('Task'), 'subagent')
  // An unknown tool is "other", never guessed into a category that would make
  // the summary claim something that did not happen.
  assert.equal(workKind('mcp__thing__do'), 'other')
  assert.equal(workKind(undefined), 'other')
})

test('the counts keep a fixed order, so the summary reads the same every time', () => {
  const counts = countWork([tool('a', 'Grep'), tool('b', 'Read'), tool('c', 'Bash'), tool('d', 'Edit')])
  assert.deepEqual(counts.map((entry) => entry.kind), ['command', 'edit', 'read', 'search'])
  assert.deepEqual(counts.map((entry) => entry.count), [1, 1, 1, 1])
  assert.deepEqual(countWork([tool('a', 'Bash'), tool('b', 'Bash')]), [{ kind: 'command', count: 2 }])
})

test('pictures written as paths in a message are found', () => {
  // The shape the desktop's own client accepts: an absolute path or `~`, a
  // known image extension, not part of a longer word.
  assert.deepEqual(imagePaths('see /Users/me/shot.png for the result'), ['/Users/me/shot.png'])
  assert.deepEqual(imagePaths('~/Desktop/a.jpg and /tmp/b.webp'), ['~/Desktop/a.jpg', '/tmp/b.webp'])
  assert.deepEqual(imagePaths('`/tmp/c.png`'), [], 'a path inside backticks is code, not a picture')
  assert.deepEqual(imagePaths('/tmp/notes.txt'), [])
  assert.deepEqual(imagePaths('https://example.com/x.png'), [])
  // A path inside a URL-ish run is part of a word, not a picture reference.
  assert.deepEqual(imagePaths('repo/x.png'), [])
})

test('the path is removed from the body once the picture is shown', () => {
  const text = 'Look:\n\n/Users/me/shot.png\n\nThat is the bug.'
  // The path leaves a blank run behind; collapsing it keeps the paragraph
  // spacing from growing a gap where the picture sits.
  assert.equal(withoutImagePaths(text, ['/Users/me/shot.png']), 'Look:\n\nThat is the bug.')
  // Nothing to remove leaves the text untouched.
  assert.equal(withoutImagePaths('no pictures here', []), 'no pictures here')
})

test('a path with spaces in it is still a picture', () => {
  // Every attachment the desktop writes lives under "Application Support", so
  // stopping at the first space meant no transcript picture ever appeared.
  assert.deepEqual(imagePaths('/Users/me/Library/Application Support/alma/gallery_cache/upload-1.jpg'),
    ['/Users/me/Library/Application Support/alma/gallery_cache/upload-1.jpg'])
  assert.deepEqual(imagePaths('saved to /Users/me/My Folder/a.png'), ['/Users/me/My Folder/a.png'])
})

test('two paths on one line stay two', () => {
  // The lazy match stops at the first extension; without that, the whole line
  // would be taken as one path and neither picture would be shown.
  assert.deepEqual(imagePaths('/tmp/a.png and /tmp/b.jpg'), ['/tmp/a.png', '/tmp/b.jpg'])
  assert.deepEqual(imagePaths('/tmp/a.png\n/tmp/b.png'), ['/tmp/a.png', '/tmp/b.png'])
})
