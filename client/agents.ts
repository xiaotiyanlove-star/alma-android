/**
 * How each coding agent is presented.
 *
 * Herdr reports a pane's agent as a short name — `claude`, `codex`, `pi` — and
 * that is all the API guarantees. Names, marks and status wording here are the
 * client's own; an unknown agent still gets a sensible mark and its raw name,
 * so a new agent from a newer desktop is never shown as a blank.
 */

export interface AgentLook {
  /** Product name shown to the user. */
  label: string
  /** Rendered as a small square badge; a single character is enough. */
  mark: string
  /** Hue driving the badge, so the agents are told apart at a glance. */
  tone: 'clay' | 'slate' | 'green' | 'plain'
}

const LOOKS: Record<string, AgentLook> = {
  claude: { label: 'Claude Code', mark: '✳', tone: 'clay' },
  codex: { label: 'Codex', mark: '⌘', tone: 'slate' },
  pi: { label: 'pi', mark: 'π', tone: 'green' },
}

export function agentLook(name?: string): AgentLook {
  const key = (name ?? '').toLowerCase()
  return LOOKS[key] ?? { label: name || '', mark: '⌘', tone: 'plain' }
}

/** What the pane is doing, in words the list and the header can share. */
export function statusWord(status?: string): string {
  switch (status) {
    case 'working': return '工作中'
    case 'done': return '已完成'
    case 'blocked': return '等待你'
    case 'idle': return '空闲'
    default: return status || ''
  }
}

/**
 * A dot's meaning. Working is the only state worth animating: it is the one
 * the user checks before putting the phone down.
 */
export function statusTone(status?: string): 'busy' | 'waiting' | 'done' | 'idle' {
  if (status === 'working') return 'busy'
  if (status === 'blocked') return 'waiting'
  if (status === 'done') return 'done'
  return 'idle'
}
