/**
 * Turns a transcript into what the reader should see.
 *
 * What an agent does between two answers is scaffolding: dozens of reads, a
 * few edits, a shell command, and the running commentary it thinks out loud.
 * Shown row by row it buries the thing the user came for — the answer — under
 * a wall of tool calls. So a run of work between two answers is folded into one
 * line that says what happened in counts ("ran 24 commands, edited 1 file, read
 * 27 files"), and opens in layers: the line, then the steps, then each step's
 * input and output.
 *
 * Answers and pictures are never folded. They are what the user reads.
 */
import type { ChatItem } from './model'

/** What a step was, in the terms the summary line counts. */
export type WorkKind = 'command' | 'edit' | 'read' | 'search' | 'fetch' | 'subagent' | 'other'

export interface WorkCount {
  kind: WorkKind
  count: number
}

export type TimelineEntry =
  | { kind: 'item'; key: string; item: ChatItem }
  | { kind: 'work'; key: string; items: ChatItem[]; running: boolean; counts: WorkCount[] }

/**
 * The desktop's own classification, so the phone's summary and the desktop's
 * agree on what "edited a file" means.
 *
 * Tool names arrive lower-cased from the transcript; anything unrecognised is
 * counted as "other step" rather than guessed at, because a wrong count reads
 * as a wrong claim about what happened.
 */
const TOOL_KIND: Record<string, WorkKind> = {
  bash: 'command', shell: 'command', exec_command: 'command', local_shell: 'command', bashoutput: 'command',
  edit: 'edit', write: 'edit', multiedit: 'edit', apply_patch: 'edit', notebookedit: 'edit',
  read: 'read', read_file: 'read', view: 'read',
  grep: 'search', glob: 'search', find: 'search', ls: 'search', search: 'search',
  webfetch: 'fetch', websearch: 'fetch', web_search: 'fetch',
  task: 'subagent', agent: 'subagent',
}

export function workKind(toolName: string | undefined): WorkKind {
  if (!toolName) return 'other'
  return TOOL_KIND[toolName.trim().toLowerCase()] ?? 'other'
}

/** Tallies a run into the counts shown on the folded line, in a fixed order. */
export function countWork(items: ChatItem[]): WorkCount[] {
  const totals = new Map<WorkKind, number>()
  for (const item of items) {
    // A thinking row is not a step with a name; it counts as the agent's own
    // reasoning and is shown inside the group, not in the summary.
    if (!item.tool) continue
    const kind = workKind(item.tool.name)
    totals.set(kind, (totals.get(kind) ?? 0) + 1)
  }
  const order: WorkKind[] = ['command', 'edit', 'read', 'search', 'fetch', 'subagent', 'other']
  return order.filter((kind) => totals.has(kind)).map((kind) => ({ kind, count: totals.get(kind)! }))
}

/**
 * A row that belongs in the folded run.
 *
 * Tool calls always do. `thinking` is the agent's running commentary: it is
 * process, not answer, and the official client folds it for the same reason.
 * A row that also carries `text` is the answer riding on a tool row, so it
 * stays visible — folding it would hide what the user is waiting for.
 */
function isWorkRow(item: ChatItem): boolean {
  if (item.tool) return !item.text && !item.summary
  return item.kind === 'thinking'
}

/** True when this row is the agent's own reasoning rather than a tool call. */
export function isThinking(item: ChatItem): boolean {
  return item.kind === 'thinking'
}

/**
 * Groups runs of consecutive work rows. A run of one is still folded: a single
 * tool call is the normal shape of "the agent did one thing", and showing it
 * inline reintroduces exactly the noise this exists to remove.
 */
export function timeline(items: ChatItem[]): TimelineEntry[] {
  const out: TimelineEntry[] = []
  let run: ChatItem[] = []

  const flush = () => {
    if (!run.length) return
    out.push({
      kind: 'work',
      key: `work:${run[0].id}`,
      items: run,
      // Any unfinished step means the burst is still going.
      running: run.some((item) => item.tool && item.tool.done !== true),
      counts: countWork(run),
    })
    run = []
  }

  for (const item of items) {
    if (isWorkRow(item)) { run.push(item); continue }
    flush()
    out.push({ kind: 'item', key: item.id, item })
  }
  flush()
  return out
}

/**
 * Image paths written in a message body.
 *
 * An absolute path (or `~/…`) ending in a known image extension, not part of a
 * longer word, and not inside backticks. A transcript that pastes
 * `/Users/me/shot.png` shows the picture instead of only the path, which is how
 * a screenshot an agent took mid-task actually reaches the user.
 *
 * Spaces are allowed inside the path. The desktop's own client stops at the
 * first space, and that is exactly why the pictures in this app's transcripts
 * never appeared: every one of them lives under
 * `/Users/<name>/Library/Application Support/alma/gallery_cache/`. A path is
 * ended by a quote, bracket, backtick or the end of the line, not by a space —
 * and the trailing `(?![A-Za-z0-9_-]|\.[A-Za-z0-9])` keeps prose from being
 * swallowed into the extension.
 */
const IMAGE_PATH = /(?:^|[^A-Za-z0-9_./~\\`-])(~?\/(?!\/)[^`)\]"'<>，。；、！？）」》\n]*?\.(?:png|jpe?g|gif|webp|heic))(?![A-Za-z0-9_-]|\.[A-Za-z0-9])/gi

export function imagePaths(text: string | undefined): string[] {
  if (!text) return []
  const found = new Set<string>()
  for (const match of text.matchAll(IMAGE_PATH)) found.add(match[1])
  return [...found]
}

/**
 * The body with inline image paths removed, when those paths are being shown as
 * pictures underneath.
 *
 * Only the path itself goes: a sentence that named it still reads correctly,
 * and leaving the path in place would print the same thing twice.
 */
export function withoutImagePaths(text: string, paths: readonly string[]): string {
  if (!paths.length) return text
  let out = text
  for (const path of paths) out = out.split(path).join('')
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}
