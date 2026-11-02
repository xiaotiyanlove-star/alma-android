/**
 * Running background agents, read from the transcript.
 *
 * Claude Code records a dispatched subagent as a tool row named `Agent` with
 * `background: true`, `done: false` while it runs, and the short title in
 * `input.description`. Nothing else in the Herdr API reports them, so this is
 * the only structured source; the terminal prints a similar list but in a
 * layout that differs per agent and per version.
 */
import type { ChatItem } from './model'

export interface RunningAgent {
  /** Tool-use id: stable per dispatch, unique within the session. */
  id: string
  title: string
  /** e.g. "general-purpose"; absent when the agent did not name one. */
  kind?: string
  /** Whether the agent is running in the background rather than blocking. */
  background: boolean
}

/** Tool names that mean "a subagent was dispatched", newest naming first. */
const AGENT_TOOL_NAMES = new Set(['agent', 'task'])

function toolName(item: ChatItem): string {
  return (item.tool?.name ?? '').trim().toLowerCase()
}

function inputRecord(item: ChatItem): Record<string, unknown> {
  const input = item.tool?.input
  if (input && typeof input === 'object' && !Array.isArray(input)) return input as Record<string, unknown>
  return {}
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

/**
 * Every dispatched agent still running, in transcript order.
 * A row is running when `done` is not true; agents that finished disappear.
 */
export function runningAgents(items: ChatItem[]): RunningAgent[] {
  const out: RunningAgent[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const tool = item.tool
    if (!tool || !AGENT_TOOL_NAMES.has(toolName(item))) continue
    if (tool.done === true) continue
    const id = tool.id ?? item.id
    if (!id || seen.has(id)) continue
    seen.add(id)
    const input = inputRecord(item)
    out.push({
      id,
      title: firstString(input, ['description', 'subagent_type']) ?? item.summary?.trim() ?? '后台 agent',
      kind: firstString(input, ['subagent_type']),
      background: tool.background === true,
    })
  }
  return out
}

/** Only the ones the user should be told about: explicitly backgrounded. */
export function backgroundAgents(items: ChatItem[]): RunningAgent[] {
  return runningAgents(items).filter((agent) => agent.background)
}

/** Compact label for the session header, e.g. "2 个 agent 运行中". */
export function agentsLabel(count: number): string | null {
  return count > 0 ? `${count}` : null
}
