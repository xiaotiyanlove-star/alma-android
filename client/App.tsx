import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ChangeEvent, FormEvent, KeyboardEvent, ReactNode, TouchEvent } from 'react';
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, ChevronDown, GitBranch,
  Camera, CircleAlert, CornerDownLeft, Eye, EyeOff, Loader2, MessageSquare, Plus, RefreshCw,
  Send, Server, Settings, Square, Terminal, Trash2, WrapText, X, FileCode, Pencil, ChevronUp, Paperclip, PlusCircle,
  QrCode, Copy, BellOff, RotateCcw, MoreHorizontal,
} from 'lucide-react';
import { controller } from './controller';
import { watchNetwork } from './network';
import { pairingLink } from './pairing';
import { Capacitor } from '@capacitor/core';
import { Clipboard } from '@capacitor/clipboard';
import { ScanPairing } from './ScanPairs';
import { AlertTracker, actionFor, localNotifier, registerAlertActions } from './notify';
import { applyKeepAlive, keepAliveMode, replyInProgress, setKeepAliveMode, type KeepAliveMode } from './keepalive';
import { lanDiscoveryEnabled, setLanDiscoveryEnabled } from './lanprefs';
import { parsePrompt, promptFingerprint, stripAnsi } from './prompt';
import { buildMessage, checkFile, looksLikeImage, MAX_ATTACHMENTS, resolveMediaType } from './attachments';
import { Markdown } from './Markdown';
import { CopyButton } from './CodeBlock';
import { APP_VERSION, APP_ID, BUILD_TIME } from './version';
import { t, tWith } from './i18n';
import { loadDraft, saveDraft } from './drafts';
import { back, closeOverlay, openOverlay, push, replace, useOverlay, useRoute } from './router';
import { takePendingLink } from './pending-link';
import { initialState, step } from './lifecycle';
import { stopMessage } from './backoff';
import { mergedHeaderInfo } from './session-info';
import { agentLook, statusTone, statusWord } from './agents';
import { paneTitle, tabLabelOf } from './session-title';
import { imagePaths, isThinking, timeline, withoutImagePaths, workImageSources, workImages, type WorkCount } from './timeline';
import { backgroundAgents, runningAgents } from './subagents';
import { agentMark } from './agent-marks';
import { acknowledge, pruneUnread, subscribeUnread, unreadPanes } from './unread';
import { ImageViewer } from './ImageViewer';
import { addLocalMedia, clearLocalMedia, evictOldestLocalMedia, localCopy, localMediaOwner, type LocalMediaEntry } from './local-media';
import { defaultSessionCwd } from './session-directory';
import { branchFromPane } from './git-branch';
import { commandsFor, filterCommands, slashQuery } from './commands';
import { formatTime, localeChoice, setLocaleChoice, timeZoneChoice, setTimeZoneChoice, resolvedTimeZone, resolvedLocale, COMMON_ZONES, markdownEnabled, setMarkdownEnabled, themeChoice, setThemeChoice, resolvedTheme, applyTheme, type LocaleChoice, type ThemeChoice } from './prefs';
import type { AppState, ChatItem, HostState, ImageRef, Pane, SessionState, Snapshot } from './model';
import './styles.css';

// Above this many desktops the list starts collapsed.
const COLLAPSE_AFTER = 5;

const subscribe = (listener: () => void) => controller.subscribe(listener);
const getSnapshot = () => controller.getState();
let initialized = false;

function initialize() {
  if (initialized) return;
  initialized = true;
  void controller.initialize().catch(() => {});
}

/**
 * Sessions, grouped by the workspace they belong to.
 *
 * The workspace is Herdr's own division of a desktop, so this keeps the phone
 * list in the same shape as the desktop's tabs. The group header carries the
 * path: a workspace name alone ("app") says little when three machines are
 * paired. Order is fixed rather than by recency, because a list that reorders
 * under the thumb is how the wrong session gets opened.
 */
export interface SessionGroup {
  id: string
  title: string
  path: string
  /** One row per tab: the tab's first pane. The rest are reached by swiping. */
  panes: Pane[]
  /** Every pane behind the rows above, so unread and counts cover the tab. */
  members: Pane[]
}

/**
 * Sessions, grouped by workspace, one row per tab.
 *
 * A split tab is one session to the user — the same work, shown in two panes —
 * so listing every pane would repeat the title and the path while offering no
 * way to tell the rows apart. The row stands for the tab; the panes themselves
 * are pages inside it.
 */
export function sessionGroups(snapshot: Snapshot | undefined): SessionGroup[] {
  if (!snapshot) return []
  const groups = new Map<string, SessionGroup>()
  const seenTab = new Set<string>()
  for (const pane of snapshot.panes) {
    const workspace = snapshot.workspaces.find(item => item.workspace_id === pane.workspace_id)
    const id = workspace?.workspace_id ?? pane.workspace_id ?? 'other'
    const path = workspace?.cwd || pane.cwd || ''
    if (!groups.has(id)) {
      groups.set(id, {
        id,
        title: workspace?.label || workspace?.name || path.split('/').filter(Boolean).pop() || t('其他'),
        path,
        panes: [],
        members: [],
      })
    }
    const group = groups.get(id)!
    group.members.push(pane)
    // A tab is represented once, by its first pane in the desktop's order.
    const tab = pane.tab_id || pane.pane_id
    if (seenTab.has(tab)) continue
    seenTab.add(tab)
    group.panes.push(pane)
  }
  return [...groups.values()]
}

function hostStatus(host: HostState): string {
  if (host.status === 'disabled') return t('已关闭');
  if (host.status === 'connecting') return t('连接中');
  if (host.status === 'error') return t('连接失败');
  if (host.status !== 'online') return t('未连接');
  return host.herdrOnline ? t('已连接') : t('Herdr 离线');
}

function canUseHost(host?: HostState): boolean {
  return host?.status === 'online' && host.herdrOnline;
}

/**
 * Connection state. In the session header the word is dropped while online:
 * the dot carries it, and the room is worth more to the chips beside it.
 */
/** Which way a connection currently reaches the desktop. */
function routeLabel(host: HostState): string | undefined {
  if (!canUseHost(host) || !host.route) return undefined;
  return host.route === 'direct' ? t('lan') : t('relay');
}

function Status({ host, compact = false }: { host: HostState; compact?: boolean }) {
  const ready = canUseHost(host);
  const route = routeLabel(host);
  const label = route ? `${hostStatus(host)} · ${route}` : hostStatus(host);
  return <span className={`connection-status ${ready ? 'is-online' : host.status === 'error' ? 'is-error' : host.status === 'disabled' ? 'is-disabled' : ''}${compact && ready ? ' is-compact' : ''}`} title={label}>
    <span className={`status-dot ${host.status === 'connecting' ? 'is-pending' : ''}`} aria-hidden="true" />
    {compact && ready ? <span className="sr-only">{label}</span> : label}
  </span>;
}

/** A one-off confirmation that a connection took the local path. */
function useDirectToast(hosts: HostState[]) {
  const [shown, setShown] = useState<string>();
  const seen = useRef(new Set<string>());
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setShown(undefined), 2600);
    return () => clearTimeout(timer);
  }, [shown]);
  useEffect(() => {
    for (const host of hosts) {
      if (host.route !== 'direct') continue;
      // Once per desktop per app run: the point is to explain the first
      // switch, not to keep announcing something that is now normal.
      if (seen.current.has(host.host.id)) continue;
      seen.current.add(host.host.id);
      setShown(host.host.name);
      break;
    }
  }, [hosts]);
  return shown;
}

/**
 * The agent's mark: the product's own artwork, with no plate behind it.
 *
 * The supplied icons keep their original colours. They are used as-is: no
 * tinting, no dimming, because a recoloured logo reads as a different logo —
 * the pale pink of Claude's star turned into something else entirely once it
 * was derived from a white background.
 */
function AgentBadge({ agent, size = 'md' }: { agent?: string; size?: 'md' | 'sm' }) {
  const px = size === 'sm' ? 16 : 22
  if (!agent) return <span className={`agent-badge is-terminal is-${size}`} aria-hidden="true"><Terminal size={px - 4} /></span>
  const spec = agentMark(agent)
  if (!spec) return <span className={`agent-badge is-plain is-${size}`} aria-hidden="true" title={agentLook(agent).label}>{(agentLook(agent).label || agent).slice(0, 1).toUpperCase()}</span>
  return <span className={`agent-badge is-mark is-${size}`} aria-hidden="true" title={spec.label}>
    <img src={spec.src} width={px} height={px} alt="" draggable={false} />
  </span>
}

function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <div className={`notice ${error ? 'notice-error' : ''}`} role={error ? 'alert' : 'status'}>
    <CircleAlert size={17} aria-hidden="true" /><div>{children}</div>
  </div>;
}

function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return <div className="empty-state">{icon}<h2>{title}</h2>{children}</div>;
}

function Loading({ label }: { label: string }) {
  return <div className="loading-state" role="status"><Loader2 className="spin" size={18} aria-hidden="true" />{label}</div>;
}

/** Plain-text fallback: preserves the model's line breaks verbatim. */
function SourceText({ text }: { text: string }) {
  // The raw bytes, fences and all. Rebuilding the fence as a copy-card is what
  // made this view look identical to the rendered one on a code-heavy reply,
  // which is why the toggle appeared to do nothing.
  return <div className="message-content"><div className="prose-text source-text">{stripAnsi(text)}</div></div>;
}

/** Renders markdown or its source, depending on the reader's preference. */
function RichText({ text, markdown }: { text: string; markdown: boolean }) {
  const plain = stripAnsi(text);
  if (!markdown) return <SourceText text={text} />;
  return <div className="message-content"><Markdown text={plain} /></div>;
}

function printable(value: unknown): string {
  if (typeof value === 'string') return stripAnsi(value);
  try { return JSON.stringify(value, null, 2) ?? ''; } catch { return t('内容无法显示'); }
}

/**
 * "24 commands · 1 file edited · 27 files read", as compactly as the language
 * allows.
 *
 * This line is a footnote, so it is built to stay on one: short labels, a
 * middle dot between them, and no verb per item. The long form ("执行了 1 条
 * 命令，读取了 1 个文件") wrapped onto two lines and pushed the answer down.
 */
function workSummary(counts: readonly WorkCount[]): string {
  if (!counts.length) return t('思考中')
  return counts.map(({ kind, count }) => {
    const n = String(count)
    if (kind === 'command') return tWith('{count} 条命令', { count: n })
    if (kind === 'edit') return tWith('{count} 个文件已修改', { count: n })
    if (kind === 'read') return tWith('{count} 个文件已读', { count: n })
    if (kind === 'search') return tWith('{count} 次搜索', { count: n })
    if (kind === 'fetch') return tWith('{count} 个网页', { count: n })
    if (kind === 'subagent') return tWith('{count} 个子 agent', { count: n })
    return tWith('{count} 个其它步骤', { count: n })
  }).join(' · ')
}

/**
 * The step's own name.
 *
 * The transcript names are the agent's own (`Bash`, `Read`, `Edit`, and for
 * other agents `shell`, `view`, `apply_patch`), which is what a reader who
 * uses that agent expects to see. Only a row without one gets a stand-in.
 */
function stepLabel(item: ChatItem): string {
  if (!item.tool) return t('思考')
  return item.tool.name || t('工具调用')
}

/** The command a shell step ran, when the desktop recorded it. */
function stepDetail(item: ChatItem): string | undefined {
  const input = item.tool?.input as Record<string, unknown> | undefined
  if (!input) return undefined
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'description']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

/**
 * A folded run of work: tool calls and the agent's own thinking.
 *
 * Three layers, because that is how much detail a reader wants at a time: the
 * line says what happened in counts, opening it lists the steps, and opening a
 * step shows its input, output and pictures. Nothing is dropped, it is only out
 * of the way — which is what makes the answer readable.
 *
 * While the burst is still going the line breathes and counts up, so a long
 * stretch of work does not look like a frozen screen.
 */
function WorkGroup({ items, running, counts, hostId, paneId, onOpenImage, localImages }: { items: ChatItem[]; running: boolean; counts: WorkCount[]; hostId: string; paneId: string; onOpenImage(src: string): void; localImages?: Record<string, LocalMediaEntry> }) {
  const active = running ? [...items].reverse().find((item) => item.tool && item.tool.done !== true) : undefined;
  // Pictures are results, not process: they sit below the folded line, visible
  // without opening it. A run that produced a screenshot is exactly the case
  // where the user must not have to guess that something is hidden inside.
  const images = useMemo(() => workImages(items), [items]);
  // Keep the producing tool next to each picture. A Bash screenshot and a
  // browser capture are both images, but not the same kind of evidence.
  const imageSources = useMemo(() => workImageSources(items), [items]);
  return <>
  <details className={`work-group${running ? ' is-running' : ''}`}>
    <summary>
      <span className={`work-spinner${running ? ' is-running' : ''}`} aria-hidden="true" />
      <span className="work-copy">
        <strong>{workSummary(counts)}</strong>
        {/* Only a live run says what it is doing; a finished one does not need
            a second line restating its own step count. */}
        {running && <small>{active ? (active.tool?.name || t('工具调用')) : t('思考')}</small>}
      </span>
      <ChevronDown size={15} aria-hidden="true" />
    </summary>
    <div className="work-body">{items.map((item) => <WorkStep item={item} hostId={hostId} key={item.id} />)}</div>
  </details>
      {images.length > 0 && <div className="transcript-images is-run">
    {images.map((image, index) => <div className="transcript-image-result" key={`${image.url}:${index}`}>
      {imageSources.has(image.url) && <span className="transcript-image-source">{tWith('来自 {tool}', { tool: imageSources.get(image.url)! })}</span>}
      <TranscriptImage hostId={hostId} url={image.url} mediaType={image.mediaType} onOpen={onOpenImage} thumbnail local={localCopy(localImages, localMediaOwner(hostId, paneId), image.url)} />
    </div>)}
  </div>}
  </>;
}

/** One step inside a folded run; opens to its input, output and pictures. */
function WorkStep({ item, hostId }: { item: ChatItem; hostId: string }) {
  if (isThinking(item)) {
    // Thinking has no input or output, only prose: shown in place, dimmed, so
    // the reasoning is readable without pretending it is an answer.
    return <div className="work-step is-thinking">{item.text || item.summary}</div>;
  }
  const done = item.tool?.done === true;
  const detail = stepDetail(item);
  return <details className="work-step">
    <summary>
      <span className={`tool-dot${done ? '' : ' is-running'}`} aria-hidden="true" />
      <span className="work-step-name">{stepLabel(item)}</span>
      {detail && <span className="work-step-detail">{detail}</span>}
      <span className="work-step-state">{done ? t('完成') : t('进行中')}</span>
      <ChevronDown size={13} aria-hidden="true" />
    </summary>
    {item.tool?.input !== undefined && <div className="tool-section"><span className="field-label">{t('输入')}</span><pre tabIndex={0}>{printable(item.tool.input)}</pre></div>}
    {item.tool?.output !== undefined && <div className="tool-section"><span className="field-label">{t('输出')}</span><pre tabIndex={0}>{printable(item.tool.output)}</pre></div>}
  </details>;
}

/**
 * One image from the transcript.
 *
 * Fetched through the tunnel rather than pointed at with an `<img src>`: the
 * path is only meaningful inside the encrypted connection, and a message must
 * not be able to make the WebView issue a request of its choosing. The object
 * URL is owned by this component and revoked when it unmounts or the source
 * changes, so opening a long conversation cannot leak every picture it showed.
 */
function TranscriptImage({ hostId, url, mediaType, onOpen, thumbnail = false, local }: { hostId: string; url: string; mediaType?: string; onOpen(src: string): void; thumbnail?: boolean; local?: string }) {
  const [src, setSrc] = useState<string | undefined>(local);
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    // A picture this phone attached is already decoded here; the desktop keeps
    // it as a generic file and will not hand it back through the image route.
    if (local) { setSrc(local); setError(false); return () => { alive = false } }
    setSrc(undefined);
    setError(false);
    void controller.fetchSessionImage(hostId, url).then((src) => {
      if (!alive) return;
      setSrc(src);
    }).catch(() => { if (alive) setError(true) });
    return () => { alive = false };
  }, [hostId, url, local]);
  if (error) return <div className="transcript-image is-blocked" title={t('桌面端没有返回这张图片')}>{t('图片无法显示')}</div>;
  if (!src) return <div className="transcript-image is-loading" role="status" aria-label={t('正在读取图片')}><Loader2 size={16} className="spin" /></div>;
  // A button, not an anchor: the tap target used to navigate the WebView to the
  // blob, which is a same-origin document rather than a picture. It now opens
  // the in-app viewer, where the image can be zoomed.
  return <button type="button" className={`transcript-image${thumbnail ? ' is-thumb' : ''}`} onClick={() => onOpen(src)} title={t('查看大图')} aria-label={t('查看大图')}>
    <img src={src} alt={t('对话中的图片')} loading="lazy" />
  </button>;
}

function Message({ item, markdown, hostId, paneId, onOpenImage, localImages }: { item: ChatItem; markdown: boolean; hostId: string; paneId: string; onOpenImage(src: string): void; localImages?: Record<string, LocalMediaEntry> }) {
  const isUser = item.kind === 'user' || item.from === 'user' || item.from === 'human';
  const role = isUser ? t('你') : item.kind === 'system' ? t('系统') : item.kind === 'error' ? t('错误') : t('助手');
  // Pictures written as paths in the body are shown as pictures. The desktop's
  // transcript often references a screenshot by path only, and a reader who has
  // to copy that path to a computer to see it is not being shown the result.
  const inlineImages = useMemo(() => imagePaths(item.text || item.summary), [item.text, item.summary]);
  const body = useMemo(() => inlineImages.length ? withoutImagePaths(item.text || item.summary || '', inlineImages) : (item.text || item.summary), [item.text, item.summary, inlineImages]);
  const text = body;
  const time = formatTime(item.time);
  // Only replies are worth copying: a tap on your own message, a system line or
  // an error row would just hand back what is already on screen.
  const copyable = Boolean(text) && !isUser && item.kind !== 'system' && item.kind !== 'error' && !item.tool;
  return <article className={`message ${isUser ? 'message-user' : ''} ${item.kind === 'error' ? 'message-error' : ''}`}>
    <div className="message-meta"><span>{role}</span>
      <span className="message-meta-right">{time && <time dateTime={item.time}>{time}</time>}
        {copyable && <CopyButton text={stripAnsi(text!)} label={t('复制回复')} compact className="message-copy" />}
      </span>
    </div>
    {text && <RichText text={text} markdown={markdown} />}
    {(item.images?.length || inlineImages.length) ? <div className="transcript-images">
      {[...(item.images ?? []), ...inlineImages.map((url): ImageRef => ({ url }))].map((image, index) => <TranscriptImage key={`${image.url}:${index}`} hostId={hostId} url={image.url} mediaType={image.mediaType} onOpen={onOpenImage} local={localCopy(localImages, localMediaOwner(hostId, paneId), image.url)} />)}
    </div> : null}
    {!text && !item.tool && <p className="muted">{t('此条记录没有文本内容')}</p>}
  </article>;
}

/**
 * Adding a desktop is its own screen: the form is long, needs the camera, and
 * should not push the settings list around.
 */
function AddHost({ onBack, onAdded }: { onBack(): void; onAdded(): void }) {
  const [name, setName] = useState('');
  // A link that arrived from the system (`alma://connect`) is already on the
  // clipboard-equivalent path: it fills the field, and everything else about
  // the form stays the same, so the user still sees and confirms what is
  // being paired before it is saved.
  const [pairing, setPairing] = useState(() => takePendingLink());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // A link that arrived from the system is shown as text, not masked bullets:
  // any app or page can hand this app an `alma://connect` intent, and the
  // credential it carries is the whole question. Hiding it would make a
  // phishing link indistinguishable from the one the user just asked the
  // desktop to send.
  const [reveal, setReveal] = useState(() => Boolean(pairing));
  const [scanning, setScanning] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const lock = useRef(false);
  useEffect(() => { requestAnimationFrame(() => nameInput.current?.focus()) }, []);
  // Closing the scanner with Back must also clear the overlay.
  const overlay = useOverlay();
  useEffect(() => { if (!overlay && scanning) setScanning(false) }, [overlay]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current || !name.trim() || !pairing.trim()) return;
    lock.current = true;
    setSaving(true);
    setError('');
    try {
      await controller.addHost(name.trim(), pairing.trim());
      onAdded();
    } catch {
      setError(t('节点未保存。请检查配对链接或连接状态后重试。'));
    } finally {
      // A failed import must not leave the credential on screen.
      setPairing('');
      setSaving(false);
      lock.current = false;
    }
  }

  return <section className="settings-view">
    <header className="page-header">
      <button className="icon-button" title={t('返回')} aria-label={t('返回')} onClick={onBack}><ArrowLeft size={21} /></button>
      <div className="header-copy"><h1>{t('添加节点')}</h1><p>{t('扫描二维码或粘贴配对链接')}</p></div>
    </header>
    <div className="page-scroll">
      {error && <Notice error>{error}</Notice>}
      <form className="add-host-form" onSubmit={submit}>
        <label htmlFor="host-name">{t('节点名称')}</label>
        <input ref={nameInput} id="host-name" value={name} onChange={(event) => setName(event.target.value)} placeholder={t('例如：工作电脑')} maxLength={80} autoComplete="off" required disabled={saving} />
        <div className="field-label-row">
          <label htmlFor="pairing-link">{t('配对链接')}</label>
          <div className="field-actions">
            <button type="button" className="reveal-button" disabled={saving} onClick={() => { setScanning(true); openOverlay({ kind: 'scan' }) }}><Camera size={15} />{t('扫码')}</button>
            <button type="button" className="reveal-button" disabled={saving || !pairing} onClick={() => setReveal((value) => !value)}>
              {reveal ? <EyeOff size={15} /> : <Eye size={15} />}{reveal ? t('隐藏链接') : t('显示链接')}
            </button>
          </div>
        </div>
        <textarea
          id="pairing-link"
          className={`pairing-input${reveal ? ' is-revealed' : ''}`}
          value={pairing}
          onChange={(event) => setPairing(event.target.value)}
          placeholder={t('粘贴以 alma://connect 开头的配对链接')}
          rows={3}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          inputMode="text"
          aria-describedby="pairing-privacy"
          required
          disabled={saving}
        />
        <p className="field-hint" id="pairing-privacy">{reveal ? t('内容已显示，注意遮挡屏幕。') : t('配对内容已遮挡，点「显示」可核对地址。')}{t('保存后自动清空。')}</p>
        <button className="primary-button" type="submit" disabled={!name.trim() || !pairing.trim() || saving}>
          {saving ? <Loader2 className="spin" size={17} /> : <Plus size={17} />}{saving ? t('正在添加') : t('添加节点')}
        </button>
      </form>
      <ScanPairing
        open={scanning}
        onClose={() => { setScanning(false); closeOverlay() }}
        onScanned={(link) => { setScanning(false); closeOverlay(); setPairing(link); setReveal(false) }}
      />
    </div>
  </section>;
}

/** One line explaining what the chosen mode actually costs. */
function keepAliveHint(): string {
  const mode = keepAliveMode()
  if (mode === 'always') return t('一直保持连接，通知栏会有一条常驻提示。')
  if (mode === 'off') return t('不保持连接，只在应用打开时提醒。')
  return t('只在 agent 工作时短暂保活，结束就自动停止；通知栏不会常驻。')
}

function HostSettings({ hosts, onClose, onOpen, onLocaleChange }: { hosts: HostState[]; onClose: () => void; onOpen: (id: string) => void; onLocaleChange(): void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const overlay = useOverlay();
  const [forgetting, setForgetting] = useState<string>();
  const [removing, setRemoving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  /** The desktop whose edit sheet is up (what it is about; the overlay says open). */
  const [editing, setEditing] = useState<string>();
  const editOpen = overlay?.kind === 'editHost';
  /** Host whose pairing link is on screen; the value is only built on request. */
  const [sharing, setSharing] = useState<string>();
  const [shareLink, setShareLink] = useState('');
  const [shareCopied, setShareCopied] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  // Long lists stay short by default; a user who expands keeps it expanded.
  const visibleHosts = collapsed && hosts.length > COLLAPSE_AFTER ? hosts.slice(0, COLLAPSE_AFTER) : hosts;
  // Re-render so the resolved locale/zone shown under each control refreshes.
  const [, setTick] = useState(0);
  // Back on the physical button clears the overlay; mirror that into local state
  // so the dialog/sheet disappears instead of lingering invisibly.
  useEffect(() => {
    if (overlay) return
    if (forgetting) setForgetting(undefined)
    if (editing) setEditing(undefined)
    if (sharing) { setSharing(undefined); setShareLink('') }
    if (scanning) setScanning(false)
  }, [overlay]);
  const bump = () => setTick(value => value + 1);
  const confirmation = useRef<HTMLDialogElement>(null);
  const forgottenHost = hosts.find(host => host.host.id === forgetting);

  useEffect(() => {
    if (!forgetting) return;
    const dialog = confirmation.current;
    dialog?.showModal();
    return () => { dialog?.close(); };
  }, [forgetting]);

  async function copyShareLink() {
    try {
      if (Capacitor.isNativePlatform()) await Clipboard.write({ string: shareLink })
      else await navigator.clipboard.writeText(shareLink)
      setShareCopied(true)
      setTimeout(() => setShareCopied(false), 1600)
    } catch { setError(t('未能复制，请长按链接手动选择。')) }
  }

  async function rename(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    const value = renameValue.trim();
    if (!value) { setError(t('名称不能为空')); return; }
    setSaving(true);
    setError('');
    try {
      await controller.renameHost(editing, value);
    } catch {
      setError(t('未能重命名，请重试。'));
    } finally { setSaving(false); }
  }

  async function forget() {
    if (!forgetting || removing) return;
    setRemoving(true);
    setError('');
    try {
      await controller.forgetHost(forgetting);
      setForgetting(undefined);
    } catch {
      setError(t('未能移除此节点，请重试。'));
    } finally { setRemoving(false); }
  }

  return <section className="settings-view">
    <header className="page-header">
      {hosts.length > 0 ? <button className="icon-button" title={t('返回会话')} aria-label={t('返回会话')} onClick={onClose}><ArrowLeft size={21} /></button> : <span className="icon-button" aria-hidden="true" />}
      <div className="header-copy"><h1>{t('设置')}</h1><p>{tWith('{count} 个节点', { count: hosts.length })}</p></div>
      <button className="icon-button" title={t('添加节点')} aria-label={t('添加节点')} onClick={() => push({ name: 'addHost' })}><Plus size={21} /></button>
    </header>
    <div className="page-scroll settings-scroll">
      {error && <Notice error>{error}</Notice>}

      <section className="settings-group">
        <h2 className="group-title">{t('节点')}</h2>
        <p className="group-hint">{t('每台桌面单独配对。点名称切换，右侧可重连或移除。')}</p>
        {hosts.length > 0 ? <ul className={`host-list${collapsed ? ' is-collapsed' : ''}`}>
          {visibleHosts.map(host => <li className={`host-row${host.host.enabled === false ? ' is-off' : ''}`} key={host.host.id}>
            {/* One line per node: the identity, one state, and the switch.
                Four icon buttons and a switch on the same line is what made the
                name collide with the QR button on a phone; everything except
                the switch now lives in the edit sheet. */}
            <button className="host-open" onClick={() => onOpen(host.host.id)}>
              <span className="host-open-main">
                <Server size={17} className="muted" aria-hidden="true" />
                <strong>{host.host.name}</strong>
                {/* The only dot on this line is news. Connection state is the
                    text below it, so the two can no longer be confused. */}
                {host.snapshot && unreadPanes([host]).length > 0 && <span className="news-dot" role="img" aria-label={t('有新消息')} title={t('有新消息')} />}
              </span>
              <Status host={host} />
            </button>
            {/* The switch stays on the row: turning a desktop off releases its
                tunnel, which is the one thing worth doing without opening it. */}
            <span className="switch host-switch">
              <input type="checkbox" role="switch" checked={host.host.enabled !== false} aria-label={tWith('启用 {name}', { name: host.host.name })} onChange={(event) => { void controller.setHostEnabled(host.host.id, event.target.checked).catch(() => setError(t('未能切换节点状态，请重试。'))) }} />
              <span className="switch-track" aria-hidden="true" />
            </span>
            <button type="button" className="icon-button host-edit" title={tWith('设置 {name}', { name: host.host.name })} aria-label={tWith('设置 {name}', { name: host.host.name })} onClick={() => { setEditing(host.host.id); setError(''); openOverlay({ kind: 'editHost' }) }}><Pencil size={17} /></button>
            {host.stopReason && <span className="host-stopped">
              {stopMessage(host.stopReason)}
              <button type="button" className="inline-button" onClick={() => controller.retryHost(host.host.id)}>{t('立即重试')}</button>
            </span>}
            {!host.stopReason && host.status !== 'online' && typeof host.retriesLeft === 'number' && host.retriesLeft > 0 && host.status === 'error' && <span className="host-retries">{t('剩余重试')} {host.retriesLeft}</span>}
            {host.error && <div className="host-row-error"><Notice error>{host.error}</Notice></div>}
          </li>)}
        </ul> : <EmptyState icon={<Server size={26} />} title={t('尚未添加节点')}><button type="button" className="primary-button" onClick={() => push({ name: 'addHost' })}><Plus size={17} />{t('添加节点')}</button></EmptyState>}
        {hosts.length > COLLAPSE_AFTER && <button type="button" className="text-button host-toggle" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>
          {collapsed ? <><ChevronDown size={16} />{tWith('展开全部 {count} 个节点', { count: hosts.length })}</> : <><ChevronUp size={16} />{t('收起')}</>}
        </button>}
      </section>

      <section className="settings-group">
        <h2 className="group-title">{t('显示')}</h2>
        <label className="select-row">
          <span><strong>{t('外观')}</strong><small>{t('当前值')}: {resolvedTheme() === 'dark' ? t('深色') : t('浅色')}</small></span>
          <select defaultValue={themeChoice()} onChange={event => { setThemeChoice(event.target.value as ThemeChoice); bump() }}>
            <option value="system">{t('跟随系统')}</option>
            <option value="light">{t('浅色')}</option>
            <option value="dark">{t('深色')}</option>
          </select>
        </label>
        <label className="select-row">
          <span><strong>{t('语言')}</strong><small>{t('当前值')}: {resolvedLocale()}</small></span>
          <select defaultValue={localeChoice()} onChange={event => { setLocaleChoice(event.target.value as LocaleChoice); bump(); onLocaleChange() }}>
            <option value="system">{t('跟随系统')}</option>
            <option value="zh-CN">{t('简体中文')}</option>
            <option value="en">English</option>
          </select>
        </label>
        <label className="select-row">
          <span><strong>{t('时区')}</strong><small>{t('当前值')}: {resolvedTimeZone()}</small></span>
          <select defaultValue={timeZoneChoice()} onChange={event => { setTimeZoneChoice(event.target.value); bump() }}>
            <option value="system">{t('跟随系统')}</option>
            {[...new Set([timeZoneChoice(), ...COMMON_ZONES])].filter(zone => zone !== 'system').map(zone => <option key={zone} value={zone}>{zone}</option>)}
          </select>
        </label>
        <label className="toggle-row">
          <span><strong>{t('渲染 Markdown')}</strong><small>{t('关闭后显示模型输出的原始文本，可在会话里随时切换。')}</small></span>
          <span className="switch"><input type="checkbox" defaultChecked={markdownEnabled()} onChange={event => setMarkdownEnabled(event.target.checked)} aria-label={t('渲染 Markdown')} /><span className="switch-track" aria-hidden="true" /></span>
        </label>
      </section>

      <section className="settings-group">
        <h2 className="group-title">{t('通知与后台')}</h2>
        <label className="toggle-row">
          <span><strong>{t('agent 需要你或已完成时提醒')}</strong><small>{t('不会上传任何内容。')}</small></span>
          <span className="switch"><input type="checkbox" defaultChecked={notificationsEnabled()} onChange={event => {
            setNotificationsEnabled(event.target.checked)
            if (event.target.checked) void localNotifier.request()
          }} aria-label={t('agent 需要你或已完成时提醒')} /><span className="switch-track" aria-hidden="true" /></span>
        </label>
        <label className="select-row">
          <span><strong>{t('后台保活')}</strong><small>{keepAliveHint()}</small></span>
          <select defaultValue={keepAliveMode()} onChange={event => { setKeepAliveMode(event.target.value as KeepAliveMode); void applyKeepAlive(event.target.value as KeepAliveMode, replyInProgress(hosts)) }} aria-label={t('后台保活')}>
            <option value="reply">{t('仅回复进行中')}</option>
            <option value="always">{t('始终')}</option>
            <option value="off">{t('从不')}</option>
          </select>
        </label>
        <button type="button" className="secondary-button" onClick={() => void localNotifier.notify({ hostId: 'test', hostName: '本机', paneId: 'test', title: '测试通知 · Herdr', body: '如果你看到这条，通知功能正常。', kind: 'done' }).catch(() => undefined)}>{t('发送测试通知')}</button>
      </section>

      <section className="settings-group">
        <h2 className="group-title">{t('网络')}</h2>
        <label className="toggle-row">
          <span><strong>{t('查找局域网直连')}</strong><small>{t('在同一网络时自动改用直连，明显更快。会扫描当前网段来定位已配对的桌面；在公司等受管网络可以关闭。')}</small></span>
          <span className="switch"><input type="checkbox" defaultChecked={lanDiscoveryEnabled()} onChange={event => { setLanDiscoveryEnabled(event.target.checked); controller.lanDiscoveryChanged(event.target.checked) }} aria-label={t('查找局域网直连')} /><span className="switch-track" aria-hidden="true" /></span>
        </label>
      </section>

      <section className="settings-group">
        <h2 className="group-title">{t('关于')}</h2>
        <dl className="about-list">
          <div><dt>{t('应用')}</dt><dd>Alma Android</dd></div>
          <div><dt>{t('版本')}</dt><dd>{APP_VERSION} ({t('构建版本')} {BUILD_TIME})</dd></div>
          <div><dt>{t('包名')}</dt><dd>{APP_ID}</dd></div>
          <div><dt>{t('作者')}</dt><dd>xiaotiyan</dd></div>
        </dl>
        <p className="about-thanks">{t('感谢')} <strong>yetone</strong> {t('创造')} <a href="https://alma.now" target="_blank" rel="noopener noreferrer">Alma</a>
          {t('，以及')} <a href="https://herdr.dev" target="_blank" rel="noopener noreferrer">Herdr</a> {t('让终端里的 coding agent 可以远程操作。')}
          {t('本应用为非官方客户端，与 Alma、Herdr 项目均无隶属关系。')}</p>
        <dl className="about-list">
          <div><dt>{t('许可')}</dt><dd>MIT</dd></div>
        </dl>
      </section>
    </div>
    {editing && editOpen && <div className="sheet-backdrop" role="presentation" onClick={() => { closeOverlay(); setEditing(undefined) }}>
      <div className="host-sheet host-edit-sheet" role="dialog" aria-modal="true" aria-labelledby="host-edit-title" onClick={(event) => event.stopPropagation()}>
        <h2 id="host-edit-title">{t('节点设置')}</h2>
        <p className="confirm-host">{hosts.find(item => item.host.id === editing)?.host.name}</p>

        {/* Rename: the only field on the sheet, so it saves from the keyboard. */}
        <form onSubmit={rename} className="rename-form">
          <label htmlFor="rename-input">{t('名称')}</label>
          <input
            id="rename-input"
            value={renameValue}
            onChange={event => setRenameValue(event.target.value)}
            maxLength={80}
            autoComplete="off"
            disabled={saving}
          />
          <p className="field-hint">{t('只改本机显示的名称，连接与会话不受影响。')}</p>
          <div className="dialog-actions">
            <button type="submit" className="secondary-button" disabled={saving || !renameValue.trim()}>{saving ? <Loader2 className="spin" size={16} /> : <Check size={16} />}{t('保存名称')}</button>
            <button type="button" className="secondary-button" disabled={!editing} onClick={() => { setSharing(editing); setShareLink(pairingLink(hosts.find(item => item.host.id === editing)!.host)); setShareCopied(false); setEditing(undefined); openOverlay({ kind: 'share' }) }}><QrCode size={16} />{t('连接链接')}</button>
          </div>
        </form>

        {/* Actions that used to sit as icons on the row, where four of them and
            a switch left no room for the name. */}
        <div className="host-edit-actions">
          <button type="button" className="secondary-button" disabled={removing || hosts.find(item => item.host.id === editing)?.status === 'connecting'} onClick={() => { const id = editing; setEditing(undefined); closeOverlay(); if (id) controller.retryHost(id) }}><RefreshCw size={16} />{t('重新连接')}</button>
        </div>

        {error && <Notice error>{error}</Notice>}

        <button type="button" className="destructive-button host-edit-delete" disabled={removing} onClick={() => { setForgetting(editing); openOverlay({ kind: 'forget' }) }}><Trash2 size={16} />{t('删除这个节点')}</button>
        <p className="field-hint">{t('只移除这台手机上的连接凭据，不会删除桌面上的会话。')}</p>
        <button type="button" className="secondary-button sheet-cancel" onClick={() => { closeOverlay(); setEditing(undefined) }}>{t('关闭')}</button>
      </div>
    </div>}
    {sharing && <dialog className="confirm-dialog share-dialog" open aria-labelledby="share-title">
      <h2 id="share-title">{t('在另一台设备上连接')}</h2>
      <p className="confirm-host">{hosts.find(item => item.host.id === sharing)?.host.name}</p>
      <p className="field-hint">{t('把这段链接粘贴到另一台手机的「添加节点」里即可。它等同于这台桌面的完整访问权，请只发给你自己。')}</p>
      <textarea className="share-link" readOnly value={shareLink} rows={4} spellCheck={false} aria-label={t('连接链接')} onFocus={(event) => event.currentTarget.select()} />
      <div className="dialog-actions">
        <button type="button" className="secondary-button" onClick={() => { setSharing(undefined); setShareLink(''); closeOverlay() }}>{t('关闭')}</button>
        <button type="button" className="primary-button" onClick={() => void copyShareLink()}>{shareCopied ? <Check size={16} /> : <Copy size={16} />}{shareCopied ? t('已复制') : t('复制链接')}</button>
      </div>
    </dialog>}
    {forgetting && <dialog className="confirm-dialog" ref={confirmation} onCancel={event => { if (removing) event.preventDefault(); else setForgetting(undefined); }} aria-labelledby="forget-title" aria-describedby="forget-description">
      <h2 id="forget-title">{t('忘记此节点？')}</h2>
      <p className="confirm-host">{forgottenHost?.host.name}</p>
      <p id="forget-description">{t('此设备上的连接凭据将被移除。重新连接需要再次配对，不会删除远端会话。')}</p>
      {error && <Notice error>{error}</Notice>}
      <div className="dialog-actions"><button className="secondary-button" disabled={removing} onClick={() => { setForgetting(undefined); closeOverlay() }}>{t('取消')}</button><button className="destructive-button" disabled={removing} onClick={() => void forget()}>{removing ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}确认忘记</button></div>
    </dialog>}
  </section>;
}

/**
 * Watches every host snapshot and raises a local notification when an agent
 * starts waiting for the user or finishes. Native only; no server involved.
 */
function useAlerts(hosts: HostState[]) {
  const tracker = useRef<AlertTracker>()
  if (!tracker.current) tracker.current = new AlertTracker()
  useEffect(() => {
    void localNotifier.permission().then(async state => {
      if (state === 'prompt' && notificationsEnabled()) await localNotifier.request()
    })
  }, [])
  const [alertsRevision, setAlertsRevision] = useState(0)
  useEffect(() => {
    const onChange = () => setAlertsRevision((value) => value + 1)
    window.addEventListener(ALERTS_EVENT, onChange)
    return () => window.removeEventListener(ALERTS_EVENT, onChange)
  }, [])
  useEffect(() => {
    // Read the preference every time rather than capturing it at mount, so
    // turning alerts off takes effect immediately instead of after a restart.
    if (!notificationsEnabled()) return
    const hostStates = hosts.map(host => ({
      ...host,
      snapshot: host.snapshot
        ? { ...host.snapshot, panes: host.snapshot.panes.map(pane => ({ ...pane, agent_status: pane.agent_status })) }
        : undefined,
    }))
    for (const alert of tracker.current!.update(hostStates)) {
      void (async () => {
        // Bind approval buttons to the menu that caused the alert. If the
        // screen moves before this read, the tap path will still compare the
        // current menu against this fingerprint and fail closed.
        if (alert.kind === 'blocked') {
          try {
            const screen = await controller.readPaneScreen(alert.hostId, alert.paneId)
            const prompt = parsePrompt(screen)
            if (prompt) alert.promptFingerprint = await promptFingerprint(prompt)
          } catch { /* a body tap can still open the session */ }
        }
        await localNotifier.notify(alert)
      })().catch(() => undefined)
    }
  }, [hosts, alertsRevision])
}

export const ALERTS_KEY = 'herdr.alerts.enabled'
export function notificationsEnabled(): boolean {
  try { return localStorage.getItem(ALERTS_KEY) !== 'off' } catch { return true }
}

/** Broadcast a preference change so running effects re-evaluate immediately. */
export function setNotificationsEnabled(enabled: boolean) {
  try { localStorage.setItem(ALERTS_KEY, enabled ? 'on' : 'off') } catch { /* storage blocked */ }
  window.dispatchEvent(new CustomEvent(ALERTS_EVENT))
}
const ALERTS_EVENT = 'herdr:alerts-changed'

function Sessions({ state, onSettings, onOpenSession }: { state: AppState; onSettings(): void; onOpenSession(hostId: string, paneId: string): void }) {
  // Only a single pairing may be auto-selected; with several, the user chooses.
  const host = state.hosts.find(item => item.host.id === state.selectedHostId)
    ?? (state.hosts.length === 1 ? state.hosts[0] : undefined);
  const ready = canUseHost(host);
  // localStorage is the store for read state, so acknowledging a pane has to
  // force a fresh read rather than wait for a changed snapshot.
  const [unreadRevision, setUnreadRevision] = useState(0);
  useEffect(() => subscribeUnread(() => setUnreadRevision(value => value + 1)), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const news = useMemo(() => unreadPanes(state.hosts), [state.hosts, unreadRevision]);
  // Keep the record from outliving the panes it describes.
  useEffect(() => {
    pruneUnread(state.hosts.flatMap(item => (item.snapshot?.panes ?? []).map(pane => ({ hostId: item.host.id, paneId: pane.pane_id }))));
  }, [state.hosts]);
  const [opening, setOpening] = useState<string>();
  const [openError, setOpenError] = useState('');
  // Every sheet on this screen is an overlay in the router, so the hardware
  // Back closes it. The local state below only records *what* it is about
  // (which host to rename, and so on); whether it is open is the overlay.
  const overlay = useOverlay();
  const picking = overlay?.kind === 'pickHost';
  const creating = overlay?.kind === 'newSession';
  const setName = (value: boolean) => { if (value) openOverlay({ kind: 'newSession' }); else closeOverlay(); };
  const setPicking = (value: boolean) => { if (value) openOverlay({ kind: 'pickHost' }); else closeOverlay(); };
  const setCreating = setName;
  const [newKind, setNewKind] = useState('claude');
  const [newCwd, setNewCwd] = useState('');
  const [cwdMode, setCwdMode] = useState<'choice' | 'manual'>('choice');
  const [newLabel, setNewLabel] = useState('');
  const [renamingPane, setRenamingPane] = useState<string>();
  const [swipedPane, setSwipedPane] = useState<string>();
  const [deletingPane, setDeletingPane] = useState<string>();
  const deleteInFlight = useRef(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  // The pane being renamed is local; whether the form is up is the overlay.
  const renameOpen = overlay?.kind === 'renamePane';
  const openRename = (paneId: string) => { setRenamingPane(paneId); openOverlay({ kind: 'renamePane' }); };
  const closeRename = () => { setRenamingPane(undefined); closeOverlay(); };
  // Same reason as the subagent sheet: Back can clear the overlay directly.
  useEffect(() => { if (!renameOpen && renamingPane) setRenamingPane(undefined); }, [renameOpen]);
  const [renameValue, setRenameValue] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState('');
  const deleteOpen = overlay?.kind === 'deletePane';
  const deletePane = host?.snapshot?.panes.find((pane) => pane.pane_id === deletingPane);
  useEffect(() => { if (!deleteOpen && deletingPane) setDeletingPane(undefined); }, [deleteOpen, deletingPane]);
  const openingLock = useRef(false);
  useEffect(() => { setOpenError(''); }, [host?.host.id]);
  // A new session starts where the user already is: the focused pane's
  // directory, else the workspace's. Still editable before creating.
  const currentCwd = defaultSessionCwd(host?.snapshot, state.selectedPaneId);
  const knownDirectories = useMemo(() => {
    const candidates = [
      ...(host?.snapshot?.workspaces.map((workspace) => workspace.cwd) ?? []),
      ...(host?.snapshot?.panes.flatMap((pane) => [pane.cwd, pane.foreground_cwd]) ?? []),
    ]
    return [...new Set(candidates.filter((path): path is string => Boolean(path?.trim())))]
  }, [host?.snapshot]);
  useEffect(() => { setNewCwd((current) => current || currentCwd) }, [currentCwd]);

  /** Read the pane after an external picker or app switch, not from stale render closure. */
  function createWithCurrentDirectory() {
    const live = controller.getState();
    const liveHost = live.hosts.find((item) => item.host.id === state.selectedHostId);
    setNewCwd(defaultSessionCwd(liveHost?.snapshot, live.selectedPaneId));
    setCwdMode('choice');
    setCreating(true);
  }

  async function createSession() {
    if (!host || !newCwd.trim() || openingLock.current) return
    openingLock.current = true
    setCreating(false)
    setOpenError('')
    try {
      // Herdr reports the new pane in the snapshot before the agent has drawn
      // its first frame, so open it straight away and let the live updates fill
      // in; waiting a fixed moment only made the tap feel slow.
      const { paneId } = await controller.newSession(host.host.id, {
        kind: newKind,
        cwd: newCwd.trim(),
        workspaceId: host.snapshot?.workspaces[0]?.workspace_id,
        label: newLabel.trim() || undefined,
      })
      setNewLabel('')
      controller.selectHost(host.host.id)
      await controller.selectPane(paneId)
      onOpenSession(host.host.id, paneId)
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : t('无法创建会话'))
    } finally { openingLock.current = false }
  }

  function startRename(pane: Pane, current: string | undefined) {
    openRename(pane.pane_id)
    // Prefill with the name already there, so a stray tap edits rather than
    // wipes it. An unnamed session starts empty and shows the placeholder.
    setRenameValue(current ?? '')
    setRenameError('')
  }

  async function renameSession(event: FormEvent) {
    event.preventDefault()
    if (!host || !renamingPane || renameBusy) return
    setRenameBusy(true)
    setRenameError('')
    try {
      await controller.renameSession(host.host.id, renamingPane, renameValue)
      closeRename()
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : t('重命名失败'))
    } finally { setRenameBusy(false) }
  }

  async function closeSession() {
    if (!host || !deletingPane || deleteInFlight.current || openingLock.current) return
    openingLock.current = true
    deleteInFlight.current = true
    setDeleteBusy(true)
    setOpenError('')
    try {
      await controller.closeSession(host.host.id, deletingPane)
      setSwipedPane(undefined)
      setDeletingPane(undefined)
      closeOverlay()
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : t('删除会话失败'))
    } finally { deleteInFlight.current = false; setDeleteBusy(false); openingLock.current = false }
  }

  const sessionSwipe = useRef<{ id: string; x: number; y: number }>();
  const consumedSessionClick = useRef<string>();
  useEffect(() => {
    const clear = () => { consumedSessionClick.current = undefined }
    window.addEventListener('pointerup', clear)
    return () => window.removeEventListener('pointerup', clear)
  }, [])
  function trackSessionSwipe(event: TouchEvent<HTMLElement>, id: string) {
    const touch = event.touches[0]
    if (touch) {
      sessionSwipe.current = { id, x: touch.clientX, y: touch.clientY }
    }
  }
  function finishSessionSwipe(event: TouchEvent<HTMLElement>, id: string) {
    const start = sessionSwipe.current
    sessionSwipe.current = undefined
    const touch = event.changedTouches[0]
    if (!start || !touch || start.id !== id) return
    const dx = touch.clientX - start.x
    const dy = touch.clientY - start.y
    if (Math.abs(dx) >= 56 && Math.abs(dx) >= Math.abs(dy) * 1.5) {
      consumedSessionClick.current = id
      ;(document.activeElement as HTMLElement | null)?.blur()
      setSwipedPane(dx < 0 ? id : undefined)
    }
  }

  async function openPane(paneId: string) {
    if (openingLock.current || !ready) return;
    openingLock.current = true;
    setOpening(paneId);
    setOpenError('');
    try {
      if (host) controller.selectHost(host.host.id);
      await controller.selectPane(paneId);
      if (host) onOpenSession(host.host.id, paneId);
    }
    catch { setOpenError(t('未能打开会话，请检查节点连接后重试。')); }
    finally { setOpening(undefined); openingLock.current = false; }
  }

  return <section className="sessions-view">
    <header className="page-header"><div className="brand-mark" aria-hidden="true"><Terminal size={23} /></div><div className="header-copy"><h1>Herdr</h1><p>{t('会话')}</p></div><button className="icon-button" title={t('新建会话')} aria-label={t('新建会话')} disabled={!ready} onClick={createWithCurrentDirectory}><PlusCircle size={21} /></button><button className="icon-button" title={t('节点设置')} aria-label={t('节点设置')} onClick={onSettings}><Settings size={21} /></button></header>
    {host && <div className="host-selector-bar">
      <button type="button" className="host-picker" aria-label={t('当前节点')} aria-haspopup="dialog" aria-expanded={picking} disabled={state.hosts.length < 2} onClick={() => setPicking(true)}>
        <Server size={18} aria-hidden="true" /><span className="host-picker-name">{host.host.name}</span>
        {state.hosts.length > 1 && <ChevronDown size={16} aria-hidden="true" />}
      </button>
      <Status host={host} />
    </div>}
    {picking && <div className="sheet-backdrop" role="presentation" onClick={() => { setPicking(false); closeOverlay() }}>
      <div className="host-sheet" role="dialog" aria-modal="true" aria-label={t('选择节点')} onClick={event => event.stopPropagation()}>
        <h2>{t('选择节点')}</h2>
        {state.hosts.map(item => <button
          type="button"
          key={item.host.id}
          className={`sheet-option${item.host.id === host?.host.id ? ' is-current' : ''}`}
          aria-current={item.host.id === host?.host.id}
          onClick={() => { controller.selectHost(item.host.id); setPicking(false); closeOverlay(); }}
        >
          <span className="sheet-option-copy"><strong>{item.host.name}</strong><Status host={item} /></span>
          {item.host.id === host?.host.id ? <Check size={18} aria-hidden="true" /> : null}
        </button>)}
        <button type="button" className="sheet-option sheet-add" onClick={() => { setPicking(false); push({ name: 'addHost' }) }}>
          <span className="sheet-option-copy"><strong>{t('添加节点')}</strong></span>
          <Plus size={18} aria-hidden="true" />
        </button>
        <button type="button" className="secondary-button sheet-cancel" onClick={() => setPicking(false)}>{t('取消')}</button>
      </div>
    </div>}
    {creating && <div className="sheet-backdrop" role="presentation" onClick={() => setCreating(false)}>
      <form className="host-sheet new-session" role="dialog" aria-modal="true" aria-label={t('新建会话')}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => { event.preventDefault(); void createSession() }}>
        <h2>{t('新建会话')}</h2>
        <label htmlFor="new-kind">{t('Agent')}</label>
        <select id="new-kind" value={newKind} onChange={(event) => setNewKind(event.target.value)}>
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
          <option value="pi">pi</option>
        </select>
        <span className="field-label-row"><label htmlFor={cwdMode === 'choice' ? 'new-cwd-choice' : 'new-cwd'}>{t('工作目录')}</label>
          <button type="button" className="text-button field-switch" onClick={() => setCwdMode((value) => value === 'choice' ? 'manual' : 'choice')}>
            {t(cwdMode === 'choice' ? '手动输入' : '选择已有目录')}
          </button>
        </span>
        {cwdMode === 'choice' && knownDirectories.length > 0
          ? <select id="new-cwd-choice" value={newCwd} onChange={(event) => setNewCwd(event.target.value)} aria-label={t('选择已有目录')}>
            {knownDirectories.map((path) => <option key={path} value={path}>{path}</option>)}
          </select>
          : <input id="new-cwd" value={newCwd} onChange={(event) => setNewCwd(event.target.value)} placeholder={t('输入桌面上的绝对路径')} autoComplete="off" spellCheck={false} />}
        <label htmlFor="new-label">{t('会话名称')}</label>
        <input id="new-label" value={newLabel} onChange={(event) => setNewLabel(event.target.value)} placeholder={t('可选，稍后也能改')} maxLength={80} autoComplete="off" spellCheck={false} />
        <p className="field-hint">{t('新会话会在这个目录下启动，可在桌面端继续。')}</p>
        <div className="dialog-actions">
          <button type="button" className="secondary-button" onClick={() => setCreating(false)}>{t('取消')}</button>
          <button type="submit" className="primary-button" disabled={!newCwd.trim()}>{t('创建')}</button>
        </div>
      </form>
    </div>}
    <div className="page-scroll">
      {openError && <Notice error>{openError}</Notice>}
      {host?.error && <Notice error>{host.error}</Notice>}
      {host && !ready && <div className="connection-action"><span>{host.status === 'disabled' ? t('这台桌面已关闭，不会自动连接。') : host.status === 'connecting' ? t('正在连接节点…') : host.status === 'online' ? t('远端 Herdr 当前不在线') : t('节点当前未连接')}</span>
        {host.status === 'disabled'
          ? <button className="secondary-button" onClick={() => void controller.setHostEnabled(host.host.id, true).catch(() => undefined)}>{t('启用')}</button>
          : <button className="secondary-button" disabled={host.status === 'connecting'} onClick={() => controller.retryHost(host.host.id)}><RefreshCw size={16} className={host.status === 'connecting' ? 'spin' : ''} />{t('重新连接')}</button>}
      </div>}
      {state.loading ? <Loading label={t('正在读取节点…')} />
        : !state.hosts.length ? <EmptyState icon={<Server size={30} />} title={t('尚未添加节点')}><button className="primary-button" onClick={onSettings}><Plus size={17} />{t('添加节点')}</button></EmptyState>
        : !host ? <div className="pick-host">
            <p className="pick-host-title">{t('选择一个节点')}</p>
            <p className="pick-host-hint">{tWith('已配对 {count} 台桌面，选择要继续的那台。', { count: state.hosts.length })}</p>
            <ul className="pick-host-list">{state.hosts.map(item => <li key={item.host.id}>
              <button type="button" className="pick-host-row" disabled={item.host.enabled === false} onClick={() => controller.selectHost(item.host.id)}>
                <Server size={19} aria-hidden="true" />
                <span className="pick-host-copy"><strong>{item.host.name}</strong><Status host={item} /></span>
                {/* A desktop is "new" when any of its sessions is: one mark on
                    the row is enough to say where to look. */}
                {item.snapshot && unreadPanes([item]).length > 0 && <span className="news-dot" role="img" aria-label={t('有新消息')} />}
                <ArrowRight size={17} className="muted" aria-hidden="true" />
              </button>
            </li>)}</ul>
            <button type="button" className="secondary-button" onClick={onSettings}>{t('管理节点')}</button>
          </div> : host.status === 'connecting' && !host.snapshot ? <Loading label={t('正在连接节点…')} /> : ready && !host.snapshot ? <Loading label={t('正在读取会话…')} /> : host.snapshot?.panes.length ? <>
        <div className="list-heading"><h2>{t('会话')}</h2><span>{host.snapshot.panes.length}</span></div>
        {/* Grouped by workspace, which is the desktop's own division. The
            header carries the full path, because a name alone does not tell
            two checkouts of the same project apart on a phone. */}
        {sessionGroups(host.snapshot).map(group => <section className="session-group" key={group.id}>
          <header className="session-group-head">
            <span className="session-group-name">{group.title}</span>
            <span className="session-group-path" title={group.path}>{group.path}</span>
            <span className="session-group-count">{group.panes.length}</span>
          </header>
          <ul className="session-list">{group.panes.map(pane => {
            // A row stands for its tab, so it is unread when *any* pane in
            // that tab is: otherwise a second pane's finished turn would never
            // show anywhere on this screen.
            const tabPanes = group.members.filter(item => (item.tab_id || item.pane_id) === (pane.tab_id || pane.pane_id))
            const unread = tabPanes.some(item => news.some(entry => entry.hostId === host.host.id && entry.paneId === item.pane_id))
            const swiped = swipedPane === pane.pane_id
    return <li
      key={pane.pane_id}
      className={`session-item${swiped ? ' is-swiped' : ''}`}
      onTouchStart={(event) => trackSessionSwipe(event, pane.pane_id)}
      onTouchEnd={(event) => finishSessionSwipe(event, pane.pane_id)}
    >
              <button
                type="button"
                className="session-delete-action"
                tabIndex={swiped ? 0 : -1}
                aria-hidden={!swiped}
                disabled={!ready || Boolean(opening) || Boolean(deletingPane)}
                aria-label={tWith('删除 {name}', { name: paneTitle(pane, tabLabelOf(host.snapshot, pane)) })}
                onClick={(event) => { event.stopPropagation(); setDeletingPane(pane.pane_id); openOverlay({ kind: 'deletePane' }) }}
              ><Trash2 size={18} aria-hidden="true" /><span>{t('删除')}</span></button>
              <div
                className="session-row-surface"
              >
                <button
                  type="button"
                  className="session-row"
                  disabled={!ready || Boolean(opening)}
                  onClick={() => {
                    if (consumedSessionClick.current === pane.pane_id) {
                      consumedSessionClick.current = undefined
                      return
                    }
                    if (swiped) { setSwipedPane(undefined); return }
                    void openPane(pane.pane_id)
                  }}
                >
                {/* The agent's own mark replaces the generic terminal glyph, so a
                    list of several sessions can be scanned without reading. */}
                <AgentBadge agent={pane.agent ?? pane.agent_session?.agent} />
                <span className="session-row-copy"><strong>{paneTitle(pane, tabLabelOf(host.snapshot, pane))}{tabPanes.length > 1 && <span className="session-pane-count" title={tWith('这个 tab 有 {count} 个面板，进会话后左右滑动切换', { count: String(tabPanes.length) })}>+{tabPanes.length - 1}</span>}</strong>{pane.cwd && <span className="session-path" title={pane.cwd}>{pane.cwd}</span>}
                  <span className="session-row-meta">
                    <span className={`agent-status-dot is-${statusTone(pane.agent_status)}`} aria-hidden="true" />
                    {agentLook(pane.agent ?? pane.agent_session?.agent).label || t('终端')}
                    {/* `blocked` and `done` collapse into one mark; `working`
                        keeps its word, because that is useful at a glance. */}
                    {pane.agent_status === 'working' && <> · {t(statusWord(pane.agent_status))}</>}
                  </span>
                </span>
                {unread ? <span className="news-dot" role="img" aria-label={t('有新消息')} title={t('有新消息')} /> : null}
                <ArrowRight size={18} className="muted session-arrow" aria-hidden="true" />
                </button>
                <span className="session-actions">
                  {opening === pane.pane_id
                    ? <Loader2 size={18} className="spin" aria-label={t('正在打开')} />
                    : <button type="button" className="session-rename" disabled={!ready} aria-label={tWith('重命名 {name}', { name: paneTitle(pane, tabLabelOf(host.snapshot, pane)) })} title={t('重命名会话')} onClick={(event) => { event.stopPropagation(); startRename(pane, tabLabelOf(host.snapshot, pane)) }}><Pencil size={16} /></button>}
                </span>
              </div>
            </li>;
          })}</ul>
        </section>)}
      </> : ready && host.snapshot ? <EmptyState icon={<MessageSquare size={30} />} title={t('暂无会话')}><p>{t('此节点还没有打开的终端会话。')}</p></EmptyState> : <EmptyState icon={<Server size={30} />} title={host.error ? t('无法读取会话') : t('等待节点连接')} />}
    </div>
    {renamingPane && renameOpen && <div className="sheet-backdrop" role="presentation" onClick={closeRename}>
      <form className="host-sheet rename-form" role="dialog" aria-modal="true" aria-label={t('重命名会话')}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => void renameSession(event)}>
        <h2>{t('重命名会话')}</h2>
        <label htmlFor="session-name" className="sr-only">{t('会话名称')}</label>
        <input id="session-name" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} maxLength={80} placeholder={t('留空则恢复默认名称')} autoComplete="off" spellCheck={false} autoFocus />
        <p className="field-hint">{t('名称只影响这项会话的显示，桌面端会同步显示。')}</p>
        {renameError && <Notice error>{renameError}</Notice>}
        <div className="dialog-actions">
          <button type="button" className="secondary-button" onClick={closeRename}>{t('取消')}</button>
          <button type="submit" className="primary-button" disabled={renameBusy}>{renameBusy ? <Loader2 className="spin" size={16} /> : <Check size={16} />}{t('保存')}</button>
        </div>
      </form>
    </div>}
    {deletePane && deleteOpen && <div className="sheet-backdrop" role="presentation" onClick={() => !deleteBusy && closeOverlay()}>
      <div className="host-sheet delete-session-sheet" role="dialog" aria-modal="true" aria-label={t('删除会话')} onClick={(event) => event.stopPropagation()}>
        <h2>{t('删除会话')}</h2>
        <p className="confirm-host">{paneTitle(deletePane, tabLabelOf(host?.snapshot, deletePane))}</p>
        <p className="field-hint">{t('这会关闭桌面端对应的终端会话，正在运行的任务也会结束。此操作无法撤销。')}</p>
        {openError && <Notice error>{openError}</Notice>}
        <div className="dialog-actions">
          <button type="button" className="secondary-button" disabled={deleteBusy} onClick={closeOverlay}>{t('取消')}</button>
          <button type="button" className="destructive-button" disabled={deleteBusy || !ready} onClick={() => void closeSession()}>
            {deleteBusy ? <Loader2 size={16} className="spin" /> : <Trash2 size={16} />}{t('删除会话')}
          </button>
        </div>
      </div>
    </div>}
  </section>;
}

function Session({ session, routePaneId, host }: { session: SessionState; routePaneId: string; host?: HostState }) {
  // Set only while there is no transcript; says which kind of "no transcript" it is.
  const gap = session.gap ?? 'terminal';
  // An agent is still a chat the user can write to even when its transcript
  // cannot be read — prompts go to the agent, not to the transcript — so only
  // a pane that has no chat at all is taken away from the message view.
  const noMessages = session.unsupported && (gap === 'terminal' || gap === 'unsupported');
  // Start on messages unless this pane is known to have no transcript.
  // Three views over the same session: the reader (messages), the raw terminal,
  // and the answer as Markdown source. `source` is not a third transcript — it
  // is the message view with rendering turned off — so it shares the reader's
  // data and only changes how it is drawn.
  const [mode, setMode] = useState<'messages' | 'terminal' | 'source'>(() => noMessages ? 'terminal' : 'messages');
  // A pane that turns out to have no transcript at all moves to the terminal.
  useEffect(() => { if (noMessages) setMode('terminal'); }, [noMessages]);
  // A transcript arriving while the user is reading the terminal or source
  // must not steal their chosen view. The user returns to messages explicitly.
  const [wrap, setWrap] = useState(true);
  const [markdownPreference] = useState(markdownEnabled);
  const [draft, setDraft] = useState(() => loadDraft(session.hostId, session.paneId));
  // Persist on every change so leaving the session or losing the process keeps it.
  useEffect(() => { saveDraft(session.hostId, session.paneId, draft) }, [draft, session.hostId, session.paneId]);
  // The screen is no longer rebuilt per pane, so what belongs to one pane has
  // to be reset by hand when the pane changes: its draft, its "still waiting"
  // hint, any queued attachments and the previous pane's error.
  const settledPane = useRef(session.paneId);
  useEffect(() => {
    if (settledPane.current === session.paneId) return;
    settledPane.current = session.paneId;
    setDraft(loadDraft(session.hostId, session.paneId));
    setAwaitingReply(false);
    setAttachments([]);
    setLocalError('');
    sentAtCount.current = -1;
    followBottom.current = true;
    setNewContent(false);
  }, [session.paneId, session.hostId]);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [localError, setLocalError] = useState('');
  const [newContent, setNewContent] = useState(false);
  // Set when a message was sent and no new transcript item has appeared yet,
  // so the empty tail can show a "thinking" indicator instead of nothing.
  const [awaitingReply, setAwaitingReply] = useState(false);
  const [attachments, setAttachments] = useState<{ id: string; file: File; state: 'pending' | 'uploading' | 'done' | 'failed'; path?: string; error?: string }[]>([]);
  /**
   * Locally readable copies of pictures the user attached, by desktop path.
   *
   * An attachment is uploaded as a generic file, and the desktop will not serve
   * it back through its image route — so the transcript shows "图片无法显示" for
   * a picture the phone already has in memory. These are read while the file is
   * still in hand and painted straight from the blob.
   */
  const [localImages, setLocalImages] = useState<Record<string, LocalMediaEntry>>({});
  const localMediaOwnerId = localMediaOwner(session.hostId, session.paneId);
  const localImagesRef = useRef(localImages);
  localImagesRef.current = localImages;
  // Switching pane reuses Session for a smooth swipe, so the previous pane's
  // local files have to be released without discarding the active pane's copy.
  const previousMediaOwner = useRef(localMediaOwnerId);
  useEffect(() => {
    const previous = previousMediaOwner.current;
    previousMediaOwner.current = localMediaOwnerId;
    if (previous === localMediaOwnerId) return;
    setLocalImages((current) => clearLocalMedia(current, previous));
  }, [localMediaOwnerId]);
  // Leaving the conversation releases any pictures that remain on screen.
  useEffect(() => () => {
    for (const entry of Object.values(localImagesRef.current)) URL.revokeObjectURL(entry.url);
  }, []);
  const fileInput = useRef<HTMLInputElement>(null);
  // Both of these are overlays in the router rather than local state, so the
  // hardware Back button closes them instead of leaving the app.
  const overlay = useOverlay();
  const agentsOpen = overlay?.kind === 'agents';
  const viewingImage = overlay?.kind === 'image' ? overlay.src : undefined;
  /** The picture shown full-screen, if any. */
  const [subagent, setSubagent] = useState<{ id: string; title: string; kind?: string; finished: boolean; loading: boolean; error?: string; items: ChatItem[] }>();
  // Same rule as the other sheets: the overlay owns "is it open", so Back
  // closes the transcript instead of leaving the app.
  const subagentOpen = overlay?.kind === 'subagent';
  const closeSubagent = () => { setSubagent(undefined); closeOverlay(); };
  // Back may clear the overlay without going through closeSubagent, so the
  // local copy is dropped whenever the overlay is gone.
  useEffect(() => { if (!subagentOpen && subagent) setSubagent(undefined); }, [subagentOpen]);
  const sentAtCount = useRef(-1);
  const composing = useRef(false);
  const actionLock = useRef(false);
  const scroll = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const olderAnchor = useRef<{ top: number; height: number } | null>(null);
  // Set after a failed fetch so scrolling cannot retry it in a loop.
  const [olderFailed, setOlderFailed] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const ready = canUseHost(host);
  const terminal = noMessages || mode === 'terminal';
  const source = !terminal && mode === 'source';
  // The 源码 view is the same reader with rendering off. The saved preference
  // still drives the default, but an explicit view choice wins while the user
  // is in it.
  const markdown = source ? false : markdownPreference;
  // Any newly arrived item means the agent has produced something.
  // The desktop reads the model and effort out of the transcript; the screen is
  // only a fallback for desktops too old to send them. Context usage has no
  // other source, so that part is always scraped.
  const info = useMemo(() => mergedHeaderInfo(stripAnsi(session.details ?? ''), stripAnsi(session.screen ?? ''), session.settings), [session.details, session.screen, session.settings]);
  const agents = useMemo(() => backgroundAgents(session.items), [session.items]);
  const pane = host?.snapshot?.panes.find(item => item.pane_id === routePaneId);
  const branch = branchFromPane(pane);
  const sessionRoute = host ? routeLabel(host) : undefined;
  // Every dispatched agent, background or not: the notification is about the
  // session, but the sheet is where a user checks what is still running.
  const allAgents = useMemo(() => runningAgents(session.items), [session.items]);
  const itemCount = session.items.length;
  // Count captured when the message was sent; later growth clears the hint.
  useEffect(() => {
    if (awaitingReply && sentAtCount.current >= 0 && itemCount > sentAtCount.current) setAwaitingReply(false)
  }, [itemCount, awaitingReply]);
  const prompt = useMemo(() => terminal ? null : parsePrompt(stripAnsi(session.screen ?? '')), [terminal, session.screen]);
  // While a swipe is in flight the route names the pane the user asked for and
  // `session` still holds the previous one. The header follows the route so the
  // screen answers the gesture immediately; the transcript catches up below.
  const switching = routePaneId !== session.paneId;
  // The session's own directory, not the workspace root: a split tab often has
  // one pane in a subdirectory, and that is the one worth naming.
  const workspacePath = pane?.cwd || host?.snapshot?.workspaces.find(item => item.workspace_id === pane?.workspace_id)?.cwd || '';
  // Being on this screen is what "read" means. The state is the key, so a turn
  // that ends while the screen is open marks itself new only after the user
  // leaves — which is exactly when they were not looking.
  // ── panes that share this tab ──────────────────────────────────────────
  // Herdr splits one tab into several panes. On a phone the split is not
  // useful, so the panes of the current tab become pages: swipe left or right
  // to move between them instead of going back to the list. Order comes from
  // the snapshot, which is the desktop's own left-to-right order.
  const tabPanes = useMemo(() => {
    const all = host?.snapshot?.panes ?? [];
    if (!pane?.tab_id) return [];
    return all.filter(item => item.tab_id === pane.tab_id);
  }, [host?.snapshot?.panes, pane?.tab_id]);
  const paneIndex = tabPanes.findIndex(item => item.pane_id === session.paneId);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  function trackSwipe(event: TouchEvent<HTMLElement>) {
    const touch = event.touches[0];
    if (!touch) return;
    swipeStart.current = { x: touch.clientX, y: touch.clientY };
  }
  /**
   * A horizontal flick moves one pane. The thresholds matter on a phone: a
   * 60 px travel with the vertical component under a third of it separates a
   * deliberate swipe from a scroll that drifted, and from a tap.
   */
  function finishSwipe(event: TouchEvent<HTMLElement>) {
    const start = swipeStart.current;
    swipeStart.current = null;
    const touch = event.changedTouches[0];
    if (!start || !touch || tabPanes.length < 2) return;
    if (session.loading || session.sending) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) < 72 || Math.abs(dx) < Math.abs(dy) * 2) return;
    const next = paneIndex + (dx < 0 ? 1 : -1);
    const target = tabPanes[next];
    if (!target) return;
    void switchPane(target.pane_id);
  }
  /**
   * Moves to another pane of this tab.
   *
   * The route changes first, synchronously: the header, the page counter and
   * the skeleton answer the gesture on the next frame, and the transcript
   * catches up underneath. Waiting for the network before moving the route is
   * what made a swipe feel like a page reload.
   */
  function switchPane(paneId: string) {
    replace({ name: 'session', hostId: session.hostId, paneId });
    void controller.selectPane(paneId)
      .catch(() => {
        // Put the route back where the transcript still is, rather than leave
        // the header naming a pane that was never loaded.
        replace({ name: 'session', hostId: session.hostId, paneId: session.paneId });
        setLocalError(t('未能切换到相邻面板，请检查节点连接后重试。'));
      });
  }
  const paneStatus = pane?.agent_status;
  useEffect(() => {
    if (paneStatus) acknowledge(session.hostId, session.paneId, paneStatus);
  }, [paneStatus, session.hostId, session.paneId]);
  // The picker appears only while the composer holds a bare `/word`.
  const query = slashQuery(draft);
  const availableCommands = useMemo(
    () => filterCommands(commandsFor(pane?.agent ?? pane?.agent_session?.agent), query ?? ''),
    [pane?.agent, pane?.agent_session?.agent, query],
  );
  const commandOpen = query !== null && availableCommands.length > 0 && !terminal;
  /**
   * One UI state for every way an operation can block the composer. The
   * controller still owns mutation truth (`sending`, `uncertain`); this only
   * prevents a screen from disagreeing about whether its buttons are usable.
   */
  const hasDraft = Boolean(draft.trim()) || attachments.length > 0;
  // The agent itself is busy: that is the only moment "stop" means anything.
  const working = pane?.agent_status === 'working';
  const canQueue = Boolean(working && hasDraft);
  const operation = {
    sending: busy || session.sending,
    uncertain: Boolean(session.uncertain),
    switching,
    loading: session.loading,
    blocked: !ready || switching || Boolean(session.uncertain),
  };
  const disabled = operation.blocked;
  const [restarting, setRestarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const muted = pane ? controller.isMuted(session.hostId, pane) : false;

  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    if (olderAnchor.current) {
      if (session.loadingOlder) return;
      element.scrollTop = olderAnchor.current.top + element.scrollHeight - olderAnchor.current.height;
      olderAnchor.current = null;
      return;
    }
    if (followBottom.current) element.scrollTop = element.scrollHeight;
    else setNewContent(true);
  }, [session.items, session.screen, session.queued, session.loading, session.loadingOlder, terminal]);

  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (followBottom.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    const transcript = element.querySelector('.messages');
    if (transcript) observer.observe(transcript);
    return () => observer.disconnect();
  }, [mode]);

  useLayoutEffect(() => {
    const element = composer.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, [draft]);

  function trackScroll() {
    const element = scroll.current;
    if (!element) return;
    followBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
    if (followBottom.current) setNewContent(false);
    if (olderAnchor.current && session.loadingOlder) olderAnchor.current = { top: element.scrollTop, height: element.scrollHeight };
    // Reaching the top pulls the previous page in by itself: reading history
    // should not need a target, and a 150-row page means this fires rarely.
    if (!terminal && element.scrollTop < 120 && session.start > 0 && !session.loadingOlder && !olderFailed) void loadOlder();
  }

  function toBottom() {
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    followBottom.current = true;
    setNewContent(false);
  }

  async function loadOlder() {
    if (session.loadingOlder || !ready || !scroll.current || olderAnchor.current) return;
    olderAnchor.current = { top: scroll.current.scrollTop, height: scroll.current.scrollHeight };
    setLocalError('');
    try { await controller.loadOlder(); setOlderFailed(false); }
    catch {
      olderAnchor.current = null;
      setLocalError(t('更早的记录加载失败，请重试。'));
      // Auto-loading must not hammer a desktop that just refused.
      setOlderFailed(true);
    }
  }

  async function pickFiles(event: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = '';
    const accepted: typeof attachments = [];
    for (const file of picked) {
      const problem = checkFile(file.name, file.size, attachments.length + accepted.length);
      if (problem) { setLocalError(problem); continue }
      accepted.push({ id: crypto.randomUUID(), file, state: 'pending' });
    }
    if (accepted.length) setAttachments((current) => [...current, ...accepted]);
  }

  /** Returns each attachment with the desktop path it was stored under, so a
   *  picture can be matched back to the file the phone still has in memory. */
  async function uploadPending(): Promise<{ item: typeof attachments[number]; path: string }[]> {
    const pending = attachments.filter((item) => item.state !== 'done');
    const paths: { item: typeof attachments[number]; path: string }[] = []
    for (const item of attachments) if (item.state === 'done' && item.path) paths.push({ item, path: item.path })
    for (const item of pending) {
      setAttachments((current) => current.map((entry) => entry.id === item.id ? { ...entry, state: 'uploading' } : entry));
      try {
        const bytes = new Uint8Array(await item.file.arrayBuffer());
        // The bytes decide the type: an empty `file.type` from the Android
        // picker used to send a PNG as `application/octet-stream`, which the
        // desktop stores as a generic file — the agent then never gets a
        // picture, and the phone can never render it.
        const type = resolveMediaType(item.file, bytes);
        const uploaded = await controller.uploadAttachment(session.hostId, { name: item.file.name, type, bytes });
        paths.push({ item, path: uploaded.path });
        setAttachments((current) => current.map((entry) => entry.id === item.id ? { ...entry, state: 'done', path: uploaded.path } : entry));
      } catch (error) {
        setAttachments((current) => current.map((entry) => entry.id === item.id ? { ...entry, state: 'failed', error: error instanceof Error ? error.message : String(error) } : entry));
        throw error;
      }
    }
    return paths
  }

  async function send() {
    const text = draft;
    const target = controller.sessionTarget();
    const hasFiles = attachments.some((item) => item.state !== 'failed');
    if ((!text.trim() && !hasFiles) || composing.current || actionLock.current || disabled || !target) return;
    actionLock.current = true;
    setBusy(true);
    setLocalError('');
    try {
      if (terminal) {
        await controller.sendTerminalText(text, target);
      } else {
        const uploaded = await uploadPending();
        await controller.sendMessage(buildMessage(text, uploaded.map((entry) => ({ path: entry.path, name: entry.path, size: 0, renamed: false }))), target);
        // Remember what each picture looks like before its File goes away: the
        // transcript only ever gets the path back.
        // Extension as well as MIME: Android's picker often reports an empty
        // type, and a picture whose copy was skipped falls through to a remote
        // fetch the desktop refuses — which is the "图片无法显示" box.
        const pictures = uploaded.filter((entry) => looksLikeImage(entry.item.file));
        if (pictures.length) {
          setLocalImages((current) => {
            const next = pictures.reduce(
              (images, entry) => addLocalMedia(images, localMediaOwnerId, entry.path, entry.item.file.name, URL.createObjectURL(entry.item.file)),
              current,
            );
            return evictOldestLocalMedia(next, 12);
          });
        }
        setAttachments([]);
      }
      // Both modes clear the composer on success; only messages keep a draft.
      setDraft((current) => current === text ? '' : current);
      if (!terminal) {
        saveDraft(session.hostId, session.paneId, '');
        sentAtCount.current = session.items.length;
        setAwaitingReply(true);
      }
      followBottom.current = true;
    } catch {
      setLocalError(t('消息未确认送达，草稿已保留。请先检查记录或终端，避免重复发送。'));
    } finally { setBusy(false); actionLock.current = false; }
  }

  async function runCommand(command: string) {
    actionLock.current = true
    setBusy(true)
    setLocalError('')
    try {
      await controller.runCommand(command)
      setDraft('')
      saveDraft(session.hostId, session.paneId, '')
      // The reply arrives on the terminal stream, so show it there.
      switchMode('terminal')
    } catch {
      setLocalError(t('命令未能发送，请检查终端。'))
    } finally { setBusy(false); actionLock.current = false }
  }

  async function answer(optionNumber: number) {
    if (!prompt || busy || session.sending || session.uncertain) return
    actionLock.current = true
    setBusy(true)
    setLocalError('')
    try { await controller.answerPrompt(prompt, optionNumber) }
    catch { setLocalError(t('选择未确认送达。请核对终端画面后再操作。')) }
    finally { setBusy(false); actionLock.current = false }
  }

  function composerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) {
      event.preventDefault();
      void send();
    }
  }

  async function sendKey(key: string) {
    const target = controller.sessionTarget();
    if (disabled || actionLock.current || !target) return;
    actionLock.current = true;
    setBusy(true);
    setLocalError('');
    try { await controller.sendKeys([key], target); }
    catch { setLocalError(t('按键结果未确认。请刷新终端后再决定是否重试。')); }
    finally { setBusy(false); actionLock.current = false; }
  }

  /**
   * Interrupts the running agent with Ctrl+C.
   *
   * The same key a person would press in the terminal: the agent decides what
   * "stop" means for whatever it is doing (abort the turn, cancel the tool),
   * which is exactly right — a phone should not invent a stronger signal than
   * the keyboard has. Deliberately not routed through `disabled`: that flag is
   * true while the agent is working, and this button exists for only that case.
   */
  async function stopAgent() {
    if (!ready || session.sending || actionLock.current) return;
    const target = controller.sessionTarget();
    if (!target) return;
    actionLock.current = true;
    setStopping(true);
    setLocalError('');
    try { await controller.sendKeys(['C-c'], target); }
    catch { setLocalError(t('中断请求未确认，请刷新终端后确认。')); }
    finally { setStopping(false); actionLock.current = false; }
  }

  async function openSubagent(toolId: string, title: string) {
    setSubagent({ id: toolId, title, finished: false, loading: true, items: [] })
    openOverlay({ kind: 'subagent' })
    try {
      const result = await controller.loadSubagent(session.hostId, session.paneId, toolId)
      setSubagent({
        id: toolId, title: result.agent.description || title, kind: result.agent.type,
        finished: result.agent.finished === true, loading: false, items: result.items,
      })
    } catch (error) {
      setSubagent({ id: toolId, title, finished: false, loading: false, items: [], error: error instanceof Error ? error.message : t('无法读取子 agent') })
    }
  }

  async function restart() {
    if (restarting || !ready) return
    setRestarting(true)
    setLocalError('')
    try { await controller.restartAgent(session.hostId, session.paneId) }
    catch (error) { setLocalError(error instanceof Error ? error.message : t('重启失败')) }
    finally { setRestarting(false) }
  }

  async function toggleMute() {
    if (!pane?.tab_id) return
    try { await controller.setMuted(session.hostId, { tab: pane.tab_id }, !muted) }
    catch { setLocalError(t('未能修改静音状态，请重试。')) }
  }

  async function refresh() {
    if (refreshing || !ready) return;
    setRefreshing(true);
    setLocalError('');
    try { await controller.readScreen(); }
    catch { setLocalError(t('终端刷新失败，当前显示可能不是最新内容。')); }
    finally { setRefreshing(false); }
  }

  function switchMode(next: 'messages' | 'terminal' | 'source') {
    followBottom.current = true;
    olderAnchor.current = null;
    setNewContent(false);
    setMode(next);
  }

  return <section className="conversation-view" onTouchStart={trackSwipe} onTouchEnd={finishSwipe}>
    <header className="page-header conversation-header"><button className="icon-button" title={t('返回会话')} aria-label={t('返回会话')} onClick={() => { controller.backToSessions(); back() }}><ArrowLeft size={21} /></button>
      <AgentBadge agent={pane?.agent ?? pane?.agent_session?.agent} />
      <div className="header-copy"><h1>{paneTitle(pane, tabLabelOf(host?.snapshot, pane))}</h1>
        <p className="session-host-name"><span className="session-host-id"><Server size={12} aria-hidden="true" />{host?.host.name || t('未知节点')}</span>
          {/* The route is the LAN/relay switch: it changes what a tap costs,
              so it belongs in the header rather than behind a menu. */}
          {sessionRoute && <span className="session-chip is-route" title={t('当前连接方式')}>{sessionRoute}</span>}
          {tabPanes.length > 1 && <span className="session-chip is-panes" title={t('这个 tab 有多个面板，左右滑动切换')}>{paneIndex + 1}/{tabPanes.length}</span>}
        </p>
        {/* The workspace this session belongs to. A path can be longer than a
            phone is wide, so it scrolls sideways instead of wrapping or
            truncating — the tail is what tells two checkouts apart. */}
        {workspacePath && <p className="session-workspace" title={workspacePath}>{workspacePath}</p>}
        {branch && <p className="session-branch" title={t('当前 Git 分支')}><GitBranch size={12} aria-hidden="true" />{branch}</p>}
      </div>{host && <Status host={host} compact />}</header>

    {/* Three views, one segmented control. Separate tab, wrap and markdown
        buttons in a single row made it read as four unrelated actions; the
        view is one choice, and what each view offers sits beside it. */}
    <div className="view-toolbar">
      <div className="view-segments" role="tablist" aria-label={t('会话视图')}>
        <button role="tab" id="messages-tab" aria-controls="session-content" aria-selected={!terminal && !source} disabled={noMessages} className={!terminal && !source ? 'is-active' : ''} onClick={() => switchMode('messages')}><MessageSquare size={15} />{t('消息')}</button>
        <button role="tab" id="terminal-tab" aria-controls="session-content" aria-selected={terminal} className={terminal ? 'is-active' : ''} onClick={() => switchMode('terminal')}><Terminal size={15} />{t('终端')}</button>
        <button role="tab" id="source-tab" aria-controls="session-content" aria-selected={source} disabled={noMessages} className={source ? 'is-active' : ''} onClick={() => switchMode('source')}><FileCode size={15} />{t('源码')}</button>
      </div>
      <div className="view-actions">
        <details className="view-maintenance">
          <summary className="icon-button" aria-label={t('更多操作')} title={t('更多操作')}><MoreHorizontal size={18} /></summary>
          <div className="view-maintenance-menu">
            {terminal && <>
              <button type="button" className="maintenance-action" aria-pressed={wrap} onClick={() => setWrap(value => !value)}><WrapText size={16} />{wrap ? t('保留原始行') : t('自动换行')}</button>
              <button type="button" className="maintenance-action" disabled={!ready || refreshing} onClick={() => void refresh()}><RefreshCw size={16} className={refreshing ? 'spin' : ''} />{t('刷新终端')}</button>
            </>}
            <button type="button" className="maintenance-action" aria-pressed={muted} disabled={!ready || !pane?.tab_id} onClick={() => void toggleMute()}><BellOff size={16} />{muted ? t('恢复提醒') : t('静音这个会话')}</button>
            <button type="button" className="maintenance-action" disabled={!ready || restarting} onClick={() => void restart()}>{restarting ? <Loader2 size={16} className="spin" /> : <RotateCcw size={16} />}{t('重启这个 agent')}</button>
          </div>
        </details>
      </div>
    </div>
    <div className="session-notices">
      {!ready && <Notice error>{t(host?.status === 'connecting' ? '连接恢复中，暂时无法发送。' : '节点未连接，暂时无法发送。')}{host && host.status !== 'connecting' && <button className="inline-button" onClick={() => controller.retryHost(host.host.id)}>{t('重新连接')}</button>}</Notice>}
      {session.unsupported && (gap === 'terminal'
        ? <Notice>{t('这是一个普通终端会话，没有聊天记录，可直接在终端操作。')}</Notice>
        : gap === 'unsupported'
          ? <Notice>{t('这个桌面暂时读不了这个 agent 的聊天记录，可以直接用终端。')}</Notice>
          : gap === 'transcript'
            ? <Notice>{t('已经拿到会话 ID，但桌面端在原来的位置找不到记录——常见于通过 SSH 或在容器里运行的 agent。会在终端视图继续重试。')}</Notice>
            : <Notice>
              {gap === 'integration'
                ? t('对话已经开始，但仍读不到聊天记录。请确认桌面端已为这个 agent 安装并启用 Herdr integration——它在会话开始时上报会话 ID，没有它只能一直用终端。')
                : t('Herdr 还没收到这个 agent 的会话 ID，聊天记录会在收到后出现。现在就可以发消息。')}
              <button className="inline-button" onClick={() => void controller.reloadSession()}>{t('立即重试')}</button>
            </Notice>)}
      {session.uncertain && <Notice error><strong>{t('操作结果不确定')}</strong><p>{session.uncertain}</p><p>{t('请先核对消息或终端内容，避免重复操作。')}</p><button type="button" className="inline-button" onClick={() => void controller.reloadSession()}>{t('重新读取记录')}</button></Notice>}
      {session.error && <Notice error>{session.error}</Notice>}
      {localError && <Notice error>{localError}</Notice>}
    </div>
      {prompt && !terminal && <div className="prompt-card" role="group" aria-label={t('需要你选择')}>
        <button type="button" className="prompt-close" aria-label={t('在终端里处理')} title={t('在终端里处理')} onClick={() => switchMode('terminal')}><X size={15} /></button>
      <div className="prompt-head"><CircleAlert size={16} aria-hidden="true" /><span>{t('需要你选择')}</span></div>
      <p className="prompt-question">{prompt.question}</p>
      <div className="prompt-options">
        {prompt.options.map(option => <button
          type="button"
          key={option.number}
          className={`prompt-option${option.selected ? ' is-current' : ''}`}
          disabled={busy || session.sending || Boolean(session.uncertain) || !ready}
          onClick={() => void answer(option.number)}
        >
          <span className="prompt-number">{option.checked !== null ? (option.checked ? '✓' : '○') : option.number}</span>
          <span className="prompt-label">{option.label}</span>
        </button>)}
      </div>
      <p className="prompt-hint">{t('点击后会重新核对终端内容，若问题已变化将取消。也可以在终端里直接操作。')}</p>
    </div>}
    {viewingImage && <ImageViewer src={viewingImage} onClose={closeOverlay} />}
    {agentsOpen && <div className="sheet-backdrop" role="presentation" onClick={closeOverlay}>
      <div className="host-sheet" role="dialog" aria-modal="true" aria-label={t('运行中的 agent')} onClick={(event) => event.stopPropagation()}>
        <h2>{agents.length} {t('个 agent 运行中')}</h2>
        <ul className="agents-list">{allAgents.map((agent) => <li key={agent.id} className="agents-row">
          <span className={`agents-dot${agent.background ? '' : ' is-foreground'}`} aria-hidden="true" />
          <span className="agents-copy"><strong>{agent.title}</strong>{agent.kind && <small>{agent.kind}</small>}</span>
          {/* The desktop keeps each dispatched agent's own transcript, and this
              is the only place the phone can read what it actually did. */}
          <button type="button" className="text-button" onClick={() => { closeOverlay(); void openSubagent(agent.id, agent.title) }}>{t('查看')}</button>
        </li>)}</ul>
        <button type="button" className="secondary-button sheet-cancel" onClick={closeOverlay}>{t('关闭')}</button>
      </div>
    </div>}
    {subagent && subagentOpen && <div className="sheet-backdrop" role="presentation" onClick={closeSubagent}>
      <div className="host-sheet subagent-sheet" role="dialog" aria-modal="true" aria-label={t('子 agent 记录')} onClick={(event) => event.stopPropagation()}>
        <h2>{subagent.title}</h2>
        <p className="field-hint">{subagent.kind ? `${subagent.kind} · ` : ''}{subagent.finished ? t('已结束') : t('仍在运行')}</p>
        {subagent.loading
          ? <Loading label={t('正在读取子 agent…')} />
          : subagent.error
            ? <Notice error>{subagent.error}</Notice>
            : subagent.items.length === 0
              ? <p className="muted">{t('这个子 agent 还没有可读的记录')}</p>
              : <div className="subagent-transcript">{timeline(subagent.items).map(entry => entry.kind === 'work'
          ? <WorkGroup items={entry.items} running={entry.running} counts={entry.counts} hostId={session.hostId} paneId={session.paneId} onOpenImage={(src) => openOverlay({ kind: 'image', src })} localImages={localImages} key={entry.key} />
                  : <Message item={entry.item} markdown={markdown} hostId={session.hostId} paneId={session.paneId} onOpenImage={(src) => openOverlay({ kind: 'image', src })} localImages={localImages} key={entry.key} />)}</div>}
        <button type="button" className="secondary-button sheet-cancel" onClick={closeSubagent}>{t('关闭')}</button>
      </div>
    </div>}
    <div className="transcript-shell">
      {/* While a swipe is in flight the previous pane's transcript is still in
          the store; a thin progress line says so, and the body fades rather
          than pretending the old rows belong to the new header. */}
      {switching && <div className="pane-switching" role="status" aria-label={t('正在切换面板')}><span /></div>}
      <div ref={scroll} id="session-content" className={`transcript-scroll ${terminal ? 'terminal-scroll' : ''}${switching ? ' is-switching' : ''}`} role="tabpanel" aria-labelledby={terminal ? 'terminal-tab' : 'messages-tab'} aria-busy={session.loading || switching} onScroll={trackScroll} tabIndex={0}>
        {terminal ? <>{session.loading && !session.screen && <Loading label={t('正在读取终端…')} />}{session.screen ? <pre className={`terminal-screen${wrap ? '' : ' is-raw'}`} tabIndex={0} aria-label={t('终端画面')}>{stripAnsi(session.screen)}</pre> : !session.loading && <EmptyState icon={<Terminal size={28} />} title={session.error ? t('终端画面暂不可用') : t('尚无终端画面')}><button className="secondary-button" disabled={!ready || refreshing} onClick={() => void refresh()}><RefreshCw size={16} />{t('读取终端')}</button></EmptyState>}</> : <>
          {/* Status, not a control: history arrives on scroll. It stays
              retryable only when a fetch failed, which is the one case the
              scroll trigger deliberately stops retrying. */}
          {session.start > 0 && <div className="older-messages" role="status">
            {session.loadingOlder
              ? <span className="older-status"><Loader2 size={14} className="spin" />{t('正在加载更早的记录…')}</span>
              : olderFailed
                ? <button type="button" className="text-button" disabled={!ready} onClick={() => { setOlderFailed(false); void loadOlder(); }}><RefreshCw size={14} />{t('更早的记录加载失败，点击重试')}</button>
                : <span className="older-status">{t('继续上滑加载更早的记录')}</span>}
          </div>}
          {session.loading && !session.items.length ? <Loading label={t('正在读取消息…')} /> : !session.items.length ? <EmptyState icon={<MessageSquare size={28} />} title={session.error ? t('消息暂不可用') : t('暂无消息记录')} /> : <div className="messages">{timeline(session.items).map(entry => entry.kind === 'work'
                ? <WorkGroup items={entry.items} running={entry.running} counts={entry.counts} hostId={session.hostId} paneId={session.paneId} onOpenImage={(src) => openOverlay({ kind: 'image', src })} localImages={localImages} key={entry.key} />
                : <Message item={entry.item} markdown={markdown} hostId={session.hostId} paneId={session.paneId} onOpenImage={(src) => openOverlay({ kind: 'image', src })} localImages={localImages} key={entry.key} />)}
              {awaitingReply && !session.uncertain && <div className="thinking" role="status" aria-live="polite">
                <span className="thinking-dots" aria-hidden="true"><i /><i /><i /></span>
                <span className="thinking-label">{t('正在等待回复…')}</span>
              </div>}
            </div>}
          {session.queued.length > 0 && <div className="queued-messages">{session.queued.map(item => <article className="message message-user queued-message" key={item.id}><div className="message-meta"><span>{t('你')}</span><span><Loader2 size={12} className="spin" />{t('等待发送')}</span></div><RichText text={item.text} markdown={markdown} /></article>)}</div>}
        </>}
      </div>
      {newContent && <button className="new-content-button secondary-button" onClick={toBottom}><ArrowDown size={16} />{t('最新内容')}</button>}
    </div>
    {terminal && <div className="terminal-keys" role="group" aria-label={t('终端按键')}>
      <button className="key-button icon-button" title={t('向上')} aria-label={t('发送向上键')} disabled={disabled} onClick={() => void sendKey('Up')}><ArrowUp size={18} /></button>
      <button className="key-button icon-button" title={t('向下')} aria-label={t('发送向下键')} disabled={disabled} onClick={() => void sendKey('Down')}><ArrowDown size={18} /></button>
      <button className="key-button icon-button" title={t('向左')} aria-label={t('发送向左键')} disabled={disabled} onClick={() => void sendKey('Left')}><ArrowLeft size={18} /></button>
      <button className="key-button icon-button" title={t('向右')} aria-label={t('发送向右键')} disabled={disabled} onClick={() => void sendKey('Right')}><ArrowRight size={18} /></button>
      <button className="key-button" title={t('发送回车键')} disabled={disabled} onClick={() => void sendKey('Enter')}><CornerDownLeft size={16} /><span>Enter</span></button>
      <button className="key-button" title={t('发送退出键')} disabled={disabled} onClick={() => void sendKey('Escape')}>Esc</button>
      <button className="key-button interrupt-key" title={t('中断当前终端任务')} disabled={disabled} onClick={() => void sendKey('C-c')}><Square size={13} /><span>Ctrl+C</span></button>
    </div>}
    {commandOpen && <ul className="command-picker" role="listbox" aria-label={t('命令')}>
      {availableCommands.map((command) => <li key={command.name}>
        <button type="button" role="option" aria-selected={false} className="command-option" onClick={() => void runCommand(command.label)}>
          <span className="command-label">{command.label}</span>
          <span className="command-hint">{t(command.hint)}</span>
          {command.risk === 'menu' && <span className="command-badge">{t('菜单')}</span>}
        </button>
      </li>)}
    </ul>}
    {!terminal && attachments.length > 0 && <ul className="attachment-tray">
      {attachments.map((item) => <li key={item.id} className={`attachment-chip is-${item.state}`}>
        <Paperclip size={13} aria-hidden="true" />
        <span className="attachment-name">{item.file.name}</span>
        <span className="attachment-state">{item.state === 'pending' ? t('待上传') : item.state === 'uploading' ? t('上传中') : item.state === 'done' ? t('已上传') : t('失败')}</span>
        <button type="button" className="attachment-remove" aria-label={`${t('移除')} ${item.file.name}`} onClick={() => setAttachments((current) => current.filter((entry) => entry.id !== item.id))}><X size={13} /></button>
      </li>)}
    </ul>}
    <form className="composer" onSubmit={event => { event.preventDefault(); void send(); }}>
      {!terminal && <>
        <input ref={fileInput} type="file" multiple hidden onChange={(event) => void pickFiles(event)} aria-label={t('选择附件')} />
        {/* Only block attaching when nothing could be uploaded at all: a busy
            send, a loading transcript or an uncertain outcome must not stop the
            user from queueing files for the next message. */}
        <button type="button" className="attach-button" title={t('添加附件')} aria-label={t('添加附件')} disabled={!ready || attachments.length >= MAX_ATTACHMENTS} onClick={() => fileInput.current?.click()}><Paperclip size={20} /></button>
      </>}
      <label className="sr-only" htmlFor="message-input">{t(terminal ? '终端输入' : '消息')}</label>
      <textarea ref={composer} id="message-input" rows={1} value={draft} onChange={event => setDraft(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={composerKey} placeholder={t(!ready ? '节点连接后可发送' : terminal ? '输入终端内容…' : '发送消息…')} disabled={!ready} />
      {/* One button slot, two jobs: while the agent is working the send arrow
          becomes a stop, which is the action a user actually wants then. A
          separate stop button beside a permanently-visible send button reads as
          two ways to do the same thing. */}
      {/* While the agent works the key can be either send or stop, and which
          one depends on what the user has typed: with something in the box they
          are almost certainly trying to queue it, with an empty box they are
          trying to interrupt. Both are one tap away, and neither hides the
          other. */}
      {working && !terminal && !hasDraft
        ? <button type="button" className="send-button is-stop" title={t('停止')} aria-label={t('停止')} disabled={!ready || stopping || switching} onClick={() => void stopAgent()}>
            {stopping ? <Loader2 size={18} className="spin" /> : <span className="stop-ring" aria-hidden="true"><span className="stop-glyph" /></span>}
          </button>
        : <button type="submit" className="send-button" title={t(operation.sending ? '正在发送' : terminal ? '发送并回车' : '发送')} aria-label={t(operation.sending ? '正在发送' : terminal ? '发送并回车' : '发送')} disabled={disabled || (!draft.trim() && attachments.length === 0)}>{operation.sending ? <Loader2 size={20} className="spin" /> : <Send size={20} />}</button>}
      {canQueue && !terminal && <button type="button" className="send-button is-stop is-inline" title={t('停止')} aria-label={t('停止')} disabled={!ready || stopping || switching} onClick={() => void stopAgent()}>
        {stopping ? <Loader2 size={16} className="spin" /> : <span className="stop-ring" aria-hidden="true"><span className="stop-glyph" /></span>}
      </button>}
    </form>
    <div className="composer-foot">
      {/* The model, the effort and the context figure belong with the box you
          type into, not over the conversation: they describe the agent you are
          about to talk to, and putting them here gave the header its whole
          height back to the title. */}
      <div className="composer-facts">
        {info.model && <span className="composer-fact is-model" title={t('当前模型')}>{info.model}{info.effort ? <span className="composer-fact-effort">{info.effort}</span> : null}</span>}
        {info.contextLabel && <span className="composer-fact" title={info.contextRatio === undefined ? t('上下文用量') : `${t('上下文已用')} ${Math.round((info.contextRatio ?? 0) * 100)}%`}>{info.contextLabel}</span>}
        {agents.length > 0 && <button type="button" className="composer-fact is-agents" onClick={() => openOverlay({ kind: 'agents' })} title={t('查看运行中的 agent')} aria-label={tWith('{count} 个 agent 运行中', { count: String(agents.length) })}>
          <span className="agents-dot" aria-hidden="true" />{agents.length} {t('个 agent')}
        </button>}
      </div>
      <div className="composer-status" role="status">{operation.sending ? <><Loader2 size={12} className="spin" />{t('正在发送')}</> : session.queued.length ? tWith('{count} 条待发送', { count: session.queued.length }) : operation.uncertain ? t('操作结果未确认，发送已暂停') : operation.loading ? <><Loader2 size={12} className="spin" />{t('正在读取消息…')}</> : ready ? <><Check size={12} />{host?.host.name}</> : t('发送不可用')}</div>
    </div>
  </section>;
}

/**
 * Opens the conversation behind a tapped notification.
 *
 * The exact pane may be gone by the time the alert is tapped, so selecting the
 * desktop first and only then the pane keeps a deleted session from leaving the
 * user on a dead screen.
 */
/**
 * Runs a notification's button against the live desktop.
 *
 * The notification describes a transition that happened minutes ago, so
 * neither Allow nor Deny may replay a remembered row: the controller re-reads
 * the terminal and resolves the button by wording, refusing when the menu has
 * changed or two options could match. A reply is different in kind — it is
 * text the user just typed, so it goes through the ordinary prompt path.
 *
 * Anything that cannot be done silently opens the session instead, which is
 * always a safe answer for a tap the user did make.
 */
async function handleAlertAction(hostId: string, paneId: string, kind: string | undefined, actionId: string | undefined, input: string | undefined, promptFingerprint?: string) {
  const extra = { kind: kind === 'done' ? 'done' as const : 'blocked' as const }
  const intent = actionFor(extra, actionId, input)
  if (intent.kind === 'open') return openSessionFromAlert(hostId, paneId)
  try {
    if (intent.kind === 'allow' || intent.kind === 'deny') {
      await controller.answerPromptFromAlert(hostId, paneId, intent.kind, promptFingerprint)
      return
    }
    if (intent.kind === 'reply' && intent.text) {
      // The session behind a notification may not be the one on screen; open
      // it first so the send goes to the pane the user tapped. Opening can
      // fail (the desktop is offline), and the previous session would then
      // still be the target — so the opened pane is checked, not assumed.
      await openSessionFromAlert(hostId, paneId)
      const open = controller.getState().session
      if (!open || open.hostId !== hostId || open.paneId !== paneId) throw new Error(t('会话没有打开，回复未发送'))
      await controller.sendMessage(intent.text)
      return
    }
  } catch {
    // Silent success is what makes a button feel like a button; a refusal
    // opens the session so the user can see why.
    await openSessionFromAlert(hostId, paneId)
  }
}

async function openSessionFromAlert(hostId: string, paneId: string) {
  controller.selectHost(hostId)
  try {
    await controller.selectPane(paneId)
    push({ name: 'session', hostId, paneId })
  } catch {
    // The pane no longer exists: land on the session list for that desktop.
    push({ name: 'sessions' })
  }
}

export function App() {
  const state = useSyncExternalStore(subscribe, getSnapshot);
  const route = useRoute();
  // Changing the language must re-render every screen, not just the one that
  // owns the control, so the tree is keyed by the active locale.
  const [localeRevision, setLocaleRevision] = useState(0);
  useEffect(initialize, []);
  // Reconcile the foreground service with the saved mode on every launch.
  // `reply` needs to know whether anything is running, which the first
  // snapshot will tell us; until then the service stays off.
  useEffect(() => { void applyKeepAlive(keepAliveMode(), false); }, []);
  // A `reply` keep-alive follows the work itself: on when an agent starts,
  // off when the last one finishes, so the service's own timeout is a backstop
  // rather than the normal way it ends. Re-applied only while the app is on
  // screen: since Android 12 a foreground service cannot be started from the
  // background, and snapshot frames still arrive while hidden, so a change
  // seen then would fail silently and leave the reply uncovered.
  const workingNow = replyInProgress(state.hosts);
  const visible = state.foreground !== false;
  useEffect(() => {
    if (!visible) return;
    void applyKeepAlive(keepAliveMode(), workingNow);
  }, [workingNow, visible]);

  // Tapping a notification opens the conversation that raised it. The camera
  // tunnel stays closed; only the panes and the transcript are loaded.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    let cancel: (() => void) | undefined
    void registerAlertActions()
    void import('@capacitor/local-notifications').then(async ({ LocalNotifications }) => {
      const handle = await LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
        const extra = action.notification.extra as { hostId?: string; paneId?: string; kind?: string; promptFingerprint?: string } | undefined
        if (!extra?.hostId || !extra.paneId) return
        void handleAlertAction(extra.hostId, extra.paneId, extra.kind, action.actionId, action.inputValue, extra.promptFingerprint)
      })
      cancel = () => { void handle.remove() }
    }).catch(() => undefined)
    return () => cancel?.()
  }, [])

  // Keep the connection warm across a quick app switch, but release it after a
  // long absence so a phone in a pocket is not holding a relay socket open.
  useEffect(() => {
    let state = initialState()
    const apply = (event: 'hidden' | 'visible' | 'tick') => {
      const result = step(state, event, Date.now())
      state = result.state
      if (result.action === 'suspend') controller.suspend()
      // A return replaces the tunnel: the page was frozen, so whatever socket
      // it still holds may be one the relay already closed.
      if (result.action === 'resume') controller.resume(true)
      // Short of that, a read proves the existing tunnels still carry traffic.
      if (result.action === 'verify') void controller.verify()
      if (event === 'visible') controller.retryStopped()
    }
    const onVisibility = () => {
      controller.setForeground(document.visibilityState !== 'hidden')
      apply(document.visibilityState === 'hidden' ? 'hidden' : 'visible')
    }
    const onOnline = () => controller.retryStopped()
    // The OS knows about a Wi-Fi/cellular handover; `window.online` does not,
    // and the old socket survives the switch looking open. Redialing as soon
    // as the path moves beats waiting for the probe to notice the silence.
    let watcher: { stop(): void } | undefined
    void watchNetwork(() => controller.networkChanged()).then((created) => { watcher = created })
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)
    // The tick only matters while hidden, and a timer that wakes the page
    // every minute for nothing costs battery. Run it only then.
    let timer: ReturnType<typeof setInterval> | undefined
    const syncTimer = () => {
      if (document.visibilityState === 'hidden' && !timer) timer = setInterval(() => apply('tick'), 60_000)
      if (document.visibilityState !== 'hidden' && timer) { clearInterval(timer); timer = undefined }
    }
    syncTimer()
    const onVisibilityAndTimer = () => { onVisibility(); syncTimer() }
    document.removeEventListener('visibilitychange', onVisibility)
    document.addEventListener('visibilitychange', onVisibilityAndTimer)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityAndTimer)
      window.removeEventListener('online', onOnline)
      watcher?.stop()
      if (timer) clearInterval(timer)
    }
  }, []);
  useAlerts(state.hosts);
  const directToast = useDirectToast(state.hosts);

  // The window behind the WebView is native. It has to know the theme the page
  // actually resolved, or the status-bar and navigation-bar strips stay the
  // system's colour while the page is the opposite one.
  useEffect(() => { applyTheme() }, []);

  // A desktop that disappears (forgotten, or storage wiped) must not leave the
  // user on a dead screen. Keyed on primitive ids so a re-published host list
  // with a new array identity does not re-run this on every render.
  const hostIds = state.hosts.map((item) => item.host.id).join(',');
  const repairedFor = useRef('');
  useEffect(() => {
    // Screens that are valid without any desktop must not be "repaired" away.
    if (state.loading || route.name === 'settings' || route.name === 'addHost') return
    const ids = hostIds ? hostIds.split(',') : []
    // With no desktops at all, the list is the home screen; the picker and
    // session views only need repair when a host they reference disappeared.
    const needsRepair = Boolean(ids.length) && route.name === 'session' && !ids.includes(route.hostId)
    if (!needsRepair) { repairedFor.current = ''; return }
    // Guard by the exact situation so a re-render cannot retrigger the repair.
    const guard = `${route.name}:${hostIds}`
    if (repairedFor.current === guard) return
    repairedFor.current = guard
    replace({ name: 'sessions' })
  }, [hostIds, state.loading, route]);

  // With no desktops at all, settings is the only useful screen.
  const forcedSettings = !state.loading && state.hosts.length === 0;
  const sessionHost = state.hosts.find(item => item.host.id === (route.name === 'session' ? route.hostId : ''));
  const screen =
    route.name === 'addHost'
      ? <AddHost onBack={() => back()} onAdded={() => back()} />
      : forcedSettings || route.name === 'settings'
      ? <HostSettings
          hosts={state.hosts}
          onClose={() => back()}
          onOpen={id => { controller.selectHost(id); push({ name: 'sessions' }) }}
          onLocaleChange={() => setLocaleRevision(value => value + 1)}
        />
      : route.name === 'session' && state.session
        // Only a host mismatch sends the user back to the list. A pane mismatch
        // is the normal state while a swipe is in flight — the route moves the
        // moment the finger lifts, the transcript arrives after — and falling
        // back to the list there is what made switching panes flash the list
        // screen. The session screen handles the gap with its own loading state.
        && state.session.hostId === route.hostId
        // Keyed by host, not by pane: remounting on every swipe threw away the
        // composer, the scroll position and every fetched image, which is most
        // of why switching panes felt slow.
        ? <Session key={route.hostId} session={state.session} routePaneId={route.paneId} host={sessionHost} />
        : <Sessions
            state={state}
            onSettings={() => push({ name: 'settings' })}
            onOpenSession={(hostId, paneId) => push({ name: 'session', hostId, paneId })}
          />;

  return <main className="app-shell" key={localeRevision}>
    {directToast && <div className="direct-toast" role="status">{tWith('已切换到 lan · {name}', { name: directToast })}</div>}
    {(state.storageWarning || state.error) && <div className="app-notices">{state.storageWarning && <Notice error>{state.storageWarning}</Notice>}{state.error && <Notice error>{state.error}</Notice>}</div>}
    {screen}
  </main>;
}

export default App;
