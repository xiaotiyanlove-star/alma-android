import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AlertTracker } from '../client/notify.ts'
import type { HostState, Pane } from '../client/model.ts'

const host = (panes: Array<Partial<Pane>>, id = 'h1'): HostState => ({
  host: { id, name: `节点 ${id}`, relayUrl: 'https://r.invalid', connectCode: 'x', addedAt: 0 },
  status: 'online',
  herdrOnline: true,
  snapshot: {
    workspaces: [],
    panes: panes.map((pane, index) => ({ pane_id: pane.pane_id ?? `p${index}`, workspace_id: 'w1', tab_id: 't1', agent: 'claude', ...pane })),
  },
})

test('first snapshot never alerts, only real transitions do', () => {
  const tracker = new AlertTracker()
  assert.equal(tracker.update([host([{ agent_status: 'blocked' }])]).length, 0)
  assert.equal(tracker.update([host([{ agent_status: 'blocked' }])]).length, 0)
  const alerts = tracker.update([host([{ agent_status: 'working' }])])
  assert.equal(alerts.length, 0, 'leaving blocked is not an alert')
})

test('working -> blocked alerts once with pane and host identity', () => {
  const tracker = new AlertTracker()
  tracker.update([host([{ agent_status: 'working', terminal_title_stripped: '会话 A' }])])
  const alerts = tracker.update([host([{ agent_status: 'blocked', terminal_title_stripped: '会话 A' }])])
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].kind, 'blocked')
  assert.equal(alerts[0].paneId, 'p0')
  assert.equal(alerts[0].hostId, 'h1')
  assert.match(alerts[0].title, /需要你处理/)
  assert.match(alerts[0].title, /会话 A/)
  assert.equal(tracker.update([host([{ agent_status: 'blocked', terminal_title_stripped: '会话 A' }])]).length, 0, 'no repeat while still blocked')
})

test('working -> done alerts; idle -> blocked also alerts', () => {
  const tracker = new AlertTracker()
  tracker.update([host([{ agent_status: 'working' }, { agent_status: 'idle', pane_id: 'p2' }])])
  const alerts = tracker.update([host([{ agent_status: 'done' }, { agent_status: 'blocked', pane_id: 'p2' }])])
  assert.deepEqual(alerts.map((alert) => alert.kind).sort(), ['blocked', 'done'])
})

test('same pane id on two hosts is tracked independently', () => {
  const tracker = new AlertTracker()
  tracker.update([host([{ pane_id: 'w1:p1', agent_status: 'working' }], 'a'), host([{ pane_id: 'w1:p1', agent_status: 'working' }], 'b')])
  const alerts = tracker.update([host([{ pane_id: 'w1:p1', agent_status: 'blocked' }], 'a'), host([{ pane_id: 'w1:p1', agent_status: 'working' }], 'b')])
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].hostId, 'a')
})

test('muted host is skipped and removed panes stop tracking', () => {
  const tracker = new AlertTracker(new Set(['h1']))
  tracker.update([host([{ agent_status: 'working' }])])
  assert.equal(tracker.update([host([{ agent_status: 'blocked' }])]).length, 0)
  tracker.update([])
  tracker.update([host([{ agent_status: 'working' }])])
  assert.equal(tracker.update([host([{ agent_status: 'blocked' }])]).length, 0, 'reappearing pane is treated as first sight')
})
