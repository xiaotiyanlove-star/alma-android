import { test } from 'node:test'
import assert from 'node:assert/strict'
import { moveKeys, needsSpace, parsePrompt, samePrompt } from '../client/prompt.ts'

const menu = (cursorLine: number, extra = '') => `
╭──────────────────────────────╮
│ Run this command?            │
│                              │
${[1, 2, 3, 4].map((n) => {
  const labels = ['Yes, run command', 'Yes, and always allow in this conversation', 'Yes, and always allow (Persist to settings...)', 'No, cancel.']
  const prefix = n === cursorLine ? '❯ ' : '  '
  return `│ ${prefix}${n}. ${labels[n - 1]}${' '.repeat(30)}│`
}).join('\n')}
│                              │
╰──────────────────────────────╯
${extra}`

test('parses a real permission menu with labels intact', () => {
  const prompt = parsePrompt(menu(1))
  assert.ok(prompt)
  assert.equal(prompt.question, 'Run this command?')
  assert.equal(prompt.options.length, 4)
  assert.equal(prompt.cursor, 0)
  assert.equal(prompt.options[1].label, 'Yes, and always allow in this conversation')
  assert.deepEqual(prompt.options.map((option) => option.number), [1, 2, 3, 4])
})

test('tracks the cursor row', () => {
  assert.equal(parsePrompt(menu(3))?.cursor, 2)
})

test('multi-select boxes are read, not guessed', () => {
  const screen = 'Pick files\n❯ 1. [x] app.ts\n  2. [ ] test.ts\n  3. [x] README.md'
  const prompt = parsePrompt(screen)
  assert.ok(prompt)
  assert.deepEqual(prompt.options.map((option) => option.checked), [true, false, true])
  assert.deepEqual(prompt.options.map((option) => option.label), ['app.ts', 'test.ts', 'README.md'])
  assert.equal(needsSpace(prompt.options[0]), true)
})

test('rejects numbered prose, non-contiguous numbers and single options', () => {
  assert.equal(parsePrompt('Here is what I did\n1. read the file\n2. ran the tests'), null, 'no cursor and no box means no menu')
  assert.equal(parsePrompt('Question?\n❯ 1. first\n  3. third'), null, 'skipped number is not a menu')
  assert.equal(parsePrompt('Question?\n❯ 1. only one option'), null, 'single option is ambiguous')
  assert.equal(parsePrompt('Question?\n❯ 1. a\n  2. '), null, 'empty labels are rejected')
  assert.equal(parsePrompt(''), null)
})

test('requires a question line above the options', () => {
  assert.equal(parsePrompt('❯ 1. yes\n  2. no'), null)
})

test('samePrompt detects drift in labels, cursor and question', () => {
  const a = parsePrompt(menu(1))
  const sameAgain = parsePrompt(menu(1))
  assert.equal(samePrompt(a, sameAgain), true)
  assert.equal(samePrompt(a, parsePrompt(menu(2))), false, 'cursor moved')
  const relabelled = menu(1).replace('No, cancel.', 'No, cancel and stop.')
  assert.equal(samePrompt(a, parsePrompt(relabelled)), false, 'labels changed')
  const requestioned = menu(1).replace('Run this command?', 'Run this other command?')
  assert.equal(samePrompt(a, parsePrompt(requestioned)), false, 'question changed')
  assert.equal(samePrompt(a, null), false)
  assert.equal(samePrompt(null, null), true)
})

test('moveKeys only moves when both positions are known', () => {
  assert.deepEqual(moveKeys(0, 2), ['down', 'down'])
  assert.deepEqual(moveKeys(3, 1), ['up', 'up'])
  assert.equal(moveKeys(-1, 2), null)
  assert.equal(moveKeys(2, 2), null)
})

test('ANSI colour and box frames do not confuse parsing', () => {
  const coloured = menu(1).replace('Run this command?', '\u001b[1mRun this command?\u001b[0m')
  const prompt = parsePrompt(coloured)
  assert.ok(prompt)
  assert.equal(prompt.options.length, 4)
})

test('a two-word confirmation is still a menu', () => {
  // Claude's destructive-command prompt offers exactly "1. Yes / 2. No".
  // Rejecting short labels hid the prompt the user most needs to answer.
  const screen = [
    'Bash command',
    'Check workflow presence on main',
    '────────────────────────',
    'Dangerous rm operation on working directory or its ancestor: /tmp/clone-check',
    '⚠ Claude Code will automatically block this request in 1:02',
    '',
    'Do you want to proceed?',
    '❯ 1. Yes',
    '  2. No',
    '',
    'Esc to cancel · Tab to amend',
  ].join('\n')
  const prompt = parsePrompt(screen)
  assert.ok(prompt)
  assert.equal(prompt.question, 'Do you want to proceed?')
  assert.deepEqual(prompt.options.map((option) => option.label), ['Yes', 'No'])
  assert.equal(prompt.cursor, 0)
})

test('single-character labels are menus, prose still is not', () => {
  assert.ok(parsePrompt('Pick one\n❯ 1. A\n  2. B'))
  assert.equal(parsePrompt('Steps\n1. a\n2. b'), null, 'no cursor: prose')
  assert.equal(parsePrompt('❯ 1. A\n  2. B'), null, 'no question: not a menu')
})
