/**
 * Which sessions have news the user has not looked at yet.
 *
 * Herdr reports a pane's state, not its history: `blocked` means the agent is
 * waiting for an answer, `done` means the turn finished. Both mean "you were
 * needed and you were not there", so the list shows a single mark for both and
 * the tooltip says which one it was.
 *
 * The acknowledgement stores the state that was seen, not a timestamp. A pane
 * that goes back to `working` therefore does not lose the mark it earned, and
 * a revisit while the agent is still thinking does not swallow the `done` that
 * arrives afterwards.
 */
import type { HostState } from '../core/model'

const KEY = 'herdr.unread'

/** States worth a mark. `working` is already visible; `idle` means nothing happened. */
export const NEWS_STATES = new Set(['blocked', 'done'])

export interface UnreadPane {
  hostId: string
  paneId: string
  status: 'blocked' | 'done'
}

function read(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value
    }
    return out
  } catch { return {} }
}

function write(seen: Record<string, string>) {
  try { localStorage.setItem(KEY, JSON.stringify(seen)) } catch { /* storage blocked */ }
}

// Writing the record must repaint the lists, and localStorage sends no event.
let listeners = new Set<() => void>()
export function subscribeUnread(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
function changed() { for (const listener of listeners) listener() }

/** Every pane that finished or needs an answer since it was last opened. */
export function unreadPanes(hosts: HostState[]): UnreadPane[] {
  const seen = read()
  const out: UnreadPane[] = []
  for (const host of hosts) {
    for (const pane of host.snapshot?.panes ?? []) {
      const status = pane.agent_status
      if (status !== 'blocked' && status !== 'done') continue
      if (seen[`${host.host.id}:${pane.pane_id}`] === status) continue
      out.push({ hostId: host.host.id, paneId: pane.pane_id, status })
    }
  }
  return out
}

export function isPaneUnread(hostId: string, paneId: string, status?: string): boolean {
  if (!status || !NEWS_STATES.has(status)) return false
  return read()[`${hostId}:${paneId}`] !== status
}

/**
 * How much is waiting on each desktop, split by what the user would do next.
 *
 * The single dot on a session row is right there, but a list of desktops is
 * read one step earlier: the question is "which machine should I open", and
 * "an agent is blocked on me" and "a turn finished while I was away" lead to
 * different actions. Keeping them apart is the whole point of the summary —
 * merging them into a count would answer a question nobody asked.
 */
export interface UnreadSummary {
  /** Agents waiting for an answer. */
  waiting: number
  /** Turns that finished with something to read. */
  done: number
}

export function unreadSummary(hosts: HostState[]): UnreadSummary {
  const summary: UnreadSummary = { waiting: 0, done: 0 }
  for (const pane of unreadPanes(hosts)) {
    if (pane.status === 'blocked') summary.waiting++
    else summary.done++
  }
  return summary
}

/**
 * Records that the user is looking at this pane right now.
 *
 * Only newsworthy states are stored: writing `working` would claim the user
 * saw a result that had not arrived yet.
 */
export function acknowledge(hostId: string, paneId: string, status?: string) {
  if (!status || !NEWS_STATES.has(status)) return
  const seen = read()
  const key = `${hostId}:${paneId}`
  if (seen[key] === status) return
  seen[key] = status
  write(seen)
  changed()
}

/** Forget panes that no longer exist so the record cannot grow forever. */
export function pruneUnread(live: { hostId: string; paneId: string }[]) {
  const seen = read()
  const keep = new Set(live.map((item) => `${item.hostId}:${item.paneId}`))
  let dirty = false
  for (const key of Object.keys(seen)) {
    if (!keep.has(key)) { delete seen[key]; dirty = true }
  }
  if (dirty) { write(seen); changed() }
}
