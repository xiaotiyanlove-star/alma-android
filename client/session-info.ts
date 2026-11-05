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

/** Merges facts scraped from a narrow detail read with the authoritative
 * desktop settings. The detail line is deliberately separate from the full
 * terminal screenshot: a missing footer must not erase a model already shown. */
export function detailInfo(detail: string, settings?: { model?: string | null; effort?: string | null } | null): HeaderInfo {
  return headerInfo(detail, settings)
}

/** Merge a narrow detail read with the current terminal without letting a
 * long screen push the detail line outside the parser's tail window. */
export function mergedHeaderInfo(detail: string | undefined, screen: string | undefined, settings?: { model?: string | null; effort?: string | null } | null): HeaderInfo {
  const fromDetail = parseSessionInfo(detail ?? '')
  const fromScreen = headerInfo(screen ?? '', settings)
  return {
    ...fromScreen,
    ...(fromScreen.model === undefined && fromDetail.model ? { model: fromDetail.model } : {}),
    ...(fromScreen.effort === undefined && fromDetail.thinking ? { effort: fromDetail.thinking } : {}),
    ...(fromScreen.contextRatio === undefined && fromDetail.contextRatio !== undefined ? {
      contextRatio: fromDetail.contextRatio,
      contextLabel: fromDetail.contextLabel,
    } : {}),
    ...(fromScreen.thinking === undefined && fromDetail.thinking ? { thinking: fromDetail.thinking } : {}),
  }
}
// The value must be a single word with no colon: "model:  context: 400%"
// has an empty model, and must not borrow the next label.
const MODEL = /(?:^|[\s│|])(?:model|模型)\s*[:：][ \t]?([^\s│|:：][^\s│|]{1,59})/iu
// Pi's footer has no `model:` label: context and token counters on the left,
// model id on the right, optionally followed by a thinking level. It can also
// start with a provider group such as `(openai) gpt-5.`.
const PI_MODEL = /(?:^|\n)\s*[^\n]*?(?:↑|↓|R\s*\d|W\s*\d|\d+(?:\.\d+)?%\/|\?\/)[^\n]*?\s{2,}(?:\([^)]+\)\s+)?([a-zA-Z0-9][a-zA-Z0-9._:/-]{1,80})(?:\s*(?:•|→)\s*((?:xhigh|max|high|medium|low|minimal|off)(?:\s+thinking)?))?\s*$/imu
// Codex and compatible terminals print the selected model without a label,
// commonly as `model / reasoning`; accept only known model-like ids.
const UNLABELLED_MODEL = /\b((?:gpt|o[1-9]|codex|claude|gemini|glm|deepseek|qwen|kimi|llama)[a-zA-Z0-9._:/-]{1,60})(?:\s*[/•]\s*(minimal|low|medium|high|xhigh|max|off))?\b/iu
const THINKING = /(?:^|[\s│|])(?:thinking|reasoning|思考)\s*[:：]\s*([a-z]+|开|关)/iu
// "context left: 74%", "context: 45%", "上下文 45%", "45% context left"
const CONTEXT_PERCENT = /(?:context(?:\s+(?:left|remaining|used))?|上下文)\s*[:：]?\s*(\d{1,3}(?:\.\d+)?)\s*%|(\d{1,3}(?:\.\d+)?)\s*%\s*context/iu
// Pi prints its context as `41.2%/200k` next to the token counters.
const PI_CONTEXT_PERCENT = /(?:^|\s)(\d{1,3}(?:\.\d+)?)%\/\d+(?:\.\d+)?[kM]\b/iu
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
  if (!info.model) {
    const pi = PI_MODEL.exec(tail)
    const scraped = pi?.[1] ?? UNLABELLED_MODEL.exec(tail)?.[1]
    if (scraped && !/^(?:codex|claude|pi)$/i.test(scraped)) info.model = scraped
    const inlineThinking = pi?.[2] ?? UNLABELLED_MODEL.exec(tail)?.[2]
    if (inlineThinking) info.thinking = inlineThinking.trim().toLowerCase()
  }

  const thinking = THINKING.exec(tail)?.[1]
  if (thinking) info.thinking = thinking.toLowerCase()

  const percent = CONTEXT_PERCENT.exec(tail)
  if (percent) {
    const raw = percent[1] ?? percent[2]
    const value = Number(raw)
    if (Number.isFinite(value) && value >= 0 && value <= 100) {
      info.contextLabel = `${value}%`
      // "left" wording is inverted so the ratio always means "used".
      info.contextRatio = /left|remaining/i.test(percent[0]) ? 1 - value / 100 : value / 100
    }
  }

  if (info.contextRatio === undefined) {
    const piPercent = PI_CONTEXT_PERCENT.exec(tail)
    if (piPercent) {
      const value = Number(piPercent[1])
      if (value >= 0 && value <= 100) {
        info.contextLabel = `${value}%`
        info.contextRatio = value / 100
      }
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
