/**
 * Slash commands offered in the composer.
 *
 * These are the agent's own REPL commands, not a Herdr API: sending one is the
 * same as the user typing it in the terminal, and the reply comes back on the
 * terminal stream. So each entry declares what it does to the session, and the
 * destructive ones are deliberately absent from the shipped list.
 */

export type CommandRisk = 'read' | 'menu'

export interface SlashCommand {
  /** Without the leading slash. */
  name: string
  /** What the user sees. */
  label: string
  /** One line, shown under the label in the picker. */
  hint: string
  /**
   * `read`  – prints information and returns to the prompt.
   * `menu`  – opens an interactive menu that needs another step.
   */
  risk: CommandRisk
  /** Agents known to accept it. */
  agents: string[]
}

/**
 * First release: only what cannot destroy a conversation. Anything that clears,
 * compacts or rewinds is intentionally not here.
 */
export const COMMANDS: SlashCommand[] = [
  {
    name: 'status',
    label: '/status',
    hint: '会话状态与当前配置',
    risk: 'read',
    agents: ['claude', 'codex', 'pi'],
  },
  {
    name: 'cost',
    label: '/cost',
    hint: '本次会话的用量与花费',
    risk: 'read',
    agents: ['claude'],
  },
  {
    name: 'context',
    label: '/context',
    hint: '上下文占用了多少',
    risk: 'read',
    agents: ['claude'],
  },
  {
    name: 'model',
    label: '/model',
    hint: '切换模型（会打开选择菜单）',
    risk: 'menu',
    agents: ['claude', 'codex', 'pi'],
  },
  {
    name: 'help',
    label: '/help',
    hint: '列出该 agent 支持的命令',
    risk: 'read',
    agents: ['claude', 'codex', 'pi'],
  },
]

/** Commands safe to show for a given agent. */
export function commandsFor(agent: string | undefined, known: string[] = COMMANDS.map((c) => c.name)): SlashCommand[] {
  const kind = (agent ?? '').toLowerCase()
  return COMMANDS.filter((command) => {
    if (!known.includes(command.name)) return false
    if (!kind) return true
    return command.agents.some((name) => kind.includes(name))
  })
}

/**
 * Detects a command being typed. Returns the query when the composer holds
 * exactly one slash token with no space yet, so the picker closes as soon as
 * the user starts writing arguments.
 */
export function slashQuery(text: string): string | null {
  const match = /^\/([a-zA-Z]*)$/.exec(text)
  return match ? match[1].toLowerCase() : null
}

/** Case-insensitive prefix filter for the picker. */
export function filterCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return commands
  return commands.filter((command) => command.name.toLowerCase().startsWith(needle))
}
