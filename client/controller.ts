import type { AppState, ChatItem, Host, Pane, SessionState, Snapshot, TranscriptGap } from './model'
import { parsePairing } from './pairing'
import { t } from './i18n'
import { MAX_RETRIES, isPermanentFailure, nextDelay, retriesLeft, stopMessage } from './backoff'
import { MAX_ATTACHMENT_BYTES, uploadRoute, type UploadResponse, type UploadedFile } from './attachments'
import { moveKeys, needsSpace, parsePrompt, samePrompt, type Prompt } from './prompt'
import { hostStorage, type HostStorage } from './storage'
import { EncryptedTunnel, OperationUncertainError, RejectedError, type Transport, type TunnelError, type TunnelSocket } from './transport'

type Page = { session_id?: string; page?: { items?: ChatItem[]; start?: number; end?: number }; queued?: { id: string; text: string }[]; error?: { code?: string; message?: string } }
const message = (error: unknown) => error instanceof Error ? error.message : t('请求失败')

/**
 * The argv Herdr should start for a new session.
 *
 * A login shell resolves the agent through the user's own PATH (Homebrew and
 * version managers are usually configured in a login profile). The agent is
 * not `exec`ed: when it exits — or a binary is missing — the trailing
 * interactive login shell takes over, so the pane stays a usable terminal
 * instead of closing (Herdr removes a pane whose process exits).
 */
export function agentLaunchCommand(kind: string): string[] {
  const executable = /^[a-z][a-z0-9-]{0,31}$/.test(kind) ? kind : 'claude'
  return ['/bin/sh', '-lc', `${executable}; exec "\${SHELL:-/bin/sh}" -il`]
}

/**
 * Why a pane has no transcript, given the error Alma reported for it.
 *
 * The two codes say different things, which is the whole point of telling
 * them apart:
 *
 * - `no_agent_session` means Herdr has no session id for the pane — which is
 *   also what a plain shell reports, so the pane itself decides whether an
 *   agent is there. A missing id is normal for a moment after an agent starts,
 *   because its integration reports the id when the session begins. It is only
 *   the integration's fault once the agent has been given work — it is
 *   working, or finished, or blocked — and still no id ever arrived.
 * - `transcript_not_found` means the id exists but the transcript is not where
 *   Alma looks. That is not an install problem either: it is typically a CLI
 *   whose session lives elsewhere, such as one behind SSH or in a container.
 * - `unsupported_agent` means Alma has no reader for that agent at all, which
 *   is never something the user can install their way out of.
 */
export function transcriptGap(code: string, pane: Pane | undefined, sentMessage: boolean): TranscriptGap {
  if (code === 'unsupported_agent') return 'unsupported'
  if (code === 'transcript_not_found') return 'transcript'
  // Without a snapshot there is no way to tell a shell from an agent, so say
  // the harmless thing; the next refresh classifies it once the list arrives.
  if (!pane) return 'waiting'
  if (!pane.agent && !pane.agent_session?.agent) return 'terminal'
  const worked = sentMessage || ['working', 'done', 'blocked'].includes(pane.agent_status ?? '')
  return worked ? 'integration' : 'waiting'
}

/**
 * Whether a failure means "this desktop does not know the method" rather than
 * "the method ran and refused". Herdr reports the former as a request error
 * naming the method, and a desktop too old for it may not answer at all.
 */
function isUnknownMethod(error: unknown): boolean {
  // Alma refuses methods the phone may not call with 403 "… is not available
  // from the phone". That is the same situation as an older desktop not
  // knowing the method: another path has to be used instead.
  if (error instanceof RejectedError && error.status === 403) return true
  const text = error instanceof Error ? error.message : String(error)
  return /unknown variant|unknown method|unsupported|not_implemented|invalid_request|not available from the phone/i.test(text)
}

/**
 * Starting an agent is not a read: Herdr launches a process and waits for it
 * to become interactive before answering. A cold start on a loaded machine
 * outlives the read deadline, and the user then sees "may have run" for a
 * create that actually succeeded.
 */
const CREATE_TIMEOUT_MS = 75_000

/**
 * Transcript page size.
 *
 * 60 rows is roughly two screens of an agent turn, so reading back through a
 * session meant tapping "earlier" every few swipes. The view loads earlier
 * pages on scroll now, and a larger page keeps that from turning into one
 * request per flick; 150 still answers in well under a second on a phone.
 */
const TRANSCRIPT_PAGE = 150

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
  /** In-flight/successful remote image fetches, scoped to this controller. */
  private media = new Map<string, Promise<string>>()
  private mediaCache = new Map<string, string>()
  private sessionEpoch = 0
  /** Bumped whenever the transcript identity changes, so stale history pages cannot merge. */
  private sessionIdentity = 0
  private sessionSockets: TunnelSocket[] = []
  private sessionTimers = new Set<ReturnType<typeof setTimeout>>()
  private initialized?: Promise<void>
  private openingHost = false
  private initializedStorage = false
  private sessionRefresh?: Promise<void>
  /** Desktops where `layout.apply` is not offered to the phone. */
  private legacyOnly = new Set<string>()
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
      // A desktop the user switched off is reported as such, and never dialled:
      // the point of the switch is not spending a connection on it.
      this.publish({
        hosts: hosts.map((host) => ({ host, status: host.enabled === false ? 'disabled' as const : 'offline' as const, herdrOnline: false })),
        loading: false,
        selectedHostId: selected,
        storageWarning: this.storage.persistent ? undefined : t('浏览器预览仅在内存中保存节点；关闭页面后需要重新配对。'),
      })
      for (const host of hosts) if (host.enabled !== false) this.attach(host)
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
    // The desktop may have been updated since; ask again rather than assume.
    this.legacyOnly.delete(host.id)
    const old = this.state.hosts.find((item) => item.host.id === host.id)?.host
    if (old) {
      host.addedAt = old.addedAt
      // Pairing again updates the credential, not the user's switch. Keeping
      // it off also keeps the code path below from dialling a disabled desktop.
      if (old.enabled === false) host.enabled = false
    }
    const hosts = [...this.state.hosts.filter((item) => item.host.id !== host.id).map((item) => item.host), host]
    await this.storage.save(hosts)
    const previous = this.runtimes.get(host.id)
    this.runtimes.delete(host.id)
    if (previous) { clearTimeout(previous.retry); previous.hub?.close(); previous.transport.close() }
    // Always close the open session: the selected host changes, so an old pane must not stay as the mutation target.
    if (this.state.session) this.stopSession()
    this.publish({
      hosts: hosts.map((item) => item.id === host.id ? { host, status: host.enabled === false ? 'disabled' as const : 'offline' as const, herdrOnline: false } : this.state.hosts.find((state) => state.host.id === item.id)!),
      selectedHostId: host.id, selectedPaneId: undefined, session: undefined, error: undefined,
    })
    if (host.enabled !== false) this.attach(host)
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
   * Creates a new session: a Herdr tab whose root pane runs the agent.
   *
   * The agent must not be launched with `agent.start`. That command only checks
   * that the shell owns the foreground, not that the shell finished its rc
   * files; a prompt written by an rc file (oh-my-zsh's update question, a p10k
   * wizard) is still reading, so the first character of the typed command is
   * swallowed and the rest — `laude` instead of `claude` — runs as a command.
   * `layout.apply` starts the process directly with its own argv, so nothing is
   * typed into a shell that may still be prompting.
   *
   * The command is the agent wrapped in a login shell that stays after it
   * exits: closing the agent must leave a usable terminal, not a dead tab
   * (a pane whose process exits is removed by Herdr).
   */
  /**
   * Creates a session.
   *
   * `layout.apply` starts the agent with its own argv, which avoids typing
   * into a shell that may still be reading rc files. It is not always
   * available: Alma's phone bridge refuses any method outside its allowlist,
   * and older desktops do not know it at all. Both are discovered by asking,
   * not by version, and both fall back to `tab.create` + `agent.start` — the
   * methods that allowlist does include.
   */
  newSession = async (hostId: string, options: { kind: string; cwd?: string; workspaceId?: string; label?: string }): Promise<{ paneId: string; workspaceId: string }> => {
    if (!this.runtimes.has(hostId)) throw new Error(t('节点不存在'))
    // A refused method would answer identically every time, so remember it
    // per desktop and skip the round trip from the second session onwards.
    if (this.legacyOnly.has(hostId)) return this.legacyNewSession(hostId, options)
    const command = agentLaunchCommand(options.kind)
    try {
      const created = await this.rpc<{
        type?: string; tab_id?: string; workspace_id?: string; focused_pane_id?: string
        layout?: { tab_id?: string; workspace_id?: string; focused_pane_id?: string; root?: unknown }
      }>(hostId, 'layout.apply', {
        ...(options.workspaceId ? { workspace_id: options.workspaceId } : {}),
        ...(options.label ? { tab_label: options.label } : {}),
        focus: false,
        root: { type: 'pane', ...(options.cwd ? { cwd: options.cwd } : {}), command },
      }, CREATE_TIMEOUT_MS)
      // Herdr answers `{ type: 'layout_apply', layout: {…} }`; a wrapper that
      // predates that shape put the same fields at the top level. Read both.
      const paneId = created?.focused_pane_id ?? created?.layout?.focused_pane_id
      const workspaceId = created?.workspace_id ?? created?.layout?.workspace_id ?? options.workspaceId ?? ''
      const tabId = created?.tab_id ?? created?.layout?.tab_id
      if (!paneId) {
        // The layout was applied but the reply did not name a pane. The tab is
        // still there, so find its pane in the snapshot instead of reporting a
        // failure for something that worked.
        const found = await this.paneOfTab(hostId, tabId)
        if (!found) throw new Error(t('无法创建会话'))
        return { paneId: found, workspaceId }
      }
      return { paneId, workspaceId }
    } catch (error) {
      // Desktops older than the layout API have no other way to start an agent,
      // so fall back to the previous path. It may lose the first character to a
      // shell that is still reading its rc files, which is why it is only the
      // fallback and not the default.
      if (!isUnknownMethod(error)) throw error
      this.legacyOnly.add(hostId)
      return this.legacyNewSession(hostId, options)
    }
  }

  /** The pre-`layout.apply` path: create the tab, then type the agent in. */
  private async legacyNewSession(hostId: string, options: { kind: string; cwd?: string; workspaceId?: string; label?: string }) {
    const created = await this.rpc<{ tab?: { tab_id?: string; workspace_id?: string }; root_pane?: { pane_id?: string; workspace_id?: string } }>(
      hostId, 'tab.create', { ...(options.workspaceId ? { workspace_id: options.workspaceId } : {}), ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.label ? { label: options.label } : {}), focus: false }, CREATE_TIMEOUT_MS,
    )
    const paneId = created?.root_pane?.pane_id
    const workspaceId = created?.root_pane?.workspace_id ?? created?.tab?.workspace_id ?? options.workspaceId ?? ''
    if (!paneId) throw new Error(t('无法创建会话'))
    let lastError: unknown
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        await this.rpc(hostId, 'agent.start', {
          name: `${options.kind}-${Math.random().toString(16).slice(2, 8)}`,
          kind: options.kind,
          pane_id: paneId,
          timeout_ms: 60_000,
        }, CREATE_TIMEOUT_MS)
        return { paneId, workspaceId }
      } catch (error) {
        lastError = error
        if (!/not an available shell/i.test(String(error))) break
        await new Promise((resolve) => setTimeout(resolve, 800))
      }
    }
    throw lastError instanceof Error ? lastError : new Error(t('无法创建会话'))
  }

  /**
   * Renames a session. The label lives on the Herdr tab, so the desktop shows
   * it too, and the pane keeps its own label untouched.
   */
  renameSession = async (hostId: string, paneId: string, label: string) => {
    const trimmed = label.trim().slice(0, 80)
    const pane = this.state.hosts.find((item) => item.host.id === hostId)?.snapshot?.panes.find((item) => item.pane_id === paneId)
    if (!pane?.tab_id) throw new Error(t('找不到会话'))
    // An empty name clears the label, which restores Herdr's own title.
    if (label.trim() && !trimmed) throw new Error(t('名称不能为空'))
    await this.rpc(hostId, 'tab.rename', { tab_id: pane.tab_id, label: trimmed })
    // Herdr pushes a fresh snapshot after a rename, but the list must not look
    // unchanged while that round trip is in flight.
    const snapshot = this.state.hosts.find((item) => item.host.id === hostId)?.snapshot
    if (snapshot) {
      this.patchHost(hostId, {
        snapshot: { ...snapshot, tabs: (snapshot.tabs ?? []).map((tab) => tab.tab_id === pane.tab_id ? { ...tab, label: trimmed } : tab) },
      })
    }
  }

  /**
   * Turns connection attempts for one desktop on or off.
   *
   * This is the user's own decision, saved with the pairing: a desktop that is
   * off, or one they do not want on mobile data, stops being dialled and stops
   * scheduling retries until they turn it back on. Nothing else re-enables it,
   * so it cannot quietly undo the choice.
   */
  setHostEnabled = async (id: string, enabled: boolean) => {
    if (!this.initializedStorage) throw new Error(t('安全存储尚未就绪'))
    await this.serialize(async () => {
      const target = this.state.hosts.find((item) => item.host.id === id)
      if (!target) throw new Error(t('节点不存在'))
      const hosts = this.state.hosts.map((item) => item.host.id === id ? { ...item.host, enabled } : item.host)
      await this.storage.save(hosts)
      this.publish({ hosts: this.state.hosts.map((item) => item.host.id === id ? { ...item, host: { ...item.host, enabled } } : item) })
      if (!enabled) {
        this.stopHost(id)
        this.patchHost(id, { status: 'disabled', herdrOnline: false, error: undefined, retriesLeft: undefined, stopReason: undefined })
      } else {
        this.attach(this.state.hosts.find((item) => item.host.id === id)!.host)
      }
    })
  }

  /** Releases one desktop: sockets, retries and any session open on it. */
  private stopHost(id: string) {
    const runtime = this.runtimes.get(id)
    if (this.state.session?.hostId === id) this.stopSession()
    this.publish({ ...(this.state.session?.hostId === id ? { session: undefined, selectedPaneId: undefined } : {}) })
    if (!runtime) return
    // Drop it before closing, so the close's 'offline' cannot schedule a retry.
    this.cancelRetry(runtime)
    this.runtimes.delete(id)
    runtime.hub?.close()
    runtime.transport.close()
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
   * Checks that every open tunnel still carries traffic.
   *
   * A socket can be dead while both ends' state says it is fine, because the
   * close event never ran — the page was frozen when the relay dropped it. One
   * short read settles it; a transport that cannot answer rebuilds itself and
   * reports offline, which starts the usual retry ladder.
   */
  verify = async () => {
    for (const [id, runtime] of this.runtimes) {
      if (runtime.stopped) continue
      try {
        await runtime.transport.request<{ online: boolean }>('/api/herdr/info', undefined, { kind: 'read' })
      } catch { /* the transport has already reported the failure */ }
      if (this.runtimes.get(id) !== runtime) continue
      // A request that failed on a dead socket leaves the runtime offline;
      // rebuilding now turns a stale "online" into a real connection.
      if (this.state.hosts.find((item) => item.host.id === id)?.status !== 'online') this.rebuild(id, runtime)
    }
  }
  /** Replaces a runtime whose transport is known to be dead. */
  private rebuild(id: string, runtime: Runtime) {
    if (this.runtimes.get(id) !== runtime) return
    const host = this.state.hosts.find((item) => item.host.id === id)?.host
    if (!host) return
    this.cancelRetry(runtime)
    // Drop it first: closing reports offline, and a replaced runtime must not
    // schedule a retry of its own.
    this.runtimes.delete(id)
    runtime.hub?.close()
    runtime.transport.close()
    const fresh = this.makeRuntime(host)
    this.runtimes.set(id, fresh)
    this.patchHost(id, { retriesLeft: MAX_RETRIES, stopReason: undefined, error: undefined })
    void this.connectHost(id, fresh)
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
   * Coming back to the app reconnects on a fresh ladder.
   *
   * `rebuild` replaces the transports even when they look open. Android
   * freezes the page in the background, so after a real absence the socket in
   * hand is one the relay has already dropped, and only a new one will do.
   * Without `rebuild`, only a suspended runtime is rebuilt; a quick app switch
   * keeps the live socket.
   */
  resume = (rebuild: boolean) => {
    for (const state of this.state.hosts) {
      // A switched-off desktop was never released, so there is nothing to
      // resume — and bringing it back would defeat the switch.
      if (state.host.enabled === false) continue
      const id = state.host.id
      const existing = this.runtimes.get(id)
      if (existing && !rebuild) continue
      // Drop the runtime before closing it: closing reports 'offline', and a
      // runtime that is no longer current must not schedule a retry of its own.
      if (existing) {
        this.cancelRetry(existing)
        this.runtimes.delete(id)
        existing.hub?.close()
        existing.transport.close()
      }
      const runtime = this.makeRuntime(state.host)
      this.runtimes.set(id, runtime)
      this.patchHost(id, { retriesLeft: MAX_RETRIES, stopReason: undefined, error: undefined })
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
    this.publish({ selectedPaneId: paneId, session: { hostId, paneId, items: [], start: -1, end: 0, queued: [], loading: true, loadingOlder: false, screen: '', unsupported: false, sentMessage: false, sending: false } })
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
      const page = await runtime.transport.request<Page>(`/api/herdr/chat?pane=${encodeURIComponent(session.paneId)}&limit=${TRANSCRIPT_PAGE}`)
      if (epoch !== this.sessionEpoch) return
      if (page.error) {
        // Alma reports both `no_session` and `no_agent_session`. Two different situations
        // land here: a plain terminal (nothing to show) and an agent whose integration has
        // not reported its native session id yet, where a transcript will appear shortly.
        // Neither is an error, and the second one must keep retrying.
        const code = page.error.code || ''
        if (['unsupported_agent', 'no_session', 'no_agent_session', 'transcript_not_found'].includes(code)) {
          const pane = this.state.hosts.find((item) => item.host.id === session.hostId)?.snapshot?.panes.find((item) => item.pane_id === session.paneId)
          const gap = transcriptGap(code, pane, session.sentMessage)
          this.patchSession(epoch, { unsupported: true, gap, loading: false, error: undefined })
          // An agent can still report its id, or its transcript can appear, so
          // keep asking; nothing changes on its own for a shell, so look rarely.
          this.later(epoch, gap === 'terminal' || gap === 'unsupported' ? 15_000 : 4000)
        } else throw new Error(page.error.message || t('无法读取会话'))
      } else {
        const same = session.sessionId === page.session_id
        const items = same ? session.items : merge([], page.page?.items ?? [])
        const cursor = same ? session.end : page.page?.end ?? 0
        this.patchSession(epoch, { items, sessionId: page.session_id, start: same && session.start >= 0 ? session.start : page.page?.start ?? 0, end: cursor, queued: page.queued ?? [], loading: false, unsupported: false, gap: undefined })
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
      const page = await this.runtimes.get(session.hostId)!.transport.request<Page>(`/api/herdr/chat?pane=${encodeURIComponent(session.paneId)}&before=${session.start}&limit=${TRANSCRIPT_PAGE}`)
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
  /**
   * The pane a tab holds, asked of Herdr rather than assumed.
   *
   * `layout.apply` normally names the pane it focused, but a reply without one
   * must not turn a created session into a reported failure.
   */
  private async paneOfTab(hostId: string, tabId?: string): Promise<string | undefined> {
    if (!tabId) return undefined
    const runtime = this.runtimes.get(hostId)
    if (!runtime) return undefined
    try {
      const pane = await this.rpc<{ pane?: { pane_id?: string } }>(hostId, 'tab.get', { tab_id: tabId })
      return pane?.pane?.pane_id
    } catch {
      // The method may not exist on an older desktop; the snapshot still can.
      return new Promise<string | undefined>((resolve) => {
        let socket: { close(): void } | undefined
        const done = (value?: string) => { socket?.close(); resolve(value) }
        const timer = setTimeout(() => done(undefined), 5000)
        socket = runtime.transport.subscribe('/ws/herdr', (event) => {
          if (event.type !== 'snapshot') return
          clearTimeout(timer)
          const panes = (event.snapshot?.panes ?? []) as { pane_id?: string; tab_id?: string }[]
          done(panes.find((item) => item.tab_id === tabId)?.pane_id)
        }, () => done(undefined))
      })
    }
  }

  /**
   * One Herdr RPC.
   *
   * `timeoutMs` exists because starting an agent is not like reading a pane:
   * Herdr launches a process and waits for it to become interactive before it
   * answers, and the default 20 s is shorter than a cold agent start on a busy
   * machine. The request has already been sent by then, so the user sees the
   * "may have run" message for what is really a slow but successful create.
   */
  /**
   * Fetch an image from the paired desktop through the encrypted tunnel.
   *
   * The URL/path originates in agent output, so it is never fetched by
   * `window.fetch` and never allowed to select an arbitrary host. The fixed
   * `/api/herdr/file` route on this host is the only transport destination.
   */
  fetchSessionImage = async (hostId: string, reference: string): Promise<string> => {
    const host = this.state.hosts.find((item) => item.host.id === hostId)?.host
    const runtime = this.runtimes.get(hostId)
    if (!host || !runtime) throw new Error(t('节点不存在'))
    let path: string
    if (reference.startsWith('/api/herdr/image/')) {
      path = reference
    } else if (reference.startsWith('/api/')) {
      if (!reference.startsWith('/api/herdr/file?')) throw new Error(t('不支持的图片地址'))
      path = reference
    } else if (reference.startsWith('/') || reference.startsWith('~/')) {
      path = `/api/herdr/file?path=${encodeURIComponent(reference)}`
    } else {
      throw new Error(t('不支持的图片地址'))
    }
    const key = `${hostId}\u0000${path}`
    const cached = this.mediaCache.get(key)
    if (cached) return cached
    const pending = this.media.get(key)
    if (pending) return pending
    const request = runtime.transport.request<{ bytes: Uint8Array; contentType: string }>(path, undefined, { kind: 'read', responseType: 'bytes' })
      .then(({ bytes, contentType }) => {
        if (!contentType.startsWith('image/')) throw new Error(t('远端文件不是图片'))
        if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error(t('图片超过 50 MB'))
        let binary = ''
        for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
        const data = `data:${contentType};base64,${btoa(binary)}`
        this.mediaCache.set(key, data)
        return data
      })
      .finally(() => this.media.delete(key))
    this.media.set(key, request)
    return request
  }

  /**
   * Targeted cancellation for the agent in the current pane. It is a write,
   * so a lost response remains uncertain and is never replayed.
   */
  stopAgent = async () => {
    const session = this.state.session
    if (!session) throw new Error(t('没有打开的会话'))
    const pane = this.state.hosts.find((item) => item.host.id === session.hostId)?.snapshot?.panes.find((item) => item.pane_id === session.paneId)
    const agent = pane?.agent ?? pane?.agent_session?.agent
    if (!agent) throw new Error(t('此终端没有可停止的 agent'))
    await this.rpc(session.hostId, 'pane.send_keys', { pane_id: session.paneId, keys: ['ctrl+c'] })
    if (this.state.session?.hostId === session.hostId && this.state.session?.paneId === session.paneId) await this.readScreen()
  }

  private async rpc<T>(hostId: string, method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    const runtime = this.runtimes.get(hostId)
    if (!runtime) throw new Error(t('节点不存在'))
    const response = await runtime.transport.request<{ result?: T; error?: { code?: string; message?: string } }>(
      '/api/herdr/rpc', { method, params }, timeoutMs === undefined ? undefined : { timeoutMs },
    )
    if (response.error) throw new Error(response.error.message || response.error.code || t('Herdr 操作失败'))
    return response.result as T
  }
  readScreen = async () => {
    const session = this.state.session, epoch = this.sessionEpoch
    if (!session) return
    try { const result = await this.rpc<{ read?: { text?: string } }>(session.hostId, 'pane.read', { pane_id: session.paneId, source: 'visible', format: 'text' }); this.patchSession(epoch, { screen: result.read?.text ?? '' }) }
    catch (error) { this.patchSession(epoch, { error: message(error) }) }
  }
  /** True when the call was actually made; false when one was already in flight. */
  private async mutate(method: string, params: (session: SessionState) => Record<string, unknown>): Promise<boolean> {
    const session = this.state.session, epoch = this.sessionEpoch
    if (!session) throw new Error(t('没有打开的会话'))
    if (session.sending) return false
    if (session.uncertain) throw new Error(session.uncertain)
    this.patchSession(epoch, { sending: true, error: undefined })
    try { await this.rpc(session.hostId, method, params(session)); if (epoch === this.sessionEpoch) await this.readScreen(); return true }
    catch (error) { this.patchSession(epoch, { error: message(error), ...(error instanceof OperationUncertainError ? { uncertain: message(error) } : {}) }); throw error }
    finally { this.patchSession(epoch, { sending: false }) }
  }
  /**
   * Records that the user has handed this pane work. That is what turns a
   * missing session id from "the agent is still starting" into "nothing is
   * going to report one", so the pane can say which of the two it is.
   */
  private markSent(epoch: number) { if (epoch === this.sessionEpoch) this.patchSession(epoch, { sentMessage: true }) }
  sendMessage = async (text: string) => {
    if (!text.trim()) return
    const epoch = this.sessionEpoch
    if (await this.mutate('agent.prompt', (s) => ({ target: s.paneId, text }))) this.markSent(epoch)
  }
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
      this.markSent(epoch)
    } catch (error) {
      const uncertain = error instanceof OperationUncertainError || textSent
      this.patchSession(epoch, { error: message(error), ...(uncertain ? { uncertain: t('终端输入可能已部分执行，请核对画面后重新打开会话。') } : {}) })
      throw error
    } finally { this.patchSession(epoch, { sending: false }) }
  }
  dispose() { this.stopSession(); const runtimes = [...this.runtimes.values()]; this.runtimes.clear(); for (const runtime of runtimes) { clearTimeout(runtime.retry); runtime.hub?.close(); runtime.transport.close() } }
}
export const controller = new Controller()
