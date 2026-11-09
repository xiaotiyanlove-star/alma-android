import type { AgentSettings, Pane, TranscriptGap } from '../core/model'
import type { ChatPage } from '../core/protocol'

/** Narrows the desktop's transcript settings without inventing a value. */
export function readSettings(value: ChatPage['settings']): AgentSettings | undefined {
  if (!value) return undefined
  const model = typeof value.model === 'string' && value.model ? value.model : null
  const effort = typeof value.effort === 'string' && value.effort ? value.effort : null
  return { model, effort }
}

export function settingsChanged(current: AgentSettings | undefined, next: AgentSettings | undefined): boolean {
  if (!next) return false
  return (current?.model ?? null) !== next.model || (current?.effort ?? null) !== next.effort
}

/**
 * Classifies why a pane has no transcript.
 *
 * A missing native session id is normal for a shell and briefly normal for an
 * agent that has just started. Once the pane has done work and still has no
 * id, the desktop integration is the actionable cause.
 */
export function transcriptGap(code: string, pane: Pane | undefined, sentMessage: boolean): TranscriptGap {
  if (code === 'unsupported_agent') return 'unsupported'
  if (code === 'transcript_not_found') return 'transcript'
  if (!pane) return 'waiting'
  if (!pane.agent && !pane.agent_session?.agent) return 'terminal'
  const worked = sentMessage || ['working', 'done', 'blocked'].includes(pane.agent_status ?? '')
  return worked ? 'integration' : 'waiting'
}
