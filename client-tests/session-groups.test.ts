import { test } from 'node:test'
import assert from 'node:assert/strict'
import './locale.ts'
import { sessionGroups, workspaceForDirectory } from '../client/session-groups.ts'
import type { Snapshot } from '../client/model.ts'

const ALMA = '/Users/bx/Personal/alma-android'
const TMP = '/private/tmp'

/**
 * The desktop this bug was reported on: workspace "tmp" holds four tabs, one of
 * which was started in the alma-android checkout, and workspace
 * "alma-android" holds two. Grouping by workspace filed that one session under
 * "tmp" while its own row said /Users/bx/Personal/alma-android.
 */
const reported: Snapshot = {
  workspaces: [
    { workspace_id: 'w1', label: 'tmp' },
    { workspace_id: 'w3', label: 'alma-android' },
  ],
  tabs: [
    { tab_id: 'w1:t2', workspace_id: 'w1', label: 'Herdr 迁移测试' },
    { tab_id: 'w1:t14', workspace_id: 'w1', label: '官方app对比' },
    { tab_id: 'w1:t1A', workspace_id: 'w1', label: '重构' },
    { tab_id: 'w3:t1', workspace_id: 'w3', label: '1' },
    { tab_id: 'w3:t2', workspace_id: 'w3', label: '2' },
  ],
  panes: [
    { pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 'w1:t2', cwd: TMP, terminal_title_stripped: 'zsh' },
    { pane_id: 'w1:p11', workspace_id: 'w1', tab_id: 'w1:t14', agent: 'claude', cwd: TMP },
    { pane_id: 'w1:p17', workspace_id: 'w1', tab_id: 'w1:t1A', agent: 'claude', cwd: ALMA },
    { pane_id: 'w3:p1', workspace_id: 'w3', tab_id: 'w3:t1', agent: 'claude', cwd: ALMA },
    { pane_id: 'w3:p2', workspace_id: 'w3', tab_id: 'w3:t2', agent: 'codex', cwd: ALMA },
  ],
}

test('a session is grouped by its own directory, not its workspace', () => {
  const groups = sessionGroups(reported)
  const alma = groups.find((group) => group.path === ALMA)
  assert.ok(alma, 'the alma-android group exists')
  // The tab that was created into the wrong workspace is listed with the other
  // sessions that work in that directory.
  assert.deepEqual(alma!.panes.map((pane) => pane.pane_id).sort(), ['w1:p17', 'w3:p1', 'w3:p2'])
  const tmp = groups.find((group) => group.path === TMP)
  assert.deepEqual(tmp!.panes.map((pane) => pane.pane_id).sort(), ['w1:p11', 'w1:p2'])
})

test('a group header never contradicts the paths under it', () => {
  for (const group of sessionGroups(reported)) {
    for (const pane of group.panes) assert.equal(pane.cwd, group.path)
  }
})

test('a workspace label names the group when it covers that one directory', () => {
  const groups = sessionGroups(reported)
  assert.equal(groups.find((group) => group.path === TMP)!.title, 'tmp')
  // "alma-android" is the label of w3, and w3 only lives in this directory, so
  // the user's own name is used rather than the folder name.
  assert.equal(groups.find((group) => group.path === ALMA)!.title, 'alma-android')
})

test('the workspace that owns the directory names the group, not the stray tab', () => {
  const groups = sessionGroups(reported)
  const alma = groups.find((group) => group.path === ALMA)!
  // w1 (the "tmp" workspace) has a pane here too, but w3 is the workspace that
  // lives in this directory, so its label is the honest one.
  assert.equal(alma.title, 'alma-android')
  assert.equal(alma.members.length, 3)
})

test('a workspace that spans directories does not put one label over both', () => {
  const groups = sessionGroups({
    workspaces: [{ workspace_id: 'w1', label: 'tmp' }],
    panes: [
      { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', cwd: '/work/alpha' },
      { pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 'w1:t2', cwd: '/work/beta' },
    ],
  })
  assert.deepEqual(groups.map((group) => group.title).sort(), ['alpha', 'beta'])
})

test('a directory with no label falls back to its folder name', () => {
  const groups = sessionGroups({
    workspaces: [{ workspace_id: 'w1' }],
    panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', cwd: '/work/project/' }],
  })
  assert.equal(groups[0].title, 'project')
})

test('a trailing slash is the same directory', () => {
  const groups = sessionGroups({
    workspaces: [{ workspace_id: 'w1' }],
    panes: [
      { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', cwd: '/work/project' },
      { pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 'w1:t2', cwd: '/work/project/' },
    ],
  })
  assert.equal(groups.length, 1)
  assert.equal(groups[0].panes.length, 2)
})

test('a split tab is one row, and both panes still count as members', () => {
  const groups = sessionGroups({
    workspaces: [{ workspace_id: 'w1', cwd: '/work/project' }],
    panes: [
      { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', cwd: '/work/project' },
      { pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 'w1:t1', cwd: '/work/project' },
    ],
  })
  assert.equal(groups.length, 1)
  assert.equal(groups[0].panes.length, 1)
  assert.equal(groups[0].members.length, 2)
})

test('a split tab follows the directory of the pane it is named after', () => {
  const groups = sessionGroups({
    workspaces: [{ workspace_id: 'w1', cwd: '/work/project' }],
    panes: [
      { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', cwd: '/work/project' },
      { pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 'w1:t1', cwd: '/work/project/packages/app' },
    ],
  })
  // One session to the user: one row, in the directory the tab started in.
  assert.equal(groups.length, 1)
  assert.equal(groups[0].path, '/work/project')
  assert.equal(groups[0].panes.length, 1)
  assert.equal(groups[0].members.length, 2)
})

test('the foreground directory wins over the pane cwd', () => {
  const groups = sessionGroups({
    workspaces: [{ workspace_id: 'w1' }],
    panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', cwd: '/work/project', foreground_cwd: '/work/project/src' }],
  })
  assert.equal(groups[0].path, '/work/project')
})

test('a new tab joins the workspace its directory already lives in', () => {
  // Creating into the first workspace is what filed a session under "tmp"
  // while its row said alma-android.
  // w3 lives only in that directory; w1 merely has one pane there, so it is
  // the workspace a stray tab drifted into and not the one to follow.
  assert.equal(workspaceForDirectory(reported, ALMA), 'w3')
  assert.equal(workspaceForDirectory(reported, `${ALMA}/`), 'w3')
})

test('a directory nothing uses falls back to the first workspace', () => {
  assert.equal(workspaceForDirectory(reported, '/work/new'), 'w1')
  assert.equal(workspaceForDirectory(undefined, '/work/new'), undefined)
})
