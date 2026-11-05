import type { Snapshot } from './model'

/**
 * The directory a new session should start in.
 *
 * "Current" means the pane the user last opened in this desktop. When no pane
 * has been selected yet, the desktop's first pane is the only honest default;
 * the workspace root is the final fallback when the pane does not report one.
 */
export function defaultSessionCwd(snapshot: Snapshot | undefined, selectedPaneId: string | undefined): string {
  if (!snapshot) return ''
  const selected = selectedPaneId
    ? snapshot.panes.find((pane) => pane.pane_id === selectedPaneId)
    : undefined
  const pane = selected ?? snapshot.panes[0]
  return pane?.foreground_cwd ?? pane?.cwd ?? snapshot.workspaces[0]?.cwd ?? ''
}
