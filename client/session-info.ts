/**
 * Reads the facts a coding agent prints in its own status line: which model is
 * active and how full the context window is.
 *
 * The model and effort have a better source — the desktop reads them from the
 * transcript and sends them with the chat page (`settings`) — so they are only
 * parsed here as a fallback for desktops too old to send them, and the caller
 * prefers the desktop's answer. The context figure has no other source, which
 * is why the terminal is still the place for it.
 *
 * Everything is best-effort: a line that does not match yields no value and the
 * UI omits the field rather than showing a guess.
 */

export interface SessionInfo {
  model?: string
  /** 0..1 when the agent reports a percentage. */
  contextRatio?: number
  /** The number as printed, e.g. "74%". */
  contextLabel?: string
  thinking?: string
}

/** What the header shows, after the desktop's settings win over the screen. */
export interface HeaderInfo extends SessionInfo {
  /** Only when the desktop reported one. */
  effort?: string
}

/**
 * Merges the desktop's transcript settings over what the screen printed.
 *
 * A desktop that sends `settings` is authoritative even when a field is null
 * there: "the transcript says no model" is a real answer, and falling back to
 * a scraped one would re-introduce the guess. A desktop that sends nothing (an
 * older build) leaves the scraped values alone.
 */
export function headerInfo(screen: string, settings?: { model?: string | null; effort?: string | null } | null): HeaderInfo {
  const parsed = parseSessionInfo(screen)
  if (!settings) return parsed
  return {
    ...parsed,
    model: settings.model ?? undefined,
    effort: settings.effort ?? undefined,
  }
}

// The value must be a single word with no colon: "model:  context: 400%"
// has an empty model, and must not borrow the next label.
const MODEL = /(?:^|[\s│|])(?:model|模型)\s*[:：][ \t]?([^\s│|:：][^\s│|]{1,59})/iu
const THINKING = /(?:^|[\s│|])(?:thinking|reasoning|思考)\s*[:：]\s*([a-z]+|开|关)/iu
// "context left: 74%", "context: 45%", "上下文 45%", "45% context left"
const CONTEXT_PERCENT = /(?:context(?:\s+(?:left|remaining|used))?|上下文)\s*[:：]?\s*(\d{1,3})\s*%|(\d{1,3})\s*%\s*context/iu
// Token-style: "12.4k/200k tokens"
const CONTEXT_TOKENS = /(\d+(?:\.\d+)?)\s*([km])?\s*\/\s*(\d+(?:\.\d+)?)\s*([km])\s*(?:tokens)?/iu

const scale = (value: number, unit?: string) => unit?.toLowerCase() === 'm' ? value * 1e6 : unit?.toLowerCase() === 'k' ? value * 1e3 : value

/** Looks only at the tail: the status line lives at the bottom of the screen. */
export function parseSessionInfo(screen: string): SessionInfo {
  if (!screen) return {}
  const tail = screen.split(/\r?\n/).slice(-12).join('\n')
  const info: SessionInfo = {}

  const model = MODEL.exec(tail)?.[1]
  if (model) info.model = model.replace(/[)）\],，。]+$/, '')

  const thinking = THINKING.exec(tail)?.[1]
  if (thinking) info.thinking = thinking.toLowerCase()

  const percent = CONTEXT_PERCENT.exec(tail)
  if (percent) {
    const value = Number(percent[1] ?? percent[2])
    if (Number.isFinite(value) && value >= 0 && value <= 100) {
      info.contextLabel = `${value}%`
      // "left" wording is inverted so the ratio always means "used".
      info.contextRatio = /left|remaining/i.test(percent[0]) ? 1 - value / 100 : value / 100
    }
  }

  if (info.contextRatio === undefined) {
    const tokens = CONTEXT_TOKENS.exec(tail)
    if (tokens) {
      const used = scale(Number(tokens[1]), tokens[2])
      const total = scale(Number(tokens[3]), tokens[4])
      if (total > 0 && used >= 0 && used <= total * 1.01) {
        info.contextRatio = Math.min(1, used / total)
        info.contextLabel = `${Math.round(used / 1000)}k/${Math.round(total / 1000)}k`
      }
    }
  }

  return info
}
