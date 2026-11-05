import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultSessionCwd } from '../client/session-directory.ts'
import type { Snapshot } from '../client/model.ts'

const snapshot: Snapshot = {
  workspaces: [{ workspace_id: 'w1', cwd: '/workspace' }],
  panes: [
    { pane_id: 'p1', workspace_id: 'w1', tab_id: 't1', cwd: '/first' },
    { pane_id: 'p2', workspace_id: 'w1', tab_id: 't2', cwd: '/selected', foreground_cwd: '/selected/foreground' },
  ],
}

test('a new session starts in the selected pane', () => {
  assert.equal(defaultSessionCwd(snapshot, 'p2'), '/selected/foreground')
})

test('before any pane has been opened, the first pane is the fallback', () => {
  assert.equal(defaultSessionCwd(snapshot, undefined), '/first')
})

test('workspace root is used only when the pane has no directory', () => {
  assert.equal(defaultSessionCwd({
    workspaces: [{ workspace_id: 'w1', cwd: '/workspace' }],
    panes: [{ pane_id: 'p1', workspace_id: 'w1', tab_id: 't1' }],
  }, 'p1'), '/workspace')
})
