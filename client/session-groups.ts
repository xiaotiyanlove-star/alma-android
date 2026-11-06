import type { Pane, Snapshot } from './model'
import { t } from './i18n'

/**
 * One heading in the session list, and the rows under it.
 *
 * `panes` holds one pane per tab — the row the user sees — while `members`
 * holds every pane behind those rows, so unread state can be read for the
 * whole tab rather than only its first pane.
 */
export interface SessionGroup {
  id: string
  title: string
  path: string
  panes: Pane[]
  members: Pane[]
}

/** The directory a row stands for: the tab's first pane and what it prints. */
export function sessionDirectory(snapshot: Snapshot | undefined, pane: Pane): string {
  const workspace = snapshot?.workspaces.find(item => item.workspace_id === pane.workspace_id)
  return pane.cwd || pane.foreground_cwd || workspace?.cwd || ''
}

/** Trailing slashes are the same directory, so they must not split a group. */
function key(path: string): string {
  return path.trim().replace(/\/+$/, '')
}

/**
 * The directories each workspace actually holds.
 *
 * Both callers need it: a workspace that covers one directory can name a group,
 * and can be trusted to receive new tabs there. One that covers several is the
 * workspace stray tabs drifted into, and is followed by neither.
 */
function directoriesByWorkspace(snapshot: Snapshot): Map<string, Set<string>> {
  const directories = new Map<string, Set<string>>()
  for (const pane of snapshot.panes) {
    const ids = directories.get(pane.workspace_id) ?? new Set<string>()
    ids.add(key(sessionDirectory(snapshot, pane)) || pane.workspace_id)
    directories.set(pane.workspace_id, ids)
  }
  return directories
}

/**
 * The workspace a new tab in `cwd` belongs to.
 *
 * A directory with sessions already has a workspace, and putting the tab there
 * keeps it beside them on the desktop too. The workspace that lives *only* in
 * that directory wins over one that merely has a pane there: the latter is the
 * workspace a stray tab drifted into, and sending new work after it is how the
 * drift spreads. The first workspace is only the fallback for a directory
 * nothing has used yet, since `tab.create` has to name one.
 */
export function workspaceForDirectory(snapshot: Snapshot | undefined, cwd: string): string | undefined {
  if (!snapshot) return undefined
  const target = key(cwd)
  const directories = directoriesByWorkspace(snapshot)
  const inDirectory = (pane: Pane) => key(sessionDirectory(snapshot, pane)) === target
  return snapshot.panes.find((pane) => inDirectory(pane) && directories.get(pane.workspace_id)?.size === 1)?.workspace_id
    ?? snapshot.panes.find(inDirectory)?.workspace_id
    ?? snapshot.workspaces[0]?.workspace_id
}

/**
 * Groups the list by working directory, one row per tab.
 *
 * The directory is the key rather than the workspace id, because that is what
 * a row prints as its own path. A Herdr workspace can hold a tab whose shell
 * sits somewhere else — a `cd`, or a tab created into the wrong workspace — and
 * grouping by workspace then files that session under a heading its own path
 * contradicts. The heading is the one claim the list makes about where a
 * session is, so it has to agree with the row.
 *
 * A split tab stays one row under the directory of the pane it is named after:
 * it is one session to the user, and listing its other panes would repeat the
 * title while offering no way to tell the rows apart. Those panes are still
 * members, so unread marks cover them.
 *
 * A workspace label names a group when that workspace lives in this one
 * directory. A workspace spread over several directories would otherwise put
 * the same label over groups it does not describe, which is the failure being
 * fixed here.
 *
 * Order is fixed rather than by recency: a list that reorders under the thumb
 * is how the wrong session gets opened.
 */
export function sessionGroups(snapshot: Snapshot | undefined): SessionGroup[] {
  if (!snapshot) return []
  const groups = new Map<string, SessionGroup>()
  const seenTab = new Map<string, SessionGroup>()
  for (const pane of snapshot.panes) {
    const tab = pane.tab_id || pane.pane_id
    const already = seenTab.get(tab)
    if (already) {
      // A further page of a tab the list already has a row for.
      already.members.push(pane)
      continue
    }
    const directory = sessionDirectory(snapshot, pane)
    const id = key(directory) || pane.workspace_id || 'other'
    if (!groups.has(id)) {
      groups.set(id, { id, title: '', path: directory, panes: [], members: [] })
    }
    const group = groups.get(id)!
    group.panes.push(pane)
    group.members.push(pane)
    seenTab.set(tab, group)
  }

  const span = directoriesByWorkspace(snapshot)
  for (const group of groups.values()) {
    // Any workspace in the group that covers only this directory may name it;
    // for a group holding a stray tab, that is the workspace it belongs to.
    const naming = group.members.find((pane) => span.get(pane.workspace_id)?.size === 1)
    const workspace = snapshot.workspaces.find(item => item.workspace_id === naming?.workspace_id)
    const label = workspace?.label?.trim() || workspace?.name?.trim()
    group.title = label || group.path.split('/').filter(Boolean).pop() || t('其他')
  }
  return [...groups.values()]
}
