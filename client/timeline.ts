import type { ChatItem } from './model'

export type TimelineEntry =
  | { kind: 'item'; key: string; item: ChatItem }
  | { kind: 'work'; key: string; items: ChatItem[]; tools: ChatItem[]; running: boolean }

const isTool = (item: ChatItem) => item.kind === 'tool' && Boolean(item.tool)
const hasAssistantText = (item: ChatItem) => item.kind === 'assistant' && Boolean(item.text || item.summary)

/**
 * Fold a turn's intermediate narration and tool calls into Alma-style steps.
 *
 * Only turns that actually ran tools are folded. A turn with no tool call is
 * plain conversation, and a reply is never scaffolding: hiding it behind a
 * tap would make the transcript look empty. The last assistant text after the
 * last completed tool is the result and stays visible; while the last tool is
 * still running, nothing is assumed to be final yet. User messages always stay
 * outside the group, and so does an explicitly final event.
 */
export function timeline(items: ChatItem[]): TimelineEntry[] {
  const out: TimelineEntry[] = []
  let turn: ChatItem[] = []

  const flush = () => {
    if (!turn.length) return
    const tools = turn.filter(isTool)
    const running = tools.some((item) => item.tool?.done !== true)
    const lastToolIndex = turn.reduce((last, item, index) => isTool(item) ? index : last, -1)
    const finalIndex = tools.length && !running
      ? turn.reduce((found, item, index) => index > lastToolIndex && hasAssistantText(item) ? index : found, -1)
      : -1
    // Without a tool there is no step to fold, so the whole turn is shown.
    const folded = tools.length ? (finalIndex >= 0 ? turn.slice(0, finalIndex) : turn) : []
    if (folded.length) {
      const foldedTools = folded.filter(isTool)
      out.push({ kind: 'work', key: `work:${folded[0].id}`, items: folded, tools: foldedTools, running: foldedTools.some((item) => item.tool?.done !== true) })
    }
    if (!folded.length || finalIndex >= 0) {
      const shown = !folded.length ? turn : turn.slice(finalIndex)
      for (const item of shown) out.push({ kind: 'item', key: item.id, item })
    }
    turn = []
  }

  for (const item of items) {
    if (item.kind === 'user') {
      flush()
      out.push({ kind: 'item', key: item.id, item })
      continue
    }
    // Explicitly final events close the work group even when Herdr sends no
    // separate final assistant row.
    if ((item.is_final === true || item.turn_complete === true) && item.kind === 'assistant') {
      flush()
      out.push({ kind: 'item', key: item.id, item })
      continue
    }
    if (isTool(item) || item.kind === 'thinking' || item.kind === 'notice' || item.kind === 'recap' || item.kind === 'teammate' || item.kind === 'assistant') {
      turn.push(item)
      continue
    }
    flush()
    out.push({ kind: 'item', key: item.id, item })
  }
  flush()
  return out
}
