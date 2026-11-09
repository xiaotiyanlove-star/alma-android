/**
 * Narrowing for the small set of long-lived desktop responses.
 *
 * The tunnel authenticates the peer, but it does not make a payload safe to
 * spread into UI state. These parsers keep malformed or future-shaped fields
 * out of the screens while preserving fields the current model understands.
 */
import type { ChatItem, ImageRef, Pane, Snapshot, Tab, Workspace } from './model'
import type { UploadResponse } from '../session/attachments'

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function image(value: unknown): ImageRef | undefined {
  const source = record(value)
  const url = text(source?.url)
  if (!source || !url) return undefined
  return { url, ...(text(source.mediaType) ? { mediaType: text(source.mediaType) } : {}) }
}

function images(value: unknown): ImageRef[] {
  return Array.isArray(value) ? value.map(image).filter((item): item is ImageRef => Boolean(item)) : []
}

export function readChatItem(value: unknown): ChatItem | undefined {
  const source = record(value)
  const id = text(source?.id)
  const kind = text(source?.kind)
  if (!source || !id || !kind) return undefined
  const tool = record(source.tool)
  return {
    id, kind,
    ...(text(source.text) !== undefined ? { text: text(source.text) } : {}),
    ...(text(source.summary) !== undefined ? { summary: text(source.summary) } : {}),
    ...(text(source.from) !== undefined ? { from: text(source.from) } : {}),
    ...(text(source.time) !== undefined ? { time: text(source.time) } : {}),
    ...(source.images !== undefined ? { images: images(source.images) } : {}),
    ...(tool ? { tool: {
      ...(text(tool.id) ? { id: text(tool.id) } : {}),
      ...(text(tool.name) ? { name: text(tool.name) } : {}),
      ...(tool.input !== undefined ? { input: tool.input } : {}),
      ...(tool.output !== undefined ? { output: tool.output } : {}),
      ...(typeof tool.done === 'boolean' ? { done: tool.done } : {}),
      ...(typeof tool.background === 'boolean' ? { background: tool.background } : {}),
      ...(tool.images !== undefined ? { images: images(tool.images) } : {}),
      ...(tool.result_images !== undefined ? { result_images: images(tool.result_images) } : {}),
    } } : {}),
  }
}

export interface ChatPage {
  sessionId?: string
  items: ChatItem[]
  start: number
  end: number
  queued: { id: string; text: string }[]
  settings?: { model?: string | null; effort?: string | null }
  error?: { code?: string; message?: string }
}

export function mergeChatItems(current: ChatItem[], incoming: ChatItem[], prepend = false): ChatItem[] {
  const all = new Map(current.map((item) => [item.id, item]))
  for (const item of incoming) all.set(item.id, item)
  const order = prepend ? [...incoming, ...current] : [...current, ...incoming]
  return [...new Set(order.map((item) => item.id))].map((id) => all.get(id)!)
}

export function readChatPage(value: unknown): ChatPage {
  const source = record(value)
  const page = record(source?.page)
  const error = record(source?.error)
  const queued = Array.isArray(source?.queued) ? source.queued.flatMap((entry) => {
    const item = record(entry)
    const id = text(item?.id)
    const body = text(item?.text)
    return id && body !== undefined ? [{ id, text: body }] : []
  }) : []
  const settings = record(source?.settings)
  return {
    ...(text(source?.session_id) ? { sessionId: text(source?.session_id) } : {}),
    items: Array.isArray(page?.items) ? page.items.map(readChatItem).filter((item): item is ChatItem => Boolean(item)) : [],
    start: Number.isInteger(page?.start) ? Number(page?.start) : 0,
    end: Number.isInteger(page?.end) ? Number(page?.end) : 0,
    queued,
    ...(settings ? { settings: {
      ...(typeof settings.model === 'string' || settings.model === null ? { model: settings.model as string | null } : {}),
      ...(typeof settings.effort === 'string' || settings.effort === null ? { effort: settings.effort as string | null } : {}),
    } } : {}),
    ...(error && (text(error.code) || text(error.message)) ? { error: {
      ...(text(error.code) ? { code: text(error.code) } : {}),
      ...(text(error.message) ? { message: text(error.message) } : {}),
    } } : {}),
  }
}

export function readQueued(value: unknown): { id: string; text: string }[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const item = record(entry)
    const id = text(item?.id)
    const body = text(item?.text)
    return id && body !== undefined ? [{ id, text: body }] : []
  })
}

function pane(value: unknown): Pane | undefined {
  const source = record(value)
  const paneId = text(source?.pane_id)
  const workspaceId = text(source?.workspace_id)
  const tabId = text(source?.tab_id)
  if (!source || !paneId || !workspaceId || !tabId) return undefined
  const agentSession = record(source.agent_session)
  return {
    pane_id: paneId, workspace_id: workspaceId, tab_id: tabId,
    ...(text(source.label) ? { label: text(source.label) } : {}),
    ...(text(source.tab_label) ? { tab_label: text(source.tab_label) } : {}),
    ...(text(source.agent) ? { agent: text(source.agent) } : {}),
    ...(text(source.agent_status) ? { agent_status: text(source.agent_status) } : {}),
    ...(text(source.terminal_title_stripped) ? { terminal_title_stripped: text(source.terminal_title_stripped) } : {}),
    ...(text(source.cwd) ? { cwd: text(source.cwd) } : {}),
    ...(text(source.foreground_cwd) ? { foreground_cwd: text(source.foreground_cwd) } : {}),
    ...(text(source.git_branch) ? { git_branch: text(source.git_branch) } : {}),
    ...(text(source.branch) ? { branch: text(source.branch) } : {}),
    ...(agentSession ? { agent_session: {
      ...(text(agentSession.value) ? { value: text(agentSession.value) } : {}),
      ...(text(agentSession.agent) ? { agent: text(agentSession.agent) } : {}),
    } } : {}),
  }
}

export function readSnapshot(value: unknown): Snapshot | undefined {
  const source = record(value)
  if (!Array.isArray(source?.panes) || !Array.isArray(source.workspaces)) return undefined
  const panes = source.panes.map(pane).filter((item): item is Pane => Boolean(item))
  const workspaces = source.workspaces.flatMap((entry): Workspace[] => {
    const item = record(entry)
    const id = text(item?.workspace_id)
    if (!item || !id) return []
    return [{
      workspace_id: id,
      ...(text(item.label) ? { label: text(item.label) } : {}),
      ...(text(item.name) ? { name: text(item.name) } : {}),
      ...(text(item.cwd) ? { cwd: text(item.cwd) } : {}),
    }]
  })
  const tabs = Array.isArray(source.tabs) ? source.tabs.flatMap((entry): Tab[] => {
    const item = record(entry)
    const id = text(item?.tab_id)
    const workspaceId = text(item?.workspace_id)
    return item && id && workspaceId ? [{ tab_id: id, workspace_id: workspaceId, ...(text(item.label) ? { label: text(item.label) } : {}) }] : []
  }) : undefined
  return { panes, workspaces, ...(tabs ? { tabs } : {}) }
}

export function readMediaResponse(value: unknown): { bytes: Uint8Array; contentType: string } | undefined {
  const source = record(value)
  if (!source || !(source.bytes instanceof Uint8Array) || typeof source.contentType !== 'string') return undefined
  if (!/^image\/[a-z0-9.+-]+$/i.test(source.contentType)) return undefined
  return { bytes: source.bytes, contentType: source.contentType }
}

/** The upload route is a mutation and its metadata becomes the new message.
 * Rejecting a malformed 2xx here prevents a half-usable path from escaping to
 * the composer or the local-image cache. */
export function readUploadResponse(value: unknown): UploadResponse | undefined {
  const source = record(value)
  if (!source) return undefined
  const filePath = text(source.filePath)
  const filename = text(source.filename)
  const size = typeof source.size === 'number' && Number.isFinite(source.size) && source.size >= 0 ? source.size : undefined
  const error = text(source.error)
  if (!filePath) return undefined
  return {
    ...(filePath ? { filePath } : {}),
    ...(filename ? { filename } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(error ? { error } : {}),
  }
}
