/**
 * Session identity, subscriptions, refresh pacing and transcript warmup.
 *
 * The loader owns only session lifetime. Transports, host runtimes, mutation
 * uncertainty, LAN discovery and host persistence stay in Controller.
 */
import type { ChatItem, SessionState, Snapshot } from '../core/model'
import { sessionDelay } from '../connection/backoff'
import { t } from '../platform/i18n'
import { mergeChatItems, readChatItem, readChatPage, readQueued } from '../core/protocol'
import { readSettings, settingsChanged, transcriptGap } from './session-rules'
import { TranscriptCache } from './transcript-cache'
import type { TunnelSocket } from '../connection/transport'

export interface SessionPage {
  sessionId?: string
  items: ChatItem[]
  start: number
  end: number
  queued: SessionState['queued']
  settings?: SessionState['settings']
  error?: { code?: string; message?: string }
}

export interface SessionTransport {
  request<T>(path: string): Promise<T>
  subscribe(path: string, receive: (event: any) => void, onClose: () => void): TunnelSocket
}

export interface SessionLoaderHost {
  getSession(): SessionState | undefined
  setSession(session: SessionState | undefined): void
  patchSession(epoch: number, patch: Partial<SessionState>): void
  getRuntime(hostId: string): SessionTransport | undefined
  getSnapshot(hostId: string): Snapshot | undefined
  request<T>(hostId: string, path: string): Promise<T>
  readScreen(): Promise<void>
  prefetch(hostId: string, paneId: string): void
  message(error: unknown): string
}

export class SessionLoader {
  epoch = 0
  identity = 0
  private sockets: TunnelSocket[] = []
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private refresh?: { epoch: number; generation: number; promise: Promise<void> }
  private generation = 0
  private failures = 0

  constructor(
    private readonly host: SessionLoaderHost,
    readonly transcripts = new TranscriptCache(),
  ) {}

  /** Cancels every stale identity and release resource owned by it. */
  stop(): void {
    ++this.epoch
    ++this.identity
    ++this.generation
    this.refresh = undefined
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    for (const socket of this.sockets.splice(0)) socket.close()
  }

  async open(hostId: string, paneId: string): Promise<void> {
    const previous = this.host.getSession()
    if (previous) this.store(previous)
    this.stop()
    const warm = this.transcripts.take(hostId, paneId)
    this.host.setSession({
      hostId, paneId,
      items: warm?.items ?? [],
      start: warm?.start ?? -1,
      end: warm?.end ?? 0,
      queued: warm?.queued ?? [],
      loading: !warm,
      loadingOlder: false,
      screen: warm?.screen ?? '',
      details: warm?.details ?? '',
      unsupported: false,
      sentMessage: false,
      sending: false,
      ...(warm?.sessionId ? { sessionId: warm.sessionId } : {}),
      ...(warm?.settings ? { settings: warm.settings } : {}),
    })
    await this.refreshSession()
    if (this.host.getSession()?.hostId === hostId && this.host.getSession()?.paneId === paneId) {
      this.host.prefetch(hostId, paneId)
    }
  }

  /** Captures the transcript on screen, so a later return can paint from it. */
  private store(session: SessionState): void {
    if (!session.items.length) return
    this.transcripts.put(session.hostId, session.paneId, {
      sessionId: session.sessionId,
      items: session.items,
      start: session.start,
      end: session.end,
      queued: session.queued,
      screen: session.screen,
      details: session.details,
      settings: session.settings,
      at: Date.now(),
    })
  }

  async reload(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    ++this.generation
    this.refresh = undefined
    await this.refreshSession()
  }

  private refreshSession(): Promise<void> {
    if (this.refresh?.epoch === this.epoch && this.refresh.generation === this.generation) return this.refresh.promise
    const epoch = this.epoch
    const generation = this.generation
    const promise = this.load(epoch, generation).finally(() => {
      if (epoch === this.epoch && generation === this.generation && this.refresh?.promise === promise) this.refresh = undefined
    })
    this.refresh = { epoch, generation, promise }
    return promise
  }

  private later(epoch: number, fixed?: number): void {
    const delay = fixed ?? sessionDelay(this.failures)
    if (fixed === undefined) this.failures++
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (epoch === this.epoch) void this.refreshSession()
    }, delay)
    this.timers.add(timer)
  }

  private current(epoch: number, generation = this.generation): boolean {
    return epoch === this.epoch && generation === this.generation
  }

  private async load(epoch: number, generation: number): Promise<void> {
    const current = this.host.getSession()
    if (!current || !this.current(epoch, generation)) return
    const transport = this.host.getRuntime(current.hostId)
    if (!transport) {
      this.host.patchSession(epoch, { loading: false })
      return
    }
    for (const socket of this.sockets.splice(0)) socket.close()
    this.host.patchSession(epoch, { loading: current.items.length === 0, error: undefined })
    try {
      const page = readChatPage(await this.host.request<unknown>(current.hostId,
        `/api/herdr/chat?pane=${encodeURIComponent(current.paneId)}&limit=150`))
      if (!this.current(epoch, generation)) return
      if (page.error?.code || page.error?.message) {
        const code = page.error.code || ''
        if (['unsupported_agent', 'no_session', 'no_agent_session', 'transcript_not_found'].includes(code)) {
          const pane = this.host.getSnapshot(current.hostId)?.panes.find((item) => item.pane_id === current.paneId)
          const gap = transcriptGap(code, pane, current.sentMessage)
          this.host.patchSession(epoch, { unsupported: true, gap, loading: false, error: undefined })
          this.later(epoch, gap === 'terminal' || gap === 'unsupported' ? 15_000 : 4000)
        } else throw new Error(page.error.message || t('无法读取会话'))
      } else {
        this.failures = 0
        const same = current.sessionId === page.sessionId
        const items = same ? mergeChatItems(current.items, page.items) : mergeChatItems([], page.items)
        const cursor = same ? current.end : page.end
        const settings = readSettings(page.settings)
        this.host.patchSession(epoch, {
          items, sessionId: page.sessionId,
          start: same && current.start >= 0 ? current.start : page.start,
          end: cursor, queued: page.queued ?? [], loading: false, unsupported: false, gap: undefined,
          ...(settings ? { settings } : {}),
        })
        const chat = transport.subscribe(`/ws/herdr/chat?pane=${encodeURIComponent(current.paneId)}&from=${cursor}`, (event) => {
          if (!this.current(epoch, generation)) return
          const open = this.host.getSession()
          if (!open) return
          if (event.type === 'items' && Array.isArray(event.items)) {
            const items = event.items
              .map((item: unknown) => readChatItem(item))
              .filter((item: ChatItem | undefined): item is ChatItem => Boolean(item))
            this.host.patchSession(epoch, { items: mergeChatItems(open.items, items), end: Number(event.end) || open.end })
          }
          if (event.type === 'queued' && Array.isArray(event.queued)) this.host.patchSession(epoch, { queued: readQueued(event.queued) })
          if (event.type === 'settings') {
            const next = readSettings(event.settings)
            if (next && (!open.settings || settingsChanged(open.settings, next))) this.host.patchSession(epoch, { settings: next })
          }
          if (event.type === 'session_changed') {
            ++this.identity
            this.host.patchSession(epoch, { items: [], queued: [], sessionId: undefined, end: 0, start: -1, loading: true, uncertain: undefined, settings: undefined, details: undefined })
            this.later(epoch)
          }
        }, () => { if (this.current(epoch, generation)) this.later(epoch) })
        this.sockets.push(chat)
      }
      this.sockets.push(transport.subscribe(`/ws/herdr/screen?pane=${encodeURIComponent(current.paneId)}`, (event) => {
        if (!this.current(epoch, generation)) return
        if (event.type === 'screen') this.host.patchSession(epoch, { screen: typeof event.read?.text === 'string' ? event.read.text : this.host.getSession()?.screen ?? '' })
      }, () => { if (this.current(epoch, generation)) this.later(epoch) }))
      await this.host.readScreen()
    } catch (error) {
      this.host.patchSession(epoch, { loading: false, error: this.host.message(error) })
      if (this.current(epoch, generation)) this.later(epoch)
    }
  }

  async loadOlder(): Promise<void> {
    const current = this.host.getSession()
    const epoch = this.epoch, identity = this.identity
    if (!current || current.loadingOlder || current.start <= 0) return
    this.host.patchSession(epoch, { loadingOlder: true })
    try {
      const page = readChatPage(await this.host.request<unknown>(current.hostId,
        `/api/herdr/chat?pane=${encodeURIComponent(current.paneId)}&before=${current.start}&limit=150`))
      if (page.error) throw new Error(page.error.message || t('历史读取失败'))
      if (epoch !== this.epoch || identity !== this.identity || page.sessionId !== this.host.getSession()?.sessionId) return
      const open = this.host.getSession()!
      this.host.patchSession(epoch, { items: mergeChatItems(open.items, page.items, true), start: page.start })
    } catch (error) {
      if (identity === this.identity) this.host.patchSession(epoch, { error: this.host.message(error) })
      throw error
    } finally {
      this.host.patchSession(epoch, { loadingOlder: false })
    }
  }
}
