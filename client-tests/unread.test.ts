import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

/**
 * The unread record lives in localStorage, which node does not have. A tiny
 * shim is enough: the module only calls getItem/setItem.
 */
const store = new Map<string, string>()
;(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value) },
  removeItem: (key: string) => { store.delete(key) },
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as unknown as Storage

const { acknowledge, isPaneUnread, pruneUnread, unreadPanes, unreadSummary } = await import('../client/session/unread.ts')

const host = (panes: { pane_id: string; agent_status?: string }[]) => ({
  host: { id: 'h1', name: 'desktop', relayUrl: '', connectCode: '', addedAt: 0 },
  status: 'online' as const,
  herdrOnline: true,
  snapshot: { workspaces: [{ workspace_id: 'w1', cwd: '/p' }], panes: panes.map((pane) => ({ ...pane, workspace_id: 'w1', tab_id: 't1' })) },
})

beforeEach(() => store.clear())

test('blocked and done both count as news, working and idle do not', () => {
  const hosts = [host([
    { pane_id: 'p1', agent_status: 'blocked' },
    { pane_id: 'p2', agent_status: 'done' },
    { pane_id: 'p3', agent_status: 'working' },
    { pane_id: 'p4', agent_status: 'idle' },
  ])]
  assert.deepEqual(unreadPanes(hosts).map((pane) => pane.paneId), ['p1', 'p2'])
})

test('opening a session clears its mark, and only for the state that was seen', () => {
  const hosts = [host([{ pane_id: 'p1', agent_status: 'done' }])]
  assert.equal(unreadPanes(hosts).length, 1)
  acknowledge('h1', 'p1', 'done')
  assert.equal(unreadPanes(hosts).length, 0)

  // A later blocked turn is news again: the acknowledgement is per state.
  const waiting = [host([{ pane_id: 'p1', agent_status: 'blocked' }])]
  assert.equal(unreadPanes(waiting).length, 1)
})

test('acknowledging while working does not swallow the result', () => {
  // Looking at the pane mid-turn must not claim the user saw the answer.
  acknowledge('h1', 'p1', 'working')
  const hosts = [host([{ pane_id: 'p1', agent_status: 'done' }])]
  assert.equal(unreadPanes(hosts).length, 1)
})

test('a mark survives the pane going back to working', () => {
  // The finished turn happened while the user was away; a later busy state
  // must not erase the fact that they missed it.
  const hosts = [host([{ pane_id: 'p1', agent_status: 'working' }])]
  acknowledge('h1', 'p1', 'done')
  assert.equal(isPaneUnread('h1', 'p1', 'done'), false)
  assert.equal(unreadPanes(hosts).length, 0)
})

test('pruning drops panes that no longer exist', () => {
  acknowledge('h1', 'gone', 'done')
  acknowledge('h1', 'kept', 'done')
  pruneUnread([{ hostId: 'h1', paneId: 'kept' }])
  const hosts = [host([{ pane_id: 'gone', agent_status: 'done' }, { pane_id: 'kept', agent_status: 'done' }])]
  assert.deepEqual(unreadPanes(hosts).map((pane) => pane.paneId), ['gone'])
})

test('the desktop summary separates "waiting for you" from "finished"', () => {
  // Choosing a desktop is a different question from choosing a session, and
  // the two kinds of news lead to different next steps: one is an agent
  // stopped on a question, the other is a result to read. A merged count would
  // answer neither.
  const hosts = [host([
    { pane_id: 'p1', agent_status: 'blocked' },
    { pane_id: 'p2', agent_status: 'blocked' },
    { pane_id: 'p3', agent_status: 'done' },
    { pane_id: 'p4', agent_status: 'working' },
  ])]
  assert.deepEqual(unreadSummary(hosts), { waiting: 2, done: 1 })
})

test('a desktop with nothing new reports nothing', () => {
  assert.deepEqual(unreadSummary([host([{ pane_id: 'p1', agent_status: 'idle' }])]), { waiting: 0, done: 0 })
})

test('acknowledging clears a desktop’s summary too', () => {
  const hosts = [host([{ pane_id: 'p1', agent_status: 'blocked' }])]
  assert.deepEqual(unreadSummary(hosts), { waiting: 1, done: 0 })
  acknowledge('h1', 'p1', 'blocked')
  assert.deepEqual(unreadSummary(hosts), { waiting: 0, done: 0 })
})
