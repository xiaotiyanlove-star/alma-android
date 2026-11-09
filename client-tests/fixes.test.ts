import { test } from 'node:test'
import assert from 'node:assert/strict'

import { localeStore as store } from './locale.ts'

const { loadDraft, saveDraft, clearDraft } = await import('../client/session/drafts.ts')
const { parseSessionInfo } = await import('../client/session/session-info.ts')
const { detailInfo, mergedHeaderInfo } = await import('../client/session/session-info.ts')
const { t } = await import('../client/platform/i18n.ts')
const { setLocaleChoice } = await import('../client/platform/prefs.ts')

test('drafts are scoped per desktop and session', () => {
  store.clear()
  saveDraft('A', 'w1:p1', 'hello')
  saveDraft('B', 'w1:p1', 'other')
  assert.equal(loadDraft('A', 'w1:p1'), 'hello')
  assert.equal(loadDraft('B', 'w1:p1'), 'other')
  assert.equal(loadDraft('A', 'w2:p1'), '', 'unknown slot is empty, not shared')
})

test('clearing a draft leaves the others intact', () => {
  store.clear()
  saveDraft('A', 'p1', 'keep')
  saveDraft('A', 'p2', 'drop')
  clearDraft('A', 'p2')
  assert.equal(loadDraft('A', 'p1'), 'keep')
  assert.equal(loadDraft('A', 'p2'), '')
})

test('draft storage survives malformed JSON', () => {
  store.clear()
  store.set('herdr.drafts', '{not json')
  assert.equal(loadDraft('A', 'p1'), '')
  saveDraft('A', 'p1', 'ok')
  assert.equal(loadDraft('A', 'p1'), 'ok')
})

test('model and context are read from the status line', () => {
  const info = parseSessionInfo(['some output', '│ model: claude-opus-5-5 │ context left: 74% │'].join('\n'))
  assert.equal(info.model, 'claude-opus-5-5')
  assert.ok(Math.abs((info.contextRatio ?? 0) - 0.26) < 0.001, '"left" is inverted to used')
  assert.equal(info.contextLabel, '74%')
})

test('pi footer model on the right is recognised', () => {
  const info = parseSessionInfo([
    '~/Personal/alma-android (review/important-fixes)',
    '↑12k ↓3.4k 41.2%/200k (auto)                 agent2api/hy3 • high',
  ].join('\n'))
  assert.equal(info.model, 'agent2api/hy3')
  assert.equal(info.thinking, 'high')
  assert.equal(info.contextLabel, '41.2%')
  assert.ok(Math.abs((info.contextRatio ?? 0) - 0.412) < 0.001)
})

test('codex model without a label and an explicit provider are recognised', () => {
  assert.equal(parseSessionInfo('> input           gpt-5.2-codex / high').model, 'gpt-5.2-codex')
  assert.equal(parseSessionInfo('> input           gpt-5.2-codex / high').thinking, 'high')
  assert.equal(parseSessionInfo('(openai) gpt-5.2-codex').model, 'gpt-5.2-codex')
})

test('pi does not mistake a whole path for a model', () => {
  const info = parseSessionInfo('/Users/me/projects/demo • session-name')
  assert.equal(info.model, undefined)
})

test('token-style context is understood', () => {
  const info = parseSessionInfo('上下文 45% · 120k/200k tokens')
  assert.equal(info.contextRatio !== undefined, true)
  assert.ok((info.contextRatio ?? 0) > 0.44 && (info.contextRatio ?? 0) < 0.46)
})

test('no status line yields no values instead of guesses', () => {
  assert.deepEqual(parseSessionInfo('just some agent output without a status line'), {})
  assert.deepEqual(parseSessionInfo(''), {})
  const emptyModel = parseSessionInfo('model:  context: 400%')
  assert.equal(emptyModel.model, undefined, 'an empty model must not borrow the next label')
  assert.equal(emptyModel.contextRatio, undefined, 'an impossible percentage is rejected')
})

test('a detail read can recover a right-aligned provider model', () => {
  const info = detailInfo('↑12k ↓3.4k 41.2%/200k        agent2api/hy3 • high')
  assert.equal(info.model, 'agent2api/hy3')
  assert.equal(info.effort, undefined)
  assert.equal(info.contextLabel, '41.2%')
})

test('a long terminal cannot push the narrow detail model out of reach', () => {
  const detail = '↑12k ↓3.4k 41.2%/200k        agent2api/hy3 • high'
  const screen = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n')
  const info = mergedHeaderInfo(detail, screen)
  assert.equal(info.model, 'agent2api/hy3')
  assert.equal(info.effort, 'high')
  assert.equal(info.contextLabel, '41.2%')
})

test('language switch changes translated UI copy', () => {
  setLocaleChoice('en')
  assert.equal(t('会话'), 'Sessions')
  assert.equal(t('添加节点'), 'Add desktop')
  setLocaleChoice('zh-CN')
  assert.equal(t('会话'), '会话')
})

test('an untranslated string falls back to the source, never a key', () => {
  setLocaleChoice('en')
  assert.equal(t('这条文案还没有英文'), '这条文案还没有英文')
})

test('every Chinese UI string used in the app has an English entry', async () => {
  const { readFileSync, readdirSync } = await import('node:fs')
  const source = readdirSync('client', { recursive: true })
    .filter((name): name is string => typeof name === 'string' && /\.(?:ts|tsx)$/.test(name) && !/i18n\.ts$/.test(name))
    .map((name) => readFileSync(`client/${name}`, 'utf8'))
    .join('\n')
  const used = new Set([
    ...[...source.matchAll(/(?:t|tWith)\('([^']*[一-鿿][^']*)'/g)].map((m) => m[1]),
  ])
  const dict = readFileSync('client/platform/i18n.ts', 'utf8')
  const missing = [...used].filter((key) => !dict.includes(`'${key}':`))
  assert.deepEqual(missing, [], 'add these to the English dictionary')
})
