import type { AppState, ChatItem, Host, SessionState, Snapshot } from './model'
import { parsePairing } from './pairing'
import { t } from './i18n'
import { MAX_RETRIES, isPermanentFailure, nextDelay, retriesLeft, stopMessage } from './backoff'
import { MAX_ATTACHMENT_BYTES, uploadRoute, type UploadResponse, type UploadedFile } from './attachments'
import { moveKeys, needsSpace, parsePrompt, samePrompt, type Prompt } from './prompt'
import { hostStorage, type HostStorage } from './storage'
import { EncryptedTunnel, OperationUncertainError, type Transport, type TunnelError, type TunnelSocket } from './transport'

type Page = { session_id?: string; page?: { items?: ChatItem[]; start?: number; end?: number }; queued?: { id: string; text: string }[]; error?: { code?: string; message?: string } }
const message = (error: unknown) => error instanceof Error ? error.message : t('请求失败')
function merge(current: ChatItem[], incoming: ChatItem[], prepend = false): ChatItem[] {
  const all = new Map(current.map((item) => [item.id, item]))
  for (const item of incoming) all.set(item.id, item)
  const order = prepend ? [...incoming, ...current] : [...current, ...incoming]
  return [...new Set(order.map((item) => item.id))].map((id) => all.get(id)!)
}
interface Runtime { transport: Transport; epoch: number; hub?: TunnelSocket; retry?: ReturnType<typeof setTimeout>; attempts: number; stopped?: 'exhausted' | 'auth' | 'unknown-host' }
export class Controller {
  private state: AppState = { hosts: [], loading: true }
  private listeners = new Set<() => void>()
  private runtimes = new Map<string, Runtime>()
  private sessionEpoch = 0
  /** Bumped whenever the transcript identity changes, so stale history pages cannot merge. */
  private sessionIdentity = 0
  private sessionSockets: TunnelSocket[] = []
  private sessionTimers = new Set<ReturnType<typeof setTimeout>>()
  private initialized?: Promise<void>
  private openingHost = false
  private initializedStorage = false
  private sessionRefresh?: Promise<void>
  constructor(private storage: HostStorage = hostStorage, private createTransport = (host: Host, status: (state: 'connecting' | 'online' | 'offline', error?: string, code?: TunnelError['code']) => void): Transport => new EncryptedTunnel(host, status)) {}
  getState = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(patch: Partial<AppState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener() }
  private patchHost(id: string, patch: Partial<AppState['hosts'][number]>) { this.publish({ hosts: this.state.hosts.map((item) => item.host.id === id ? { ...item, ...patch } : item) }) }
  private patchSession(epoch: number, patch: Partial<SessionState>) { if (epoch === this.sessionEpoch && this.state.session) this.publish({ session: { ...this.state.session, ...patch } }) }
  initialize = () => this.initialized ??= this.load()
  private async load() {
    try {
      const hosts = await this.storage.load()
      const remembered = this.storage.loadSelection ? await this.storage.loadSelection() : null
      this.initializedStorage = true
      // Reopen the desktop the user was last on; fall back to a single pairing
      // rather than silently picking the first of several.
      const selected = remembered && hosts.some((host) => host.id === remembered)
        ? remembered
        : hosts.length === 1 ? hosts[0].id : undefined
      this.publish({ hosts: hosts.map((host) => ({ host, status: 'offline', herdrOnline: false })), loading: false, selectedHostId: selected, storageWarning: this.storage.persistent ? undefined : t('浏览器预览仅在内存中保存节点；关闭页面后需要重新配对。') })
      for (const host of hosts) this.attach(host)
    } catch { this.publish({ loading: false, error: t('无法读取安全存储，未覆盖已有节点。请重新打开应用。') }) }
  }
  /** Builds a runtime with a fresh transport; a closed transport never reopens. */
  private makeRuntime(host: Host): Runtime {
    const runtime: Runtime = { transport: undefined as unknown as Transport, epoch: 0, attempts: 0 }
    runtime.transport = this.createTransport(host, (status, error, code) => {
      if (this.runtimes.get(host.id) !== runtime) return
      this.patchHost(host.id, { status, ...(status === 'online' ? {} : { herdrOnline: false }), error })
      if (status === 'offline') this.scheduleHost(host.id, runtime, code)
    })
    return runtime
  }

  private attach(host: Host) {
    const runtime = this.makeRuntime(host)
    this.runtimes.set(host.id, runtime)
    void this.connectHost(host.id, runtime)
  }
  /**
   * Bounded retry: three attempts, at most 30 s apart, then stop. Automatic
   * retrying only resumes when the app is foregrounded, the network returns,
   * or the user asks — nothing else resets the ladder.
   */
  private scheduleHost(id: string, runtime: Runtime, code?: TunnelError['code']) {
    if (runtime.retry || this.runtimes.get(id) !== runtime) return
    const permanent = isPermanentFailure(code)
    const delay = permanent ? null : nextDelay(runtime.attempts)
    if (delay === null) {
      runtime.stopped = permanent ?? 'exhausted'
      this.patchHost(id, { retriesLeft: 0, stopReason: runtime.stopped })
      return
    }
    runtime.attempts++
    this.patchHost(id, { retriesLeft: retriesLeft(runtime.attempts) })
    runtime.retry = setTimeout(() => {
      runtime.retry = undefined
      if (this.runtimes.get(id) !== runtime) return
      void this.connectHost(id, runtime)
    }, delay)
  }

  /** Clears any pending retry so a manual reconnect happens immediately. */
  private cancelRetry(runtime: Runtime) {
    if (!runtime.retry) return
    clearTimeout(runtime.retry)
    runtime.retry = undefined
  }
  private async connectHost(id: string, runtime: Runtime) {
    const epoch = ++runtime.epoch
    runtime.hub?.close()
    try {
      await runtime.transport.connect()
      const info = await runtime.transport.request<{ online: boolean }>('/api/herdr/info')
      if (this.runtimes.get(id) !== runtime || epoch !== runtime.epoch) return
      this.patchHost(id, { status: 'online', herdrOnline: info.online === true, error: info.online ? undefined : t('Alma 已连接，但 Herdr 未运行或不可用') })
      runtime.hub = runtime.transport.subscribe('/ws/herdr', (event) => {
        if (epoch !== runtime.epoch || this.runtimes.get(id) !== runtime) return
        if (event.type === 'snapshot' && Array.isArray(event.snapshot?.panes) && Array.isArray(event.snapshot?.workspaces)) this.patchHost(id, { snapshot: event.snapshot as Snapshot, herdrOnline: true, error: undefined })
        if (event.type === 'herdr') this.patchHost(id, { herdrOnline: event.online === true, error: event.online ? undefined : t('Herdr 暂时不可用') })
        if (event.type === 'status' && event.change) {
          const current = this.state.hosts.find((item) => item.host.id === id)?.snapshot
          if (current) this.patchHost(id, { snapshot: { ...current, panes: current.panes.map((pane) => pane.pane_id === event.change.pane_id ? { ...pane, agent_status: event.change.to } : pane) } })
        }
      }, () => { if (epoch === runtime.epoch) this.scheduleHost(id, runtime) })
      runtime.attempts = 0
      runtime.stopped = undefined
      this.patchHost(id, { retriesLeft: MAX_RETRIES, stopReason: undefined })
      if (this.state.session?.hostId === id) void this.refreshSession()
    } catch (error) {
      if (this.runtimes.get(id) !== runtime || epoch !== runtime.epoch) return
      this.patchHost(id, { status: 'error', herdrOnline: false, error: message(error) })
      this.scheduleHost(id, runtime)
    }
  }
  private storageQueue: Promise<unknown> = Promise.resolve()
  /** Serialize pairing writes so two concurrent removes cannot resurrect a host. */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.storageQueue.then(task, task)
    this.storageQueue = next.catch(() => undefined)
    return next
  }
  addHost = async (name: string, link: string) => {
    if (!this.initializedStorage) throw new Error(t('安全存储尚未就绪，未覆盖已有节点'))
    if (this.openingHost) throw new Error(t('正在保存节点'))
    this.openingHost = true
    try { await this.serialize(async () => this.addHostNow(name, link)) } finally { this.openingHost = false }
  }
  private async addHostNow(name: string, link: string) {
    const host = await parsePairing(name, link)
    const old = this.state.hosts.find((item) => item.host.id === host.id)?.host
    if (old) host.addedAt = old.addedAt
    const hosts = [...this.state.hosts.filter((item) => item.host.id !== host.id).map((item) => item.host), host]
    await this.storage.save(hosts)
    const previous = this.runtimes.get(host.id)
    this.runtimes.delete(host.id)
    if (previous) { clearTimeout(previous.retry); previous.hub?.close(); previous.transport.close() }
    // Always close the open session: the selected host changes, so an old pane must not stay as the mutation target.
    if (this.state.session) this.stopSession()
    this.publish({ hosts: hosts.map((item) => item.id === host.id ? { host, status: 'offline', herdrOnline: false } : this.state.hosts.find((state) => state.host.id === item.id)!), selectedHostId: host.id, selectedPaneId: undefined, session: undefined, error: undefined })
    this.attach(host)
  }
  /**
   * Uploads one file to the desktop and returns its absolute path.
   * The desktop stores it under a content-hash name, so the returned path is
   * authoritative rather than the name the user picked.
   */
  uploadAttachment = async (hostId: string, file: { name: string; type: string; bytes: Uint8Array }): Promise<UploadedFile> => {
    const runtime = this.runtimes.get(hostId)
    if (!runtime) throw new Error(t('节点不存在'))
    if (!file.bytes.length) throw new Error(t('文件内容为空'))
    if (file.bytes.length > MAX_ATTACHMENT_BYTES) throw new Error(t('文件超过 50 MB'))
    const route = uploadRoute(file.type)
    const response = await runtime.transport.request<UploadResponse>(route, undefined, {
      kind: 'mutation',
      raw: file.bytes,
      headers: {
        'content-type': file.type || 'application/octet-stream',
        'x-alma-filename': encodeURIComponent(file.name),
      },
    })
    if (!response?.filePath) throw new Error(response?.error || t('上传失败'))
    return {
      path: response.filePath,
      name: response.filename || file.name,
      size: response.size ?? file.bytes.length,
      renamed: Boolean(response.filename && response.filename !== file.name),
    }
  }

  /**
   * Creates a new session: a Herdr tab (which yields one root pane) and an
   * agent started inside it. `cwd` defaults to the directory the user is
   * already working in.
   */
  newSession = async (hostId: string, options: { kind: string; cwd?: string; workspaceId?: string; label?: string }): Promise<{ paneId: string; workspaceId: string }> => {
    const runtime = this.runtimes.get(hostId)
    if (!runtime) throw new Error(t('节点不存在'))
    const created = await this.rpc<{ tab?: { tab_id?: string; workspace_id?: string }; root_pane?: { pane_id?: string; workspace_id?: string } }>(
      hostId, 'tab.create', { ...(options.workspaceId ? { workspace_id: options.workspaceId } : {}), ...(options.cwd ? { cwd: options.cwd } : {}), focus: false },
    )
    const paneId = created?.root_pane?.pane_id
    const workspaceId = created?.root_pane?.workspace_id ?? created?.tab?.workspace_id ?? options.workspaceId ?? ''
    if (!paneId) throw new Error(t('无法创建会话'))
    // agent.start needs a pane sitting at a shell prompt; it appears a moment
    // after the tab is created, so retry the documented "not an available shell".
    let lastError: unknown
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        await this.rpc(hostId, 'agent.start', {
          name: options.label || `${options.kind}-${Math.random().toString(16).slice(2, 8)}`,
          kind: options.kind,
          pane_id: paneId,
          timeout_ms: 60_000,
        })
        return { paneId, workspaceId }
      } catch (error) {
        lastError = error
        if (!/not an available shell/i.test(String(error))) break
        await new Promise((resolve) => setTimeout(resolve, 800))
      }
    }
    throw lastError instanceof Error ? lastError : new Error(t('无法创建会话'))
  }

  /** Renames a paired desktop. The credential and connection are untouched. */
  renameHost = async (id: string, name: string) => {
    if (!this.initializedStorage) throw new Error(t('安全存储尚未就绪'))
    const trimmed = name.trim().slice(0, 80)
    if (!trimmed) throw new Error(t('名称不能为空'))
    await this.serialize(async () => {
      const hosts = this.state.hosts.map((item) => item.host.id === id ? { ...item.host, name: trimmed } : item.host)
      if (!hosts.some((host) => host.id === id)) throw new Error(t('节点不存在'))
      await this.storage.save(hosts)
      this.publish({
        hosts: this.state.hosts.map((item) => item.host.id === id ? { ...item, host: { ...item.host, name: trimmed } } : item),
      })
    })
  }
  forgetHost = async (id: string) => {
    if (!this.initializedStorage) throw new Error(t('安全存储尚未就绪'))
    await this.serialize(async () => {
      const hosts = this.state.hosts.filter((item) => item.host.id !== id)
      await this.storage.save(hosts.map((item) => item.host))
      const runtime = this.runtimes.get(id)
      this.runtimes.delete(id)
      if (runtime) { clearTimeout(runtime.retry); runtime.hub?.close(); runtime.transport.close() }
      if (this.state.session?.hostId === id) this.stopSession()
      this.publish({ hosts, ...(this.state.selectedHostId === id ? { selectedHostId: undefined, selectedPaneId: undefined, session: undefined } : {}) })
    })
  }
  selectHost = (id: string) => {
    if (id === this.state.selectedHostId) return
    this.stopSession()
    this.publish({ selectedHostId: id, selectedPaneId: undefined, session: undefined })
    void this.storage.saveSelection?.(id).catch(() => undefined)
  }
  /** Manual retry: the user's explicit fallback, always allowed. */
  retryHost = (id: string) => {
    const runtime = this.runtimes.get(id)
    if (!runtime) return
    this.cancelRetry(runtime)
    runtime.attempts = 0
    runtime.stopped = undefined
    this.patchHost(id, { retriesLeft: MAX_RETRIES, stopReason: undefined, error: undefined })
    void this.connectHost(id, runtime)
  }

  /**
   * Retry everything that gave up, without disturbing the ones that are fine.
   * Used when the app returns to the foreground or the network comes back.
   */
  retryStopped = () => {
    for (const [id, runtime] of this.runtimes) {
      if (!runtime.stopped) continue
      this.cancelRetry(runtime)
      runtime.attempts = 0
      runtime.stopped = undefined
      this.patchHost(id, { retriesLeft: MAX_RETRIES, stopReason: undefined })
      void this.connectHost(id, runtime)
    }
  }

  /** Releases every socket when the app has been away long enough. */
  /**
   * Releases every socket when the app has been away long enough.
   *
   * The transport is single-use: closing it marks it stopped and `connect()`
   * refuses forever after. So the runtime is dropped rather than reused, and
   * `resume` builds a new one — otherwise the desktop would stay offline for
   * the rest of the process's life.
   */
  suspend = () => {
    this.stopSession()
    for (const [id, runtime] of this.runtimes) {
      this.cancelRetry(runtime)
      runtime.hub?.close()
      runtime.hub = undefined
      runtime.transport.close()
      this.runtimes.delete(id)
      this.patchHost(id, { status: 'offline', herdrOnline: false })
    }
  }

  /**
   * Coming back from a suspend reconnects on a fresh ladder. A short absence
   * needs nothing: the sockets were never released.
   */
  resume = (wasSuspended: boolean) => {
    if (!wasSuspended) return
    for (const state of this.state.hosts) {
      const id = state.host.id
      if (this.runtimes.has(id)) continue
      const runtime = this.makeRuntime(state.host)
      this.runtimes.set(id, runtime)
      this.patchHost(id, { retriesLeft: MAX_RETRIES, stopReason: undefined })
      void this.connectHost(id, runtime)
    }
  }
  backToSessions = () => { this.stopSession(); this.publish({ selectedPaneId: undefined, session: undefined }) }
  private stopSession() {
    ++this.sessionEpoch
    ++this.sessionIdentity
    this.sessionRefresh = undefined
    for (const timer of this.sessionTimers) clearTimeout(timer)
    this.sessionTimers.clear()
    for (const socket of this.sessionSockets.splice(0)) socket.close()
  }
  selectPane = async (paneId: string) => {
    const hostId = this.state.selectedHostId
    if (!hostId || !this.runtimes.has(hostId)) return
    this.stopSession()
    this.publish({ selectedPaneId: paneId, session: { hostId, paneId, items: [], start: -1, end: 0, queued: [], loading: true, loadingOlder: false, screen: '', unsupported: false, sending: false } })
    await this.refreshSession()
  }
  /** Manual retry: drop any scheduled attempt and reload now. */
  reloadSession = async () => {
    for (const timer of this.sessionTimers) clearTimeout(timer)
    this.sessionTimers.clear()
    this.sessionRefresh = undefined
    await this.refreshSession()
  }
  private refreshSession(): Promise<void> {
    if (this.sessionRefresh) return this.sessionRefresh
    const epoch = this.sessionEpoch
    const promise = this.loadSession(epoch).finally(() => { if (epoch === this.sessionEpoch && this.sessionRefresh === promise) this.sessionRefresh = undefined })
    this.sessionRefresh = promise
    return promise
  }
  private later(epoch: number, delay = 1800) {
    const timer = setTimeout(() => { this.sessionTimers.delete(timer); if (epoch === this.sessionEpoch) void this.refreshSession() }, delay)
    this.sessionTimers.add(timer)
  }
  private async loadSession(epoch: number) {
    const session = this.state.session
    // Abandoning this load must not leave the spinner running: the caller may
    // have switched panes, or the runtime may be gone after a suspend. Clearing
    // here keeps the next screen from inheriting a permanent "loading".
    if (!session || epoch !== this.sessionEpoch) return
    const runtime = this.runtimes.get(session.hostId)
    if (!runtime) { this.patchSession(epoch, { loading: false }); return }
    for (const socket of this.sessionSockets.splice(0)) socket.close()
    // Only show a spinner while the first page is in flight; an empty
    // transcript is a valid end state, not a permanent load.
    this.patchSession(epoch, { loading: session.items.length === 0, error: undefined })
    try {
      const page = await runtime.transport.request<Page>(`/api/herdr/chat?pane=${encodeURIComponent(session.paneId)}&limit=60`)
      if (epoch !== this.sessionEpoch) return
      if (page.error) {
        // Alma reports both `no_session` and `no_agent_session`. Two different situations
        // land here: a plain terminal (nothing to show) and an agent whose integration has
        // not reported its native session id yet, where a transcript will appear shortly.
        // Neither is an error, and the second one must keep retrying.
        if (['unsupported_agent', 'no_session', 'no_agent_session', 'transcript_not_found'].includes(page.error.code || '')) {
          const pane = this.state.hosts.find((item) => item.host.id === session.hostId)?.snapshot?.panes.find((item) => item.pane_id === session.paneId)
          const hasAgent = Boolean(pane?.agent)
          this.patchSession(epoch, { unsupported: true, loading: false, error: undefined })
          this.later(epoch, hasAgent ? 4000 : 15_000)
        } else throw new Error(page.error.message || t('无法读取会话'))
      } else {
        const same = session.sessionId === page.session_id
        const items = same ? session.items : merge([], page.page?.items ?? [])
        const cursor = same ? session.end : page.page?.end ?? 0
        this.patchSession(epoch, { items, sessionId: page.session_id, start: same && session.start >= 0 ? session.start : page.page?.start ?? 0, end: cursor, queued: page.queued ?? [], loading: false, unsupported: false })
        const chat = runtime.transport.subscribe(`/ws/herdr/chat?pane=${encodeURIComponent(session.paneId)}&from=${cursor}`, (event) => {
          if (epoch !== this.sessionEpoch || !this.state.session) return
          if (event.type === 'items' && Array.isArray(event.items)) this.patchSession(epoch, { items: merge(this.state.session.items, event.items), end: Number(event.end) || this.state.session.end })
          if (event.type === 'queued' && Array.isArray(event.queued)) this.patchSession(epoch, { queued: event.queued })
          if (event.type === 'session_changed') { ++this.sessionIdentity; this.patchSession(epoch, { items: [], queued: [], sessionId: undefined, end: 0, start: -1, loading: true, uncertain: undefined }); this.later(epoch) }
        }, () => { if (epoch === this.sessionEpoch) this.later(epoch) })
        this.sessionSockets.push(chat)
      }
      this.sessionSockets.push(runtime.transport.subscribe(`/ws/herdr/screen?pane=${encodeURIComponent(session.paneId)}`, (event) => {
        if (event.type === 'screen') this.patchSession(epoch, { screen: typeof event.read?.text === 'string' ? event.read.text : this.state.session?.screen ?? '' })
      }, () => { if (epoch === this.sessionEpoch) this.later(epoch) }))
      await this.readScreen()
    } catch (error) { this.patchSession(epoch, { loading: false, error: message(error) }); if (epoch === this.sessionEpoch) this.later(epoch) }
  }
  loadOlder = async () => {
    const session = this.state.session, epoch = this.sessionEpoch, identity = this.sessionIdentity
    if (!session || session.loadingOlder || session.start <= 0) return
    this.patchSession(epoch, { loadingOlder: true })
    try {
      const page = await this.runtimes.get(session.hostId)!.transport.request<Page>(`/api/herdr/chat?pane=${encodeURIComponent(session.paneId)}&before=${session.start}&limit=60`)
      if (page.error) throw new Error(page.error.message || t('历史读取失败'))
      // A late page from the previous session must not splice into the current transcript.
      if (epoch !== this.sessionEpoch || identity !== this.sessionIdentity || page.session_id !== this.state.session?.sessionId) return
      this.patchSession(epoch, { items: merge(this.state.session!.items, page.page?.items ?? [], true), start: page.page?.start ?? 0 })
    } catch (error) { if (identity === this.sessionIdentity) this.patchSession(epoch, { error: message(error) }) } finally { this.patchSession(epoch, { loadingOlder: false }) }
  }
  /**
   * Answers a numbered agent prompt.
   *
   * The screen shown when the user tapped may already be stale, so this
   * re-reads the terminal and requires the parsed menu to match exactly
   * (same question, same labels, same highlighted row) before sending keys.
   * On drift it aborts and refreshes instead of guessing.
   */
  answerPrompt = async (expected: Prompt, optionNumber: number) => {
    const session = this.state.session, epoch = this.sessionEpoch
    if (!session) throw new Error(t('没有打开的会话'))
    if (session.sending) return
    if (session.uncertain) throw new Error(session.uncertain)
    const option = expected.options.find((item) => item.number === optionNumber)
    if (!option) throw new Error(t('选项不存在'))

    const fresh = await this.rpc<{ read?: { text?: string } }>(session.hostId, 'pane.read', { pane_id: session.paneId, source: 'visible', format: 'text' })
    if (epoch !== this.sessionEpoch) return
    const screen = fresh.read?.text ?? ''
    const current = parsePrompt(screen)
    this.patchSession(epoch, { screen })
    if (!samePrompt(current, expected) || !current) {
      this.patchSession(epoch, { error: t('终端内容已变化，已取消本次选择。请确认最新问题后再点。') })
      return
    }
    const target = current.options.findIndex((item) => item.number === optionNumber)
    if (target < 0) { this.patchSession(epoch, { error: t('选项已不存在，请刷新后重试。') }); return }

    this.patchSession(epoch, { sending: true, error: undefined })
    try {
      const keys: string[] = []
      const multiSelect = needsSpace(current.options[target])
      if (current.cursor >= 0 && current.cursor !== target) {
        const moves = moveKeys(current.cursor, target)
        if (!moves) throw new Error(t('无法确定光标位置'))
        keys.push(...moves)
      }
      // In a multi-select menu Enter *submits* the whole form, so it must never
      // be sent for a plain row: only Space toggles. Single-choice menus commit
      // by moving the cursor and pressing Enter, which is why the two cases are
      // kept apart instead of sharing one fallback.
      if (multiSelect) keys.push(' ')
      else if (current.cursor >= 0 && current.cursor !== target) keys.push('enter')
      else keys.push(String(optionNumber))
      await this.rpc(session.hostId, 'pane.send_keys', { pane_id: session.paneId, keys: keys.map((key) => key === ' ' ? 'space' : key) })
      if (epoch === this.sessionEpoch) await this.readScreen()
    } catch (error) {
      this.patchSession(epoch, { error: message(error), ...(error instanceof OperationUncertainError ? { uncertain: message(error) } : {}) })
      throw error
    } finally { this.patchSession(epoch, { sending: false }) }
  }
  private async rpc<T>(hostId: string, method: string, params: Record<string, unknown>): Promise<T> {
    const runtime = this.runtimes.get(hostId)
    if (!runtime) throw new Error(t('节点不存在'))
    const response = await runtime.transport.request<{ result?: T; error?: { code?: string; message?: string } }>('/api/herdr/rpc', { method, params })
    if (response.error) throw new Error(response.error.message || response.error.code || t('Herdr 操作失败'))
    return response.result as T
  }
  readScreen = async () => {
    const session = this.state.session, epoch = this.sessionEpoch
    if (!session) return
    try { const result = await this.rpc<{ read?: { text?: string } }>(session.hostId, 'pane.read', { pane_id: session.paneId, source: 'visible', format: 'text' }); this.patchSession(epoch, { screen: result.read?.text ?? '' }) }
    catch (error) { this.patchSession(epoch, { error: message(error) }) }
  }
  private async mutate(method: string, params: (session: SessionState) => Record<string, unknown>) {
    const session = this.state.session, epoch = this.sessionEpoch
    if (!session) throw new Error(t('没有打开的会话'))
    if (session.sending) return
    if (session.uncertain) throw new Error(session.uncertain)
    this.patchSession(epoch, { sending: true, error: undefined })
    try { await this.rpc(session.hostId, method, params(session)); if (epoch === this.sessionEpoch) await this.readScreen() }
    catch (error) { this.patchSession(epoch, { error: message(error), ...(error instanceof OperationUncertainError ? { uncertain: message(error) } : {}) }); throw error }
    finally { this.patchSession(epoch, { sending: false }) }
  }
  sendMessage = async (text: string) => { if (text.trim()) await this.mutate('agent.prompt', (s) => ({ target: s.paneId, text })) }
  /**
   * Runs one of the agent's own slash commands.
   *
   * The command is typed into the terminal, not sent as a prompt, so the agent
   * handles it exactly as if the user had typed it. Anything it prints arrives
   * on the screen stream, which is why the caller switches to the terminal.
   */
  runCommand = async (command: string) => {
    const text = command.trim()
    if (!text.startsWith('/')) throw new Error(t('只支持斜杠命令'))
    const session = this.state.session, epoch = this.sessionEpoch
    if (!session) throw new Error(t('没有打开的会话'))
    if (session.sending) return
    if (session.uncertain) throw new Error(session.uncertain)
    this.patchSession(epoch, { sending: true, error: undefined })
    try {
      await this.rpc(session.hostId, 'pane.send_text', { pane_id: session.paneId, text })
      if (epoch === this.sessionEpoch) await this.readScreen()
    } catch (error) {
      this.patchSession(epoch, { error: message(error), ...(error instanceof OperationUncertainError ? { uncertain: message(error) } : {}) })
      throw error
    } finally { this.patchSession(epoch, { sending: false }) }
  }

  sendKeys = async (keys: string[]) => {
    const names: Record<string, string> = { Up: 'up', Down: 'down', Left: 'left', Right: 'right', Enter: 'enter', Escape: 'esc', 'C-c': 'ctrl+c' }
    if (!keys.length || keys.length > 20 || keys.some((key) => !names[key])) throw new Error(t('不支持的终端按键'))
    await this.mutate('pane.send_keys', (s) => ({ pane_id: s.paneId, keys: keys.map((key) => names[key]) }))
  }
  sendTerminalText = async (text: string) => {
    const session = this.state.session, epoch = this.sessionEpoch
    if (!session) throw new Error(t('没有打开的会话'))
    if (session.sending || !text) return
    if (session.uncertain) throw new Error(session.uncertain)
    this.patchSession(epoch, { sending: true, error: undefined })
    let textSent = false
    try {
      await this.rpc(session.hostId, 'pane.send_text', { pane_id: session.paneId, text: `\u001b[200~${text}\u001b[201~` })
      textSent = true
      await this.rpc(session.hostId, 'pane.send_keys', { pane_id: session.paneId, keys: ['enter'] })
      if (epoch === this.sessionEpoch) await this.readScreen()
    } catch (error) {
      const uncertain = error instanceof OperationUncertainError || textSent
      this.patchSession(epoch, { error: message(error), ...(uncertain ? { uncertain: t('终端输入可能已部分执行，请核对画面后重新打开会话。') } : {}) })
      throw error
    } finally { this.patchSession(epoch, { sending: false }) }
  }
  dispose() { this.stopSession(); const runtimes = [...this.runtimes.values()]; this.runtimes.clear(); for (const runtime of runtimes) { clearTimeout(runtime.retry); runtime.hub?.close(); runtime.transport.close() } }
}
export const controller = new Controller()
