/**
 * Recognises the numbered menus coding agents draw in a terminal (permission
 * prompts, "run this command?" questions, multi-select lists).
 *
 * This is deliberately conservative: a wrong parse turns into a wrong tap.
 * Rules mirror what Alma's own client accepts, plus a strictness check that
 * the caller performs before acting (see `samePrompt`).
 */

export interface PromptOption {
  number: number
  label: string
  /** Cursor is on this option right now. */
  selected: boolean
  /** Checkbox state for multi-select menus; null for single-choice menus. */
  checked: boolean | null
}

export interface Prompt {
  question: string
  options: PromptOption[]
  /** Optional trailing "Submit"/"Next" row. */
  submit: { row: number; selected: boolean } | null
  /** Index into `options`, or -1 when nothing is highlighted. */
  cursor: number
  /** Exact lines this prompt was parsed from, used to detect drift. */
  signature: string
}

const FRAME = /^[│┃║\s]+|[│┃║\s]+$/g
const OPTION = /^([❯›>]\s*)?(\d{1,2})[.)]\s+(.+)$/u
const CLOSING = /^([❯›>]\s*)?(Submit|Next)$/u
const BOX = /^\[([ xX✓✔☒])\]\s+/u
const MAX_OPTIONS = 12
const LOOKBACK = 40

/** Prompt text shorter than this is too generic to safely turn into buttons. */
const MIN_LABEL = 3

export function parsePrompt(screen: string): Prompt | null {
  const lines = screen.split(/\r?\n/).slice(-LOOKBACK).map((line) => line.replace(FRAME, ''))
  let best: { start: number; options: PromptOption[]; submit: Prompt['submit'] } | null = null
  let current: PromptOption[] = []
  let submit: Prompt['submit'] = null
  let start = 0

  lines.forEach((line, index) => {
    const close = CLOSING.exec(line)
    if (close && current.length >= 2) {
      submit = { row: index, selected: Boolean(close[1]) }
      if (current.length >= 2) best = { start, options: [...current], submit }
      return
    }
    const match = OPTION.exec(line)
    if (!match) return
    const number = Number(match[2])
    if (number === 1) {
      current = []
      submit = null
      start = index
    } else if (number !== current.length + 1) {
      // Numbering restarted or skipped: only a contiguous 1..n run is a menu.
      current = []
      submit = null
      return
    }
    let label = match[3]
    let checked: boolean | null = null
    const box = BOX.exec(label)
    if (box) {
      checked = box[1] !== ' '
      label = label.slice(box[0].length)
    }
    current = [...current, { number, label: label.trim(), selected: Boolean(match[1]), checked }]
    if (current.length >= 2 && current.length <= MAX_OPTIONS) best = { start, options: [...current], submit: null }
  })

  if (!best) return null
  const found: { start: number; options: PromptOption[]; submit: Prompt['submit'] } = best

  // A real menu always shows either a cursor or checkbox state. A plain
  // numbered list in agent output has neither, and must never become buttons.
  const hasCursorOrBoxes = found.options.some((option) => option.selected || option.checked !== null)
  if (!hasCursorOrBoxes) return null

  // Every option must carry real text; an empty or stub label means this is
  // probably not a menu at all (progress output, a numbered list in prose).
  if (found.options.some((option) => option.label.length < MIN_LABEL)) return null

  const above = lines.slice(0, found.start)
  const question = [...above].reverse().find((line) => line.trim() && !/[─━═╭╮╰╯]/.test(line))?.trim()
  if (!question) return null

  const cursor = found.options.findIndex((option) => option.selected)
  return {
    question,
    options: found.options,
    submit: found.submit,
    cursor,
    signature: found.options.map((option) => `${option.number}:${option.label}`).join('\n'),
  }
}

/** True when two parses describe the same menu with the same highlighted row. */
export function samePrompt(a: Prompt | null, b: Prompt | null): boolean {
  if (!a || !b) return a === b
  return a.signature === b.signature && a.cursor === b.cursor && a.question === b.question
}

/**
 * Keys needed to move the terminal cursor from `from` to `to`.
 * Returns null when the distance cannot be known (cursor missing).
 */
export function moveKeys(from: number, to: number): string[] | null {
  if (from < 0 || to < 0 || from === to) return null
  const step = to > from ? 'down' : 'up'
  return Array.from({ length: Math.abs(to - from) }, () => step)
}

/** Multi-select rows toggle with space; single-choice rows commit with Enter. */
export function needsSpace(option: PromptOption): boolean {
  return option.checked !== null
}
