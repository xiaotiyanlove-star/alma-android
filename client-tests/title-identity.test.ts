import { test } from 'node:test'
import assert from 'node:assert/strict'
import './locale.ts'
import { paneTitle, tabLabelOf } from '../client/session-title.ts'
import type { Pane, Snapshot } from '../client/model.ts'

const pane = (over: Partial<Pane>): Pane => ({ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', agent: 'claude', ...over })

test('a renamed tab names every pane in it', () => {
  // `tab.rename` names the tab; a tab holds one or more panes, and the phone has
  // no pane-level rename, so both panes legitimately read the same name.
  const snapshot: Snapshot = {
    workspaces: [{ workspace_id: 'w1' }],
    tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'Herdr 迁移测试' }],
    panes: [pane({ pane_id: 'w1:p1' }), pane({ pane_id: 'w1:p2' })],
  }
  assert.equal(paneTitle(snapshot.panes[0], tabLabelOf(snapshot, snapshot.panes[0])), 'Herdr 迁移测试')
  assert.equal(paneTitle(snapshot.panes[1], tabLabelOf(snapshot, snapshot.panes[1])), 'Herdr 迁移测试')
})

test('a pane label wins over the tab label', () => {
  // A name set on the pane itself is the more specific statement, so it is what
  // the row shows. With the tab winning, a rename made on the desktop was
  // hidden, and — worse — every pane in the tab shared one name.
  const snapshot: Snapshot = {
    workspaces: [{ workspace_id: 'w1' }],
    tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'tab name' }],
    panes: [pane({ label: 'pane name' })],
  }
  assert.equal(paneTitle(snapshot.panes[0], tabLabelOf(snapshot, snapshot.panes[0])), 'pane name')
})

test('panes in one tab are told apart when the desktop names them', () => {
  // The case behind the two identical rows: one tab, several panes, one tab
  // label. The pane label is what keeps them distinct.
  const snapshot: Snapshot = {
    workspaces: [{ workspace_id: 'w1' }],
    tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'Herdr 迁移测试' }],
    panes: [pane({ pane_id: 'w1:p1', label: '官方app对比' }), pane({ pane_id: 'w1:p2' })],
  }
  assert.equal(paneTitle(snapshot.panes[0], tabLabelOf(snapshot, snapshot.panes[0])), '官方app对比')
  // The one without its own label falls back to the tab's, which is correct:
  // it really is the only name that pane has.
  assert.equal(paneTitle(snapshot.panes[1], tabLabelOf(snapshot, snapshot.panes[1])), 'Herdr 迁移测试')
})

test('a numbered tab label is Herdr’s placeholder, not a name', () => {
  const snapshot: Snapshot = { workspaces: [], tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: '2' }], panes: [pane({ terminal_title_stripped: 'Claude Code' })] }
  assert.equal(tabLabelOf(snapshot, snapshot.panes[0]), undefined)
  assert.equal(paneTitle(snapshot.panes[0], tabLabelOf(snapshot, snapshot.panes[0])), 'Claude Code')
})

test('two panes with the same terminal title are still distinguishable by pane id', () => {
  // The row key is the pane id; only the visible text is shared. Loading and
  // every request key on the id, so a shared title cannot mix transcripts.
  const snapshot: Snapshot = {
    workspaces: [], tabs: [],
    panes: [pane({ pane_id: 'w1:p3', terminal_title_stripped: 'Claude Code' }), pane({ pane_id: 'w1:p4', terminal_title_stripped: 'Claude Code' })],
  }
  assert.equal(paneTitle(snapshot.panes[0], tabLabelOf(snapshot, snapshot.panes[0])), 'Claude Code')
  assert.equal(paneTitle(snapshot.panes[1], tabLabelOf(snapshot, snapshot.panes[1])), 'Claude Code')
  assert.notEqual(snapshot.panes[0].pane_id, snapshot.panes[1].pane_id)
})
