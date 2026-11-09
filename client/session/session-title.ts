/**
 * What a session is called, and why.
 *
 * Kept out of the view so the rule can be tested on its own: the session list
 * labels rows by this, and two panes that share a terminal title must still be
 * told apart by their pane id everywhere that matters.
 */
import type { Pane, Snapshot } from '../core/model'
import { stripAnsi } from '../core/prompt'

/**
 * What a session is called.
 *
 * A name the user gave wins; otherwise the tab label the desktop shows (Herdr
 * numbers new tabs, so an untouched `2` is not a name) and only then the
 * terminal title. That order keeps a renamed session stable: the agent rewrites
 * its terminal title on every turn, so a title-first order would undo a rename
 * the moment the agent next draws.
 */
export function paneTitle(pane?: Pane, tabLabel?: string): string {
  // The pane's own label is the most specific name there is, so it wins; the
  // tab's comes next. That order matters because a tab can hold several panes,
  // and a tab rename therefore gives every one of them the same name — two
  // different sessions end up looking identical in the list, which reads as
  // their contents having been mixed up.
  const named = pane?.label?.trim() || tabLabel?.trim();
  if (named) return stripAnsi(named);
  return stripAnsi(pane?.terminal_title_stripped || pane?.cwd?.split('/').filter(Boolean).pop() || '终端会话');
}

/**
 * The label Herdr holds for a pane's tab, when the snapshot has one.
 *
 * New tabs are numbered, so a bare number is Herdr's placeholder rather than a
 * name; treating it as one would let a rename be undone by that default.
 */
export function tabLabelOf(snapshot: Snapshot | undefined, pane?: Pane): string | undefined {
  const label = snapshot?.tabs?.find(tab => tab.tab_id === pane?.tab_id)?.label?.trim();
  return label && !/^\d+$/.test(label) ? label : undefined;
}
