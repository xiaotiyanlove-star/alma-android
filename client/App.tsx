import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ChangeEvent, FormEvent, KeyboardEvent, ReactNode } from 'react';
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, ChevronDown,
  Camera, CircleAlert, CornerDownLeft, Eye, EyeOff, Loader2, MessageSquare, Plus, RefreshCw,
  Send, Server, Settings, Square, Terminal, Trash2, WrapText, X, FileCode, FileText, Pencil, ChevronUp, Paperclip, PlusCircle,
} from 'lucide-react';
import { controller } from './controller';
import { Capacitor } from '@capacitor/core';
import { ScanPairing } from './ScanPairs';
import { AlertTracker, localNotifier } from './notify';
import { applyKeepAlive, keepAliveEnabled, setKeepAliveEnabled } from './keepalive';
import { parsePrompt } from './prompt';
import { buildMessage, checkFile, MAX_ATTACHMENTS } from './attachments';
import { Markdown } from './Markdown';
import { APP_VERSION, APP_ID, BUILD_TIME } from './version';
import { t, tWith } from './i18n';
import { loadDraft, saveDraft } from './drafts';
import { back, closeOverlay, openOverlay, push, replace, useOverlay, useRoute } from './router';
import { DROP_AFTER_MS, initialState, step } from './lifecycle';
import { stopMessage } from './backoff';
import { parseSessionInfo } from './session-info';
import { backgroundAgents } from './subagents';
import { commandsFor, filterCommands, slashQuery } from './commands';
import { formatTime, localeChoice, setLocaleChoice, timeZoneChoice, setTimeZoneChoice, resolvedTimeZone, resolvedLocale, COMMON_ZONES, markdownEnabled, setMarkdownEnabled, type LocaleChoice } from './prefs';
import type { AppState, ChatItem, HostState, Pane, SessionState, Snapshot } from './model';
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

function stripAnsi(value: string): string {
  return value
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[P^_][\s\S]*?(?:\x1b\\|\x9c)/g, '')
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[ -/]*[@-Z\\-_]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
}

/**
 * What a session is called.
 *
 * A name the user gave wins; otherwise the tab label the desktop shows (Herdr
 * numbers new tabs, so an untouched `2` is not a name) and only then the
 * terminal title. That order keeps a renamed session stable: the agent rewrites
 * its terminal title on every turn, so a title-first order would undo a rename
 * the moment the agent next draws.
 */
export function paneTitle(pane?: Pane, tabLabel?: string): string {
  const named = tabLabel?.trim() || pane?.label?.trim();
  if (named) return stripAnsi(named);
  return stripAnsi(pane?.terminal_title_stripped || pane?.cwd?.split('/').filter(Boolean).pop() || '终端会话');
}

/**
 * The label Herdr holds for a pane's tab, when the snapshot has one.
 *
 * New tabs are numbered, so a bare number is Herdr's placeholder rather than a
 * name; treating it as one would let a rename be undone by that default.
 */
export function tabLabelOf(snapshot: Snapshot | undefined, pane?: Pane): string | undefined {
  const label = snapshot?.tabs?.find(tab => tab.tab_id === pane?.tab_id)?.label?.trim();
  return label && !/^\d+$/.test(label) ? label : undefined;
}

function hostStatus(host: HostState): string {
  if (host.status === 'connecting') return t('连接中');
  if (host.status === 'error') return t('连接失败');
  if (host.status !== 'online') return t('未连接');
  return host.herdrOnline ? t('已连接') : t('Herdr 离线');
}

function canUseHost(host?: HostState): boolean {
  return host?.status === 'online' && host.herdrOnline;
}

function Status({ host }: { host: HostState }) {
  const ready = canUseHost(host);
  return <span className={`connection-status ${ready ? 'is-online' : host.status === 'error' ? 'is-error' : ''}`}>
    <span className={`status-dot ${host.status === 'connecting' ? 'is-pending' : ''}`} aria-hidden="true" />
    {hostStatus(host)}
  </span>;
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
  const parts = stripAnsi(text).split(/(```[^\n]*\n[\s\S]*?(?:```|$))/g);
  return <div className="message-content">{parts.map((part, index) => {
    if (!part) return null;
    if (!part.startsWith('```')) return <div className="prose-text" key={index}>{part}</div>;
    const firstLine = part.indexOf('\n');
    const language = part.slice(3, firstLine).trim();
    const code = part.slice(firstLine + 1).replace(/```$/, '');
    return <div className="code-block" key={index}>
      {language && <div className="code-language">{language}</div>}
      <pre tabIndex={0} aria-label={language ? `${language} ${t('代码')}` : t('代码')}><code>{code}</code></pre>
    </div>;
  })}</div>;
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

function Message({ item, markdown }: { item: ChatItem; markdown: boolean }) {
  const isUser = item.kind === 'user' || item.from === 'user' || item.from === 'human';
  const role = isUser ? t('你') : item.kind === 'system' ? t('系统') : item.kind === 'error' ? t('错误') : item.tool ? t('工具') : t('助手');
  const text = item.text || item.summary;
  const time = formatTime(item.time);
  return <article className={`message ${isUser ? 'message-user' : ''} ${item.kind === 'error' ? 'message-error' : ''}`}>
    <div className="message-meta"><span>{role}</span>{time && <time dateTime={item.time}>{time}</time>}</div>
    {text && <RichText text={text} markdown={markdown} />}
    {item.tool && <details className="tool-detail">
      <summary><Terminal size={15} aria-hidden="true" /><span>{item.tool.name || t('工具调用')}</span><span className="tool-state">{item.tool.done ? t('已完成') : t('未完成')}</span><ChevronDown size={14} aria-hidden="true" /></summary>
      {item.tool.input !== undefined && <div className="tool-section"><span className="field-label">{t('输入')}</span><pre tabIndex={0}>{printable(item.tool.input)}</pre></div>}
      {item.tool.output !== undefined && <div className="tool-section"><span className="field-label">{t('输出')}</span><pre tabIndex={0}>{printable(item.tool.output)}</pre></div>}
    </details>}
    {!text && !item.tool && <p className="muted">{t('此条记录没有文本内容')}</p>}
  </article>;
}

/**
 * Adding a desktop is its own screen: the form is long, needs the camera, and
 * should not push the settings list around.
 */
function AddHost({ onBack, onAdded }: { onBack(): void; onAdded(): void }) {
  const [name, setName] = useState('');
  const [pairing, setPairing] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [reveal, setReveal] = useState(false);
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

function HostSettings({ hosts, onClose, onOpen, onLocaleChange }: { hosts: HostState[]; onClose: () => void; onOpen: (id: string) => void; onLocaleChange(): void }) {
  const [name, setName] = useState('');
  const [pairing, setPairing] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [forgetting, setForgetting] = useState<string>();
  const [removing, setRemoving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  const [renaming, setRenaming] = useState<string>();
  const [renameValue, setRenameValue] = useState('');
  // Long lists stay short by default; a user who expands keeps it expanded.
  const visibleHosts = collapsed && hosts.length > COLLAPSE_AFTER ? hosts.slice(0, COLLAPSE_AFTER) : hosts;
  // Re-render so the resolved locale/zone shown under each control refreshes.
  const [, setTick] = useState(0);
  const overlay = useOverlay();
  // Back on the physical button clears the overlay; mirror that into local state
  // so the dialog/sheet disappears instead of lingering invisibly.
  useEffect(() => {
    if (overlay) return
    if (forgetting) setForgetting(undefined)
    if (renaming) setRenaming(undefined)
    if (scanning) setScanning(false)
  }, [overlay]);
  const bump = () => setTick(value => value + 1);
  const saveLock = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const confirmation = useRef<HTMLDialogElement>(null);
  const forgottenHost = hosts.find(host => host.host.id === forgetting);

  useEffect(() => {
    if (!forgetting) return;
    const dialog = confirmation.current;
    dialog?.showModal();
    return () => { dialog?.close(); };
  }, [forgetting]);

  async function rename(event: FormEvent) {
    event.preventDefault();
    if (!renaming) return;
    const value = renameValue.trim();
    if (!value) { setError(t('名称不能为空')); return; }
    setSaving(true);
    setError('');
    try {
      await controller.renameHost(renaming, value);
      setRenaming(undefined);
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
          {visibleHosts.map(host => <li className="host-row" key={host.host.id}>
            <Server size={21} className="muted" aria-hidden="true" />
            <button className="host-open" onClick={() => onOpen(host.host.id)}><strong>{host.host.name}</strong><Status host={host} /></button>
            <button className="icon-button" title={tWith('重命名 {name}', { name: host.host.name })} aria-label={tWith('重命名 {name}', { name: host.host.name })} onClick={() => { setRenaming(host.host.id); setRenameValue(host.host.name); setError(''); openOverlay({ kind: 'rename' }) }}><Pencil size={17} /></button>
            <button className="icon-button" title={tWith('重新连接 {name}', { name: host.host.name })} aria-label={tWith('重新连接 {name}', { name: host.host.name })} disabled={host.status === 'connecting'} onClick={() => controller.retryHost(host.host.id)}><RefreshCw size={18} className={host.status === 'connecting' ? 'spin' : ''} /></button>
            {host.stopReason && <span className="host-stopped">
              {stopMessage(host.stopReason)}
              <button type="button" className="inline-button" onClick={() => controller.retryHost(host.host.id)}>{t('立即重试')}</button>
            </span>}
            {!host.stopReason && host.status !== 'online' && typeof host.retriesLeft === 'number' && host.retriesLeft > 0 && host.status === 'error' && <span className="host-retries">{t('剩余重试')} {host.retriesLeft}</span>}
            <button className="icon-button danger-button" title={tWith('忘记 {name}', { name: host.host.name })} aria-label={tWith('忘记 {name}', { name: host.host.name })} onClick={() => { setForgetting(host.host.id); openOverlay({ kind: 'forget' }) }}><Trash2 size={18} /></button>
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
          <input type="checkbox" defaultChecked={markdownEnabled()} onChange={event => setMarkdownEnabled(event.target.checked)} />
        </label>
      </section>

      <section className="settings-group">
        <h2 className="group-title">{t('通知与后台')}</h2>
        <label className="toggle-row">
          <span><strong>{t('agent 需要你或已完成时提醒')}</strong><small>{t('不会上传任何内容。')}</small></span>
          <input type="checkbox" defaultChecked={notificationsEnabled()} onChange={event => {
            setNotificationsEnabled(event.target.checked)
            if (event.target.checked) void localNotifier.request()
          }} />
        </label>
        <label className="toggle-row">
          <span><strong>{t('后台保持连接')}</strong><small>{t('退出应用后仍能收到提醒。通知栏会常驻一条状态提示。')}</small></span>
          <input type="checkbox" defaultChecked={keepAliveEnabled()} onChange={event => { setKeepAliveEnabled(event.target.checked); void applyKeepAlive(event.target.checked) }} />
        </label>
        <button type="button" className="secondary-button" onClick={() => void localNotifier.notify({ hostId: 'test', hostName: '本机', paneId: 'test', title: '测试通知 · Herdr', body: '如果你看到这条，通知功能正常。', kind: 'done' }).catch(() => undefined)}>{t('发送测试通知')}</button>
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
    {renaming && <dialog className="confirm-dialog" open aria-labelledby="rename-title">
      <form onSubmit={rename} className="rename-form">
        <h2 id="rename-title">{t('重命名节点')}</h2>
        <label htmlFor="rename-input" className="sr-only">{t('节点名称')}</label>
        <input
          id="rename-input"
          value={renameValue}
          onChange={event => setRenameValue(event.target.value)}
          maxLength={80}
          autoComplete="off"
          autoFocus
          disabled={saving}
        />
        <p className="field-hint">{t('只改本机显示的名称，连接与会话不受影响。')}</p>
        <div className="dialog-actions">
          <button type="button" className="secondary-button" disabled={saving} onClick={() => { setRenaming(undefined); closeOverlay() }}>{t('取消')}</button>
          <button type="submit" className="primary-button" disabled={saving || !renameValue.trim()}>{saving ? <Loader2 className="spin" size={16} /> : <Check size={16} />}{t('保存')}</button>
        </div>
      </form>
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
    for (const alert of tracker.current!.update(hostStates)) void localNotifier.notify(alert).catch(() => undefined)
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
  const [opening, setOpening] = useState<string>();
  const [openError, setOpenError] = useState('');
  const [picking, setPicking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newKind, setNewKind] = useState('claude');
  const [newCwd, setNewCwd] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [renamingPane, setRenamingPane] = useState<string>();
  const [renameValue, setRenameValue] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState('');
  const openingLock = useRef(false);
  useEffect(() => { setOpenError(''); }, [host?.host.id]);
  // A new session starts where the user already is: the focused pane's
  // directory, else the workspace's. Still editable before creating.
  const currentCwd = host?.snapshot?.panes.find((pane) => pane.pane_id === host.snapshot?.panes[0]?.pane_id)?.cwd
    ?? host?.snapshot?.panes[0]?.cwd
    ?? host?.snapshot?.workspaces[0]?.cwd
    ?? '';
  useEffect(() => { setNewCwd((current) => current || currentCwd) }, [currentCwd]);

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
    setRenamingPane(pane.pane_id)
    // Prefill with the name already there, so a stray tap edits rather than
    // wipes it. An unnamed session starts empty and shows the placeholder.
    setRenameValue(current ?? '')
    setRenameError('')
    openOverlay({ kind: 'rename' })
  }

  async function renameSession(event: FormEvent) {
    event.preventDefault()
    if (!host || !renamingPane || renameBusy) return
    setRenameBusy(true)
    setRenameError('')
    try {
      await controller.renameSession(host.host.id, renamingPane, renameValue)
      setRenamingPane(undefined)
      closeOverlay()
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : t('重命名失败'))
    } finally { setRenameBusy(false) }
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
    <header className="page-header"><div className="brand-mark" aria-hidden="true"><Terminal size={23} /></div><div className="header-copy"><h1>Herdr</h1><p>{t('会话')}</p></div><button className="icon-button" title={t('新建会话')} aria-label={t('新建会话')} disabled={!ready} onClick={() => { setNewCwd(currentCwd); setCreating(true) }}><PlusCircle size={21} /></button><button className="icon-button" title={t('节点设置')} aria-label={t('节点设置')} onClick={onSettings}><Settings size={21} /></button></header>
    {host && <div className="host-selector-bar">
      <button type="button" className="host-picker" aria-label={t('当前节点')} aria-haspopup="dialog" aria-expanded={picking} disabled={state.hosts.length < 2} onClick={() => { setPicking(true); openOverlay({ kind: 'hostPicker' }) }}>
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
        <label htmlFor="new-cwd">{t('目录')}</label>
        <input id="new-cwd" value={newCwd} onChange={(event) => setNewCwd(event.target.value)} placeholder={t('默认为当前目录')} autoComplete="off" spellCheck={false} />
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
      {host && !ready && <div className="connection-action"><span>{host.status === 'connecting' ? t('正在连接节点…') : host.status === 'online' ? t('远端 Herdr 当前不在线') : t('节点当前未连接')}</span><button className="secondary-button" disabled={host.status === 'connecting'} onClick={() => controller.retryHost(host.host.id)}><RefreshCw size={16} className={host.status === 'connecting' ? 'spin' : ''} />{t('重新连接')}</button></div>}
      {state.loading ? <Loading label={t('正在读取节点…')} />
        : !state.hosts.length ? <EmptyState icon={<Server size={30} />} title={t('尚未添加节点')}><button className="primary-button" onClick={onSettings}><Plus size={17} />{t('添加节点')}</button></EmptyState>
        : !host ? <div className="pick-host">
            <p className="pick-host-title">{t('选择一个节点')}</p>
            <p className="pick-host-hint">已配对 {state.hosts.length} 台桌面，选择要继续的那台。</p>
            <ul className="pick-host-list">{state.hosts.map(item => <li key={item.host.id}>
              <button type="button" className="pick-host-row" onClick={() => controller.selectHost(item.host.id)}>
                <Server size={19} aria-hidden="true" />
                <span className="pick-host-copy"><strong>{item.host.name}</strong><Status host={item} /></span>
                <ArrowRight size={17} className="muted" aria-hidden="true" />
              </button>
            </li>)}</ul>
            <button type="button" className="secondary-button" onClick={onSettings}>{t('管理节点')}</button>
          </div> : host.status === 'connecting' && !host.snapshot ? <Loading label={t('正在连接节点…')} /> : ready && !host.snapshot ? <Loading label={t('正在读取会话…')} /> : host.snapshot?.panes.length ? <>
        <div className="list-heading"><h2>{t('会话')}</h2><span>{host.snapshot.panes.length}</span></div>
        <ul className="session-list">{host.snapshot.panes.map(pane => {
          const workspace = host.snapshot?.workspaces.find(item => item.workspace_id === pane.workspace_id);
          const workspaceName = workspace?.label || workspace?.name || workspace?.cwd || pane.cwd;
          return <li key={pane.pane_id} className="session-item">
            <button className="session-row" disabled={!ready || Boolean(opening)} onClick={() => void openPane(pane.pane_id)}>
              <span className="session-icon"><Terminal size={20} aria-hidden="true" /></span>
              <span className="session-row-copy"><strong>{paneTitle(pane, tabLabelOf(host.snapshot, pane))}</strong>{workspaceName && <span className="session-path">{workspaceName}</span>}<span className="session-row-meta">{pane.agent || pane.agent_session?.agent || '终端'}{pane.agent_status ? ` · ${pane.agent_status}` : ''}</span></span>
              {opening === pane.pane_id ? <Loader2 size={18} className="spin" aria-label={t('正在打开')} /> : <ArrowRight size={18} className="muted" aria-hidden="true" />}
            </button>
            <button type="button" className="icon-button session-rename" disabled={!ready} aria-label={tWith('重命名 {name}', { name: paneTitle(pane, tabLabelOf(host.snapshot, pane)) })} title={t('重命名会话')} onClick={() => startRename(pane, tabLabelOf(host.snapshot, pane))}><Pencil size={16} /></button>
          </li>;
        })}</ul>
      </> : ready && host.snapshot ? <EmptyState icon={<MessageSquare size={30} />} title={t('暂无会话')}><p>{t('此节点还没有打开的终端会话。')}</p></EmptyState> : <EmptyState icon={<Server size={30} />} title={host.error ? t('无法读取会话') : t('等待节点连接')} />}
    </div>
    {renamingPane && <div className="sheet-backdrop" role="presentation" onClick={() => { setRenamingPane(undefined); closeOverlay() }}>
      <form className="host-sheet" role="dialog" aria-modal="true" aria-label={t('重命名会话')}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => void renameSession(event)}>
        <h2>{t('重命名会话')}</h2>
        <label htmlFor="session-name">{t('会话名称')}</label>
        <input id="session-name" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} maxLength={80} placeholder={t('留空则恢复默认名称')} autoComplete="off" autoFocus />
        <p className="field-hint">{t('名称只影响这项会话的显示，桌面端会同步显示。')}</p>
        {renameError && <Notice error>{renameError}</Notice>}
        <div className="dialog-actions">
          <button type="button" className="secondary-button" onClick={() => { setRenamingPane(undefined); closeOverlay() }}>{t('取消')}</button>
          <button type="submit" className="primary-button" disabled={renameBusy}>{renameBusy ? <Loader2 className="spin" size={16} /> : <Check size={16} />}{t('保存')}</button>
        </div>
      </form>
    </div>}
  </section>;
}

function Session({ session, host }: { session: SessionState; host?: HostState }) {
  // Start on messages unless this pane is known to have no transcript.
  const [mode, setMode] = useState<'messages' | 'terminal'>(() => session.unsupported ? 'terminal' : 'messages');
  // Once a transcript finally arrives, leave the terminal view automatically.
  useEffect(() => { if (!session.unsupported && session.items.length > 0) setMode('messages'); }, [session.unsupported, session.items.length]);
  const [wrap, setWrap] = useState(true);
  const [markdown, setMarkdown] = useState(markdownEnabled);
  const [draft, setDraft] = useState(() => loadDraft(session.hostId, session.paneId));
  // Persist on every change so leaving the session or losing the process keeps it.
  useEffect(() => { saveDraft(session.hostId, session.paneId, draft) }, [draft, session.hostId, session.paneId]);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [localError, setLocalError] = useState('');
  const [newContent, setNewContent] = useState(false);
  // Set when a message was sent and no new transcript item has appeared yet,
  // so the empty tail can show a "thinking" indicator instead of nothing.
  const [awaitingReply, setAwaitingReply] = useState(false);
  const [attachments, setAttachments] = useState<{ id: string; file: File; state: 'pending' | 'uploading' | 'done' | 'failed'; path?: string; error?: string }[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const sentAtCount = useRef(-1);
  const composing = useRef(false);
  const actionLock = useRef(false);
  const scroll = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const olderAnchor = useRef<{ top: number; height: number } | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const ready = canUseHost(host);
  const terminal = session.unsupported || mode === 'terminal';
  // Any newly arrived item means the agent has produced something.
  const info = useMemo(() => parseSessionInfo(stripAnsi(session.screen ?? '')), [session.screen]);
  const agents = useMemo(() => backgroundAgents(session.items), [session.items]);
  const itemCount = session.items.length;
  // Count captured when the message was sent; later growth clears the hint.
  useEffect(() => {
    if (awaitingReply && sentAtCount.current >= 0 && itemCount > sentAtCount.current) setAwaitingReply(false)
  }, [itemCount, awaitingReply]);
  const prompt = useMemo(() => terminal ? null : parsePrompt(stripAnsi(session.screen ?? '')), [terminal, session.screen]);
  const pane = host?.snapshot?.panes.find(item => item.pane_id === session.paneId);
  // The picker appears only while the composer holds a bare `/word`.
  const query = slashQuery(draft);
  const availableCommands = useMemo(
    () => filterCommands(commandsFor(pane?.agent ?? pane?.agent_session?.agent), query ?? ''),
    [pane?.agent, pane?.agent_session?.agent, query],
  );
  const commandOpen = query !== null && availableCommands.length > 0 && !terminal;
  const disabled = !ready || busy || session.sending || session.loading || Boolean(session.uncertain);

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
    return () => observer.disconnect();
  }, []);

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
    try { await controller.loadOlder(); }
    catch {
      olderAnchor.current = null;
      setLocalError(t('更早的记录加载失败，请重试。'));
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

  async function uploadPending(): Promise<string[]> {
    const pending = attachments.filter((item) => item.state !== 'done');
    const paths: string[] = []
    for (const item of attachments) if (item.state === 'done' && item.path) paths.push(item.path)
    for (const item of pending) {
      setAttachments((current) => current.map((entry) => entry.id === item.id ? { ...entry, state: 'uploading' } : entry));
      try {
        const bytes = new Uint8Array(await item.file.arrayBuffer());
        const uploaded = await controller.uploadAttachment(session.hostId, { name: item.file.name, type: item.file.type, bytes });
        paths.push(uploaded.path);
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
    const hasFiles = attachments.some((item) => item.state !== 'failed');
    if ((!text.trim() && !hasFiles) || composing.current || actionLock.current || disabled) return;
    actionLock.current = true;
    setBusy(true);
    setLocalError('');
    try {
      if (terminal) {
        await controller.sendTerminalText(text);
      } else {
        const paths = await uploadPending();
        const message = buildMessage(text, paths.map((path) => ({ path, name: path, size: 0, renamed: false })));
        await controller.sendMessage(message);
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
    catch { setLocalError('选择未确认送达。请核对终端画面后再操作。') }
    finally { setBusy(false); actionLock.current = false }
  }

  function composerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) {
      event.preventDefault();
      void send();
    }
  }

  async function sendKey(key: string) {
    if (disabled || actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setLocalError('');
    try { await controller.sendKeys([key]); }
    catch { setLocalError(t('按键结果未确认。请刷新终端后再决定是否重试。')); }
    finally { setBusy(false); actionLock.current = false; }
  }

  async function refresh() {
    if (refreshing || !ready) return;
    setRefreshing(true);
    setLocalError('');
    try { await controller.readScreen(); }
    catch { setLocalError(t('终端刷新失败，当前显示可能不是最新内容。')); }
    finally { setRefreshing(false); }
  }

  function switchMode(next: 'messages' | 'terminal') {
    followBottom.current = true;
    olderAnchor.current = null;
    setNewContent(false);
    setMode(next);
  }

  return <section className="conversation-view">
    <header className="page-header conversation-header"><button className="icon-button" title={t('返回会话')} aria-label={t('返回会话')} onClick={() => { controller.backToSessions(); back() }}><ArrowLeft size={21} /></button><div className="header-copy"><h1>{paneTitle(pane, tabLabelOf(host?.snapshot, pane))}</h1><p className="session-host-name"><Server size={13} aria-hidden="true" />{host?.host.name || t('未知节点')}
        {info.model && <span className="session-chip" title={t('当前模型')}>{info.model}</span>}
        {info.contextLabel && <span className="session-chip" title={info.contextRatio === undefined ? t('上下文用量') : `${t('上下文已用')} ${Math.round((info.contextRatio ?? 0) * 100)}%`}>{t('上下文')} {info.contextLabel}</span>}
        {agents.length > 0 && <button type="button" className="session-chip is-agents" onClick={() => setAgentsOpen(true)} title={t('查看运行中的 agent')}>
          <span className="agents-dot" aria-hidden="true" />{agents.length} {t('个 agent 运行中')}
        </button>}
      </p></div>{host && <Status host={host} />}</header>
    <div className="view-toolbar"><div className="view-tabs" role="tablist" aria-label={t('会话视图')}><button role="tab" id="messages-tab" aria-controls="session-content" aria-selected={!terminal} disabled={session.unsupported} className={!terminal ? 'is-active' : ''} onClick={() => switchMode('messages')}><MessageSquare size={16} />{t('消息')}</button><button role="tab" id="terminal-tab" aria-controls="session-content" aria-selected={terminal} className={terminal ? 'is-active' : ''} onClick={() => switchMode('terminal')}><Terminal size={16} />{t('终端')}</button></div>{terminal ? <div className="terminal-options"><button className={`icon-button ${wrap ? 'is-active' : ''}`} title={wrap ? '切换为保留原始行' : '切换为自动换行'} aria-label={wrap ? '切换为保留原始行' : '切换为自动换行'} aria-pressed={wrap} onClick={() => setWrap(value => !value)}><WrapText size={18} /></button><button className="icon-button" title={t('刷新终端')} aria-label={t('刷新终端')} disabled={!ready || refreshing} onClick={() => void refresh()}><RefreshCw size={18} className={refreshing ? 'spin' : ''} /></button></div>
      : <div className="message-options"><button className="text-toggle" aria-pressed={markdown} title={markdown ? '显示 Markdown 源码' : '渲染 Markdown'} onClick={() => { const next = !markdown; setMarkdown(next); setMarkdownEnabled(next) }}>{markdown ? <FileCode size={15} /> : <FileText size={15} />}{markdown ? '源码' : '渲染'}</button></div>}</div>
    <div className="session-notices">
      {!ready && <Notice error>{host?.status === 'connecting' ? '连接恢复中，暂时无法发送。' : '节点未连接，暂时无法发送。'}{host && host.status !== 'connecting' && <button className="inline-button" onClick={() => controller.retryHost(host.host.id)}>{t('重新连接')}</button>}</Notice>}
      {session.unsupported && <Notice>{pane?.agent
        ? <>{t('Herdr 还没收到这个 agent 的会话 ID，暂时读不到聊天记录。已在终端视图，读到后会自动切回。')}<button className="inline-button" onClick={() => void controller.reloadSession()}>{t('立即重试')}</button></>
        : '这是一个普通终端会话，没有聊天记录，可直接在终端操作。'}</Notice>}
      {session.uncertain && <Notice error><strong>{t('操作结果不确定')}</strong><p>{session.uncertain}</p><p>{t('请先核对消息或终端内容，避免重复操作。')}</p></Notice>}
      {session.error && <Notice error>{session.error}</Notice>}
      {localError && <Notice error>{localError}</Notice>}
    </div>
    {prompt && !terminal && <div className="prompt-card" role="group" aria-label={t('需要你选择')}>
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
    {agentsOpen && <div className="sheet-backdrop" role="presentation" onClick={() => setAgentsOpen(false)}>
      <div className="host-sheet" role="dialog" aria-modal="true" aria-label={t('运行中的 agent')} onClick={(event) => event.stopPropagation()}>
        <h2>{agents.length} {t('个 agent 运行中')}</h2>
        <ul className="agents-list">{agents.map((agent) => <li key={agent.id} className="agents-row">
          <span className="agents-dot" aria-hidden="true" />
          <span className="agents-copy"><strong>{agent.title}</strong>{agent.kind && <small>{agent.kind}</small>}</span>
        </li>)}</ul>
        <button type="button" className="secondary-button sheet-cancel" onClick={() => setAgentsOpen(false)}>{t('关闭')}</button>
      </div>
    </div>}
    <div className="transcript-shell">
      <div ref={scroll} id="session-content" className={`transcript-scroll ${terminal ? 'terminal-scroll' : ''}`} role="tabpanel" aria-labelledby={terminal ? 'terminal-tab' : 'messages-tab'} aria-busy={session.loading} onScroll={trackScroll} tabIndex={0}>
        {terminal ? <>{session.loading && !session.screen && <Loading label={t('正在读取终端…')} />}{session.screen ? <pre className={`terminal-screen ${wrap ? 'is-wrapped' : ''}`} tabIndex={0} aria-label={t('终端画面')}>{stripAnsi(session.screen)}</pre> : !session.loading && <EmptyState icon={<Terminal size={28} />} title={session.error ? t('终端画面暂不可用') : t('尚无终端画面')}><button className="secondary-button" disabled={!ready || refreshing} onClick={() => void refresh()}><RefreshCw size={16} />{t('读取终端')}</button></EmptyState>}</> : <>
          {session.start > 0 && <div className="older-messages"><button className="text-button" disabled={session.loadingOlder || !ready} onClick={() => void loadOlder()}>{session.loadingOlder ? <Loader2 size={15} className="spin" /> : <ArrowUp size={15} />}{session.loadingOlder ? t('正在加载') : t('更早的记录')}</button></div>}
          {session.loading && !session.items.length ? <Loading label={t('正在读取消息…')} /> : !session.items.length ? <EmptyState icon={<MessageSquare size={28} />} title={session.error ? t('消息暂不可用') : t('暂无消息记录')} /> : <div className="messages">{session.items.map(item => <Message item={item} markdown={markdown} key={item.id} />)}
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
      <label className="sr-only" htmlFor="message-input">{terminal ? '终端输入' : '消息'}</label>
      <textarea ref={composer} id="message-input" rows={1} value={draft} onChange={event => setDraft(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={composerKey} placeholder={!ready ? '节点连接后可发送' : terminal ? '输入终端内容…' : '发送消息…'} disabled={!ready} />
      <button type="submit" className="send-button" title={busy || session.sending ? '正在发送' : terminal ? '发送并回车' : '发送'} aria-label={busy || session.sending ? '正在发送' : terminal ? '发送并回车' : '发送'} disabled={disabled || (!draft.trim() && attachments.length === 0)}>{busy || session.sending ? <Loader2 size={20} className="spin" /> : <Send size={20} />}</button>
    </form>
    <div className="composer-status" role="status">{busy || session.sending ? <><Loader2 size={12} className="spin" />{t('正在发送')}</> : session.queued.length ? `${session.queued.length} 条待发送` : session.uncertain ? '操作结果未确认，发送已暂停' : ready ? <><Check size={12} />{host?.host.name}</> : '发送不可用'}</div>
  </section>;
}

/**
 * Opens the conversation behind a tapped notification.
 *
 * The exact pane may be gone by the time the alert is tapped, so selecting the
 * desktop first and only then the pane keeps a deleted session from leaving the
 * user on a dead screen.
 */
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
  // Reconcile the foreground service with the saved preference on every launch.
  useEffect(() => { void applyKeepAlive(); }, []);

  // Tapping a notification opens the conversation that raised it. The camera
  // tunnel stays closed; only the panes and the transcript are loaded.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    let cancel: (() => void) | undefined
    void import('@capacitor/local-notifications').then(async ({ LocalNotifications }) => {
      const handle = await LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
        const extra = action.notification.extra as { hostId?: string; paneId?: string } | undefined
        if (!extra?.hostId || !extra.paneId) return
        void openSessionFromAlert(extra.hostId, extra.paneId)
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
      if (result.action === 'resume') controller.resume(true)
      if (event === 'visible') controller.retryStopped()
    }
    const onVisibility = () => apply(document.visibilityState === 'hidden' ? 'hidden' : 'visible')
    const onOnline = () => controller.retryStopped()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)
    const timer = setInterval(() => apply('tick'), 60_000)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onOnline)
      clearInterval(timer)
    }
  }, []);
  useAlerts(state.hosts);

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
        ? <Session key={`${route.hostId}:${route.paneId}`} session={state.session} host={sessionHost} />
        : <Sessions
            state={state}
            onSettings={() => push({ name: 'settings' })}
            onOpenSession={(hostId, paneId) => push({ name: 'session', hostId, paneId })}
          />;

  return <main className="app-shell" key={localeRevision}>
    {(state.storageWarning || state.error) && <div className="app-notices">{state.storageWarning && <Notice error>{state.storageWarning}</Notice>}{state.error && <Notice error>{state.error}</Notice>}</div>}
    {screen}
  </main>;
}

export default App;
