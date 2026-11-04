/**
 * How each coding agent is presented.
 *
 * Herdr reports a pane's agent as a short name — `claude`, `codex`, `pi` — and
 * that is all the API guarantees. The mark itself is drawn in `agent-marks.ts`;
 * this module supplies the product name and the brand colour used by its
 * status dot.
 *
 * An unknown agent still gets a readable name derived from what Herdr sent, so
 * an agent from a newer desktop is never shown as a blank.
 */

export interface AgentLook {
  /** Product name shown to the user. */
  label: string
  /** The product's colour, for dots and fallbacks. */
  tone: string
}

const LOOKS: Record<string, AgentLook> = {
  claude: { label: 'Claude Code', tone: '#D97757' },
  codex: { label: 'Codex', tone: '#4d6bfe' },
  pi: { label: 'pi', tone: '#4D9ABF' },
  opencode: { label: 'opencode', tone: '#2b2b2b' },
  open_code: { label: 'opencode', tone: '#2b2b2b' },
}

/**
 * Herdr knows many more agents than this client draws marks for. Those still
 * deserve their product name rather than a raw lowercase token.
 */
const NAMES: Record<string, string> = {
  gemini: 'Gemini',
  cursor: 'Cursor',
  amp: 'Amp',
  cline: 'Cline',
  copilot: 'Copilot',
  droid: 'Droid',
  qwen: 'Qwen',
  grok: 'Grok',
  kimi: 'Kimi',
  kiro: 'Kiro',
}

export function agentLook(name?: string): AgentLook {
  const key = (name ?? '').toLowerCase()
  return LOOKS[key] ?? { label: NAMES[key] ?? (name || ''), tone: '#7b8388' }
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
