/**
 * Turns a transcript into what the reader should see.
 *
 * An agent runs its tools in long bursts — dozens of read/grep/edit rows in a
 * row — and each one is a line of scaffolding, not conversation. Consecutive
 * tool rows are therefore folded into one entry that can be opened, so the
 * messages on either side stay close to each other.
 */
import type { ChatItem } from './model'

export type TimelineEntry =
  | { kind: 'item'; key: string; item: ChatItem }
  | { kind: 'tools'; key: string; items: ChatItem[]; running: boolean }

/** A tool row with no text of its own is scaffolding; one with text is a reply. */
function isToolRow(item: ChatItem): boolean {
  return Boolean(item.tool) && !item.text && !item.summary
}

/**
 * Groups runs of consecutive tool rows. A run of one stays an ordinary message:
 * folding a single row would hide it behind a tap for no gain.
 */
export function timeline(items: ChatItem[]): TimelineEntry[] {
  const out: TimelineEntry[] = []
  let run: ChatItem[] = []

  const flush = () => {
    if (!run.length) return
    if (run.length === 1) out.push({ kind: 'item', key: run[0].id, item: run[0] })
    else out.push({
      kind: 'tools',
      key: `tools:${run[0].id}`,
      items: run,
      // Any unfinished row means the burst is still going.
      running: run.some((item) => item.tool?.done !== true),
    })
    run = []
  }

  for (const item of items) {
    if (isToolRow(item)) { run.push(item); continue }
    flush()
    out.push({ kind: 'item', key: item.id, item })
  }
  flush()
  return out
}
