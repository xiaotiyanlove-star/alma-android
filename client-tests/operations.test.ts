import { test } from 'node:test'
import assert from 'node:assert/strict'
import { answerKeys, bracketedTerminalText, protocolKeys, terminalKeys, validTerminalKeys } from '../client/core/operations.ts'

test('terminal key names are canonical protocol values', () => {
  assert.deepEqual(terminalKeys(['Up', 'Escape', 'C-c']), ['up', 'esc', 'ctrl+c'])
  assert.equal(validTerminalKeys([]), false)
  assert.equal(validTerminalKeys(Array(21).fill('Up')), false)
  assert.equal(validTerminalKeys(['Enter']), true)
})

test('terminal text keeps bracketed paste markers', () => {
  assert.equal(bracketedTerminalText('中文\ninput'), '\u001b[200~中文\ninput\u001b[201~')
})

test('multi-select and single-choice menus generate different commit keys', () => {
  const move = (from: number, to: number) => from < to ? ['down'] : ['up']
  assert.deepEqual(answerKeys(1, 0, 1, false, move), ['down', 'enter'])
  assert.deepEqual(answerKeys(1, 0, 1, true, move), ['down', ' '])
  assert.deepEqual(protocolKeys(['down', ' ']), ['down', 'space'])
})
