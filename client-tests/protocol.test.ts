import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeChatItems, readChatItem, readChatPage, readMediaResponse, readQueued, readSnapshot, readUploadResponse } from '../client/protocol.ts'

test('a chat page drops malformed rows but preserves valid ones', () => {
  const page = readChatPage({
    session_id: 's1',
    page: { start: 2, end: 5, items: [
      { id: 'good', kind: 'assistant', text: 'hello', images: [{ url: '/api/herdr/image/a.png' }, null] },
      { id: 3, kind: 'assistant', text: 'bad id' },
      { id: 'bad-kind', kind: 4, text: 'bad kind' },
    ] },
    queued: [{ id: 'q1', text: 'next' }, { id: 'q2' }],
    settings: { model: 'gpt-5', effort: 7 },
  })
  assert.equal(page.sessionId, 's1')
  assert.equal(page.start, 2)
  assert.equal(page.end, 5)
  assert.deepEqual(page.items.map((item) => item.id), ['good'])
  assert.deepEqual(page.items[0].images, [{ url: '/api/herdr/image/a.png' }])
  assert.deepEqual(page.queued, [{ id: 'q1', text: 'next' }])
  assert.deepEqual(page.settings, { model: 'gpt-5' })
})

test('a snapshot cannot inject a pane without its routing identity', () => {
  const snapshot = readSnapshot({
    workspaces: [{ workspace_id: 'w1', label: 'project', cwd: '/p' }, { label: 'missing id' }],
    panes: [
      { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 't1', agent: 'codex', git_branch: 'main' },
      { pane_id: 'w1:p2', workspace_id: 'w1', agent: 'codex' },
    ],
    tabs: [{ tab_id: 't1', workspace_id: 'w1', label: 'one' }],
  })
  assert.deepEqual(snapshot?.workspaces, [{ workspace_id: 'w1', label: 'project', cwd: '/p' }])
  assert.deepEqual(snapshot?.panes.map((pane) => pane.pane_id), ['w1:p1'])
  assert.equal(snapshot?.panes[0].git_branch, 'main')
})

test('merging transcript pages keeps first-seen order and replaces duplicates', () => {
  const merged = mergeChatItems(
    [{ id: 'a', kind: 'assistant', text: 'old' }, { id: 'b', kind: 'assistant', text: 'b' }],
    [{ id: 'a', kind: 'assistant', text: 'new' }, { id: 'c', kind: 'assistant', text: 'c' }],
  )
  assert.deepEqual(merged.map((item) => item.id), ['a', 'b', 'c'])
  assert.equal(merged[0].text, 'new')
})

test('a non-image media response cannot be rendered as a picture', () => {
  const answer = readMediaResponse({ bytes: new Uint8Array([1, 2]), contentType: 'text/html' })
  assert.equal(answer, undefined)
  assert.deepEqual(readMediaResponse({ bytes: new Uint8Array([1]), contentType: 'image/png' })?.contentType, 'image/png')
})

test('upload metadata is narrowed before it becomes a message path', () => {
  assert.equal(readUploadResponse({ error: 'quota' }), undefined, 'an error is not an upload result')
  assert.deepEqual(readUploadResponse({ filePath: '/tmp/a.png', filename: 'a.png', size: 3 }), {
    filePath: '/tmp/a.png', filename: 'a.png', size: 3,
  })
})

test('live transcript frames use the same strict parser as the initial page', () => {
  assert.deepEqual(readChatItem({
    id: 'm1', kind: 'assistant', text: 'ok',
    images: [{ url: '/a.png' }, { url: 7 }],
  }), {
    id: 'm1', kind: 'assistant', text: 'ok', images: [{ url: '/a.png' }],
  })
  assert.equal(readChatItem({ id: 'missing-kind' }), undefined)
  assert.deepEqual(readQueued([{ id: 'q1', text: 'wait' }, { id: 2, text: 'bad' }]), [{ id: 'q1', text: 'wait' }])
})
