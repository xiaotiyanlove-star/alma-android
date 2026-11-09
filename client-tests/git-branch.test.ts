import { test } from 'node:test'
import assert from 'node:assert/strict'
import { branchFromPane, gitBranchFromStatus } from '../client/session/git-branch.ts'

test('reads the current branch including an upstream suffix', () => {
  assert.equal(gitBranchFromStatus('## review/important-fixes...origin/review/important-fixes\n'), 'review/important-fixes')
  assert.equal(gitBranchFromStatus('## main'), 'main')
})

test('no repository or detached HEAD produces no chip', () => {
  assert.equal(gitBranchFromStatus(undefined), null)
  assert.equal(gitBranchFromStatus('fatal: not a git repository'), null)
  assert.equal(gitBranchFromStatus('## HEAD (no branch)'), null)
})

test('desktop snapshot branch wins over a screen probe', () => {
  assert.equal(branchFromPane({ git_branch: 'feature/foo', branch: 'old' }), 'feature/foo')
  assert.equal(branchFromPane({ branch: ' main ' }), 'main')
  assert.equal(branchFromPane({}), null)
})
