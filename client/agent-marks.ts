/**
 * Agent marks.
 *
 * The artwork is the four supplied icons, one per agent, with the plate removed
 * at build time: each source was a mark on white, flood-filled from the border
 * so the white disappears and the art keeps its own colour. That matters on a
 * dark phone — a white JPG would read as four blank tiles.
 *
 * Vite inlines anything under 4 KB and emits the rest as hashed files under
 * `assets/`, which is exactly the behaviour wanted for an APK: no network at
 * runtime, no base64 in the bundle for the larger three.
 *
 * The marks belong to their products; this client is unaffiliated with them.
 */
import claude from './assets/agents/claude.png'
import codex from './assets/agents/codex.png'
import pi from './assets/agents/pi.png'
import terminal from './assets/agents/terminal.png'

export type AgentMarkKind = 'claude' | 'codex' | 'pi' | 'terminal'

export interface AgentMarkSpec {
  kind: AgentMarkKind
  /** Product name, for the label beside the mark. */
  label: string
  /** The artwork, already transparent. */
  src: string
}

const MARKS: Record<string, AgentMarkSpec> = {
  claude: { kind: 'claude', label: 'Claude Code', src: claude },
  codex: { kind: 'codex', label: 'Codex', src: codex },
  pi: { kind: 'pi', label: 'pi', src: pi },
}

/** The mark for an agent Herdr named, or null when we have no artwork for it. */
export function agentMark(name?: string): AgentMarkSpec | null {
  return MARKS[(name ?? '').toLowerCase()] ?? null
}

/** A plain shell has no agent; it gets the terminal glyph. */
export const TERMINAL_MARK: AgentMarkSpec = { kind: 'terminal', label: '终端', src: terminal }

export { claude, codex, pi, terminal }
