import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, ChevronDown,
  Camera, CircleAlert, CornerDownLeft, Eye, EyeOff, Loader2, MessageSquare, Plus, RefreshCw,
  Send, Server, Settings, Square, Terminal, Trash2, WrapText, X,
} from 'lucide-react';
import { controller } from './controller';
import { ScanPairing } from './ScanPairs';
import { AlertTracker, localNotifier } from './notify';
import { applyKeepAlive, keepAliveEnabled, setKeepAliveEnabled } from './keepalive';
import { parsePrompt } from './prompt';
import type { AppState, ChatItem, HostState, Pane, SessionState } from './model';
import './styles.css';

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

function paneTitle(pane?: Pane): string {
  return stripAnsi(pane?.terminal_title_stripped || pane?.cwd?.split('/').filter(Boolean).pop() || '终端会话');
}

function hostStatus(host: HostState): string {
  if (host.status === 'connecting') return '连接中';
  if (host.status === 'error') return '连接失败';
  if (host.status !== 'online') return '未连接';
  return host.herdrOnline ? '已连接' : 'Herdr 离线';
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

function RichText({ text }: { text: string }) {
  const parts = stripAnsi(text).split(/(```[^\n]*\n[\s\S]*?(?:```|$))/g);
  return <div className="message-content">{parts.map((part, index) => {
    if (!part) return null;
    if (!part.startsWith('```')) return <div className="prose-text" key={index}>{part}</div>;
    const firstLine = part.indexOf('\n');
    const language = part.slice(3, firstLine).trim();
    const code = part.slice(firstLine + 1).replace(/```$/, '');
    return <div className="code-block" key={index}>
      {language && <div className="code-language">{language}</div>}
      <pre tabIndex={0} aria-label={language ? `${language} 代码` : '代码'}><code>{code}</code></pre>
    </div>;
  })}</div>;
}

function printable(value: unknown): string {
  if (typeof value === 'string') return stripAnsi(value);
  try { return JSON.stringify(value, null, 2) ?? ''; } catch { return '内容无法显示'; }
}

function Message({ item }: { item: ChatItem }) {
  const isUser = item.kind === 'user' || item.from === 'user' || item.from === 'human';
  const role = isUser ? '你' : item.kind === 'system' ? '系统' : item.kind === 'error' ? '错误' : item.tool ? '工具' : '助手';
  const text = item.text || item.summary;
  return <article className={`message ${isUser ? 'message-user' : ''} ${item.kind === 'error' ? 'message-error' : ''}`}>
    <div className="message-meta"><span>{role}</span>{item.time && <time>{item.time}</time>}</div>
    {text && <RichText text={text} />}
    {item.tool && <details className="tool-detail">
      <summary><Terminal size={15} aria-hidden="true" /><span>{item.tool.name || '工具调用'}</span><span className="tool-state">{item.tool.done ? '已完成' : '未完成'}</span><ChevronDown size={14} aria-hidden="true" /></summary>
      {item.tool.input !== undefined && <div className="tool-section"><span className="field-label">输入</span><pre tabIndex={0}>{printable(item.tool.input)}</pre></div>}
      {item.tool.output !== undefined && <div className="tool-section"><span className="field-label">输出</span><pre tabIndex={0}>{printable(item.tool.output)}</pre></div>}
    </details>}
    {!text && !item.tool && <p className="muted">此条记录没有文本内容</p>}
  </article>;
}

function HostSettings({ hosts, onClose, onOpen }: { hosts: HostState[]; onClose: () => void; onOpen: (id: string) => void }) {
  const [adding, setAdding] = useState(hosts.length === 0);
  const [name, setName] = useState('');
  const [pairing, setPairing] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [forgetting, setForgetting] = useState<string>();
  const [removing, setRemoving] = useState(false);
  const [revealPairing, setRevealPairing] = useState(false);
  const [scanning, setScanning] = useState(false);
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

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !pairing.trim() || saveLock.current) return;
    saveLock.current = true;
    setSaving(true);
    setError('');
    try {
      await controller.addHost(name.trim(), pairing.trim());
      setPairing('');
      setName('');
      setAdding(false);
    } catch {
      setError('节点未保存。请检查配对链接或连接状态后重试。');
    } finally {
      // A failed import must not leave pairing credentials visible or retained in the form.
      setPairing('');
      setSaving(false);
      saveLock.current = false;
    }
  }

  async function forget() {
    if (!forgetting || removing) return;
    setRemoving(true);
    setError('');
    try {
      await controller.forgetHost(forgetting);
      setForgetting(undefined);
    } catch {
      setError('未能移除此节点，请重试。');
    } finally { setRemoving(false); }
  }

  return <section className="settings-view">
    <header className="page-header">
      {hosts.length > 0 ? <button className="icon-button" title="返回会话" aria-label="返回会话" onClick={onClose}><ArrowLeft size={21} /></button> : <span className="icon-button" aria-hidden="true" />}
      <div className="header-copy"><h1>节点</h1><p>Herdr</p></div>
      <button className="icon-button" title="添加节点" aria-label="添加节点" onClick={() => { setAdding(true); requestAnimationFrame(() => nameInput.current?.focus()); }}><Plus size={21} /></button>
    </header>
    <div className="page-scroll">
      {error && <Notice error>{error}</Notice>}
      {hosts.length > 0 && <ul className="host-list">{hosts.map(host => <li className="host-row" key={host.host.id}>
        <Server size={21} className="muted" aria-hidden="true" />
        <button className="host-open" onClick={() => onOpen(host.host.id)}><strong>{host.host.name}</strong><Status host={host} /></button>
        <button className="icon-button" title={`重新连接 ${host.host.name}`} aria-label={`重新连接 ${host.host.name}`} disabled={host.status === 'connecting'} onClick={() => controller.retryHost(host.host.id)}><RefreshCw size={18} className={host.status === 'connecting' ? 'spin' : ''} /></button>
        <button className="icon-button danger-button" title={`忘记 ${host.host.name}`} aria-label={`忘记 ${host.host.name}`} onClick={() => setForgetting(host.host.id)}><Trash2 size={18} /></button>
        {host.error && <div className="host-row-error"><Notice error>{host.error}</Notice></div>}
      </li>)}</ul>}
      {hosts.length === 0 && <EmptyState icon={<Server size={30} />} title="尚未添加节点" />}
      <section className="settings-block">
        <h2>通知</h2>
        <label className="toggle-row">
          <span><strong>agent 需要你或已完成时提醒</strong><small>不会上传任何内容。</small></span>
          <input type="checkbox" defaultChecked={notificationsEnabled()} onChange={event => {
            try { localStorage.setItem(ALERTS_KEY, event.target.checked ? 'on' : 'off') } catch { /* storage blocked */ }
            if (event.target.checked) void localNotifier.request()
          }} />
        </label>
        <label className="toggle-row">
          <span><strong>后台保持连接</strong><small>退出应用后仍能收到提醒。通知栏会常驻一条状态提示。</small></span>
          <input type="checkbox" defaultChecked={keepAliveEnabled()} onChange={event => { setKeepAliveEnabled(event.target.checked); void applyKeepAlive(event.target.checked) }} />
        </label>
        <button type="button" className="secondary-button" onClick={() => void localNotifier.notify({ hostId: 'test', hostName: '本机', paneId: 'test', title: '测试通知 · Herdr', body: '如果你看到这条，通知功能正常。', kind: 'done' }).catch(() => undefined)}>发送测试通知</button>
      </section>
      {adding && <form className="add-host-form" onSubmit={save}>
        <div className="section-heading"><h2>添加节点</h2>{hosts.length > 0 && <button type="button" className="icon-button" title="取消添加" aria-label="取消添加" disabled={saving} onClick={() => { setPairing(''); setAdding(false); }}><X size={18} /></button>}</div>
        <label htmlFor="host-name">节点名称</label>
        <input ref={nameInput} id="host-name" value={name} onChange={event => setName(event.target.value)} placeholder="例如：工作电脑" maxLength={80} autoComplete="off" required disabled={saving} />
        <div className="field-label-row">
          <label htmlFor="pairing-link">配对链接</label>
          <div className="field-actions">
            <button type="button" className="reveal-button" disabled={saving} onClick={() => setScanning(true)}>
              <Camera size={15} />扫码
            </button>
            <button type="button" className="reveal-button" disabled={saving || !pairing} onClick={() => setRevealPairing(value => !value)}>
              {revealPairing ? <EyeOff size={15} /> : <Eye size={15} />}{revealPairing ? '隐藏' : '显示'}
            </button>
          </div>
        </div>
        <textarea
          id="pairing-link"
          className={`pairing-input${revealPairing ? ' is-revealed' : ''}`}
          value={pairing}
          onChange={event => setPairing(event.target.value)}
          placeholder="粘贴以 alma://connect 开头的配对链接"
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
        <p className="field-hint" id="pairing-privacy">{revealPairing ? '内容已显示，注意遮挡屏幕。' : '配对内容已遮挡，点「显示」可核对地址。'}保存后自动清空。</p>
        <button className="primary-button" type="submit" disabled={!name.trim() || !pairing.trim() || saving}>{saving ? <Loader2 className="spin" size={17} /> : <Plus size={17} />}{saving ? '正在添加' : '添加节点'}</button>
      </form>}
      <ScanPairing
        open={scanning}
        onClose={() => setScanning(false)}
        onScanned={link => { setScanning(false); setPairing(link); setRevealPairing(false) }}
      />
    </div>
    {forgetting && <dialog className="confirm-dialog" ref={confirmation} onCancel={event => { if (removing) event.preventDefault(); else setForgetting(undefined); }} aria-labelledby="forget-title" aria-describedby="forget-description">
      <h2 id="forget-title">忘记此节点？</h2>
      <p className="confirm-host">{forgottenHost?.host.name}</p>
      <p id="forget-description">此设备上的连接凭据将被移除。重新连接需要再次配对，不会删除远端会话。</p>
      {error && <Notice error>{error}</Notice>}
      <div className="dialog-actions"><button className="secondary-button" disabled={removing} onClick={() => setForgetting(undefined)}>取消</button><button className="destructive-button" disabled={removing} onClick={() => void forget()}>{removing ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}确认忘记</button></div>
    </dialog>}
  </section>;
}

/**
 * Watches every host snapshot and raises a local notification when an agent
 * starts waiting for the user or finishes. Native only; no server involved.
 */
function useAlerts(hosts: HostState[]) {
  const tracker = useRef<AlertTracker>()
  const enabled = useRef(notificationsEnabled())
  if (!tracker.current) tracker.current = new AlertTracker()
  useEffect(() => {
    void localNotifier.permission().then(async state => {
      if (state === 'prompt' && notificationsEnabled()) await localNotifier.request()
    })
  }, [])
  useEffect(() => {
    if (!enabled.current) return
    const hostStates = hosts.map(host => ({
      ...host,
      snapshot: host.snapshot
        ? { ...host.snapshot, panes: host.snapshot.panes.map(pane => ({ ...pane, agent_status: pane.agent_status })) }
        : undefined,
    }))
    for (const alert of tracker.current!.update(hostStates)) void localNotifier.notify(alert).catch(() => undefined)
  }, [hosts])
}

export const ALERTS_KEY = 'herdr.alerts.enabled'
export function notificationsEnabled(): boolean {
  try { return localStorage.getItem(ALERTS_KEY) !== 'off' } catch { return true }
}

function Sessions({ state, onSettings }: { state: AppState; onSettings: () => void }) {
  const host = state.hosts.find(item => item.host.id === state.selectedHostId) || state.hosts[0];
  const ready = canUseHost(host);
  const [opening, setOpening] = useState<string>();
  const [openError, setOpenError] = useState('');
  const [picking, setPicking] = useState(false);
  const openingLock = useRef(false);
  useEffect(() => { setOpenError(''); }, [host?.host.id]);

  async function openPane(paneId: string) {
    if (openingLock.current || !ready) return;
    openingLock.current = true;
    setOpening(paneId);
    setOpenError('');
    try {
      if (host) controller.selectHost(host.host.id);
      await controller.selectPane(paneId);
    }
    catch { setOpenError('未能打开会话，请检查节点连接后重试。'); }
    finally { setOpening(undefined); openingLock.current = false; }
  }

  return <section className="sessions-view">
    <header className="page-header"><div className="brand-mark" aria-hidden="true"><Terminal size={23} /></div><div className="header-copy"><h1>Herdr</h1><p>会话</p></div><button className="icon-button" title="节点设置" aria-label="节点设置" onClick={onSettings}><Settings size={21} /></button></header>
    {host && <div className="host-selector-bar">
      <button type="button" className="host-picker" aria-label="当前节点" aria-haspopup="dialog" aria-expanded={picking} disabled={state.hosts.length < 2} onClick={() => setPicking(true)}>
        <Server size={18} aria-hidden="true" /><span className="host-picker-name">{host.host.name}</span>
        {state.hosts.length > 1 && <ChevronDown size={16} aria-hidden="true" />}
      </button>
      <Status host={host} />
    </div>}
    {picking && <div className="sheet-backdrop" role="presentation" onClick={() => setPicking(false)}>
      <div className="host-sheet" role="dialog" aria-modal="true" aria-label="选择节点" onClick={event => event.stopPropagation()}>
        <h2>选择节点</h2>
        {state.hosts.map(item => <button
          type="button"
          key={item.host.id}
          className={`sheet-option${item.host.id === host?.host.id ? ' is-current' : ''}`}
          aria-current={item.host.id === host?.host.id}
          onClick={() => { controller.selectHost(item.host.id); setPicking(false); }}
        >
          <span className="sheet-option-copy"><strong>{item.host.name}</strong><Status host={item} /></span>
          {item.host.id === host?.host.id ? <Check size={18} aria-hidden="true" /> : null}
        </button>)}
        <button type="button" className="secondary-button sheet-cancel" onClick={() => setPicking(false)}>取消</button>
      </div>
    </div>}
    <div className="page-scroll">
      {openError && <Notice error>{openError}</Notice>}
      {host?.error && <Notice error>{host.error}</Notice>}
      {host && !ready && <div className="connection-action"><span>{host.status === 'connecting' ? '正在连接节点…' : host.status === 'online' ? '远端 Herdr 当前不在线' : '节点当前未连接'}</span><button className="secondary-button" disabled={host.status === 'connecting'} onClick={() => controller.retryHost(host.host.id)}><RefreshCw size={16} className={host.status === 'connecting' ? 'spin' : ''} />重新连接</button></div>}
      {state.loading ? <Loading label="正在读取节点…" /> : !host ? <EmptyState icon={<Server size={30} />} title="尚未添加节点"><button className="primary-button" onClick={onSettings}><Plus size={17} />添加节点</button></EmptyState> : host.status === 'connecting' && !host.snapshot ? <Loading label="正在连接节点…" /> : ready && !host.snapshot ? <Loading label="正在读取会话…" /> : host.snapshot?.panes.length ? <>
        <div className="list-heading"><h2>会话</h2><span>{host.snapshot.panes.length}</span></div>
        <ul className="session-list">{host.snapshot.panes.map(pane => {
          const workspace = host.snapshot?.workspaces.find(item => item.workspace_id === pane.workspace_id);
          const workspaceName = workspace?.label || workspace?.name || workspace?.cwd || pane.cwd;
          return <li key={pane.pane_id}><button className="session-row" disabled={!ready || Boolean(opening)} onClick={() => void openPane(pane.pane_id)}>
            <span className="session-icon"><Terminal size={20} aria-hidden="true" /></span>
            <span className="session-row-copy"><strong>{paneTitle(pane)}</strong>{workspaceName && <span className="session-path">{workspaceName}</span>}<span className="session-row-meta">{pane.agent || pane.agent_session?.agent || '终端'}{pane.agent_status ? ` · ${pane.agent_status}` : ''}</span></span>
            {opening === pane.pane_id ? <Loader2 size={18} className="spin" aria-label="正在打开" /> : <ArrowRight size={18} className="muted" aria-hidden="true" />}
          </button></li>;
        })}</ul>
      </> : ready && host.snapshot ? <EmptyState icon={<MessageSquare size={30} />} title="暂无会话"><p>此节点还没有打开的终端会话。</p></EmptyState> : <EmptyState icon={<Server size={30} />} title={host.error ? '无法读取会话' : '等待节点连接'} />}
    </div>
  </section>;
}

function Session({ session, host }: { session: SessionState; host?: HostState }) {
  // Start on messages unless this pane is known to have no transcript.
  const [mode, setMode] = useState<'messages' | 'terminal'>(() => session.unsupported ? 'terminal' : 'messages');
  // Once a transcript finally arrives, leave the terminal view automatically.
  useEffect(() => { if (!session.unsupported && session.items.length > 0) setMode('messages'); }, [session.unsupported, session.items.length]);
  const [wrap, setWrap] = useState(true);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [localError, setLocalError] = useState('');
  const [newContent, setNewContent] = useState(false);
  const composing = useRef(false);
  const actionLock = useRef(false);
  const scroll = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const olderAnchor = useRef<{ top: number; height: number } | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const ready = canUseHost(host);
  const terminal = session.unsupported || mode === 'terminal';
  const prompt = useMemo(() => terminal ? null : parsePrompt(stripAnsi(session.screen ?? '')), [terminal, session.screen]);
  const pane = host?.snapshot?.panes.find(item => item.pane_id === session.paneId);
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
      setLocalError('更早的记录加载失败，请重试。');
    }
  }

  async function send() {
    const text = draft;
    if (!text.trim() || composing.current || actionLock.current || disabled) return;
    actionLock.current = true;
    setBusy(true);
    setLocalError('');
    try {
      if (terminal) await controller.sendTerminalText(text);
      else await controller.sendMessage(text);
      setDraft(current => current === text ? '' : current);
      followBottom.current = true;
    } catch {
      setLocalError('消息未确认送达，草稿已保留。请先检查记录或终端，避免重复发送。');
    } finally { setBusy(false); actionLock.current = false; }
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
    catch { setLocalError('按键结果未确认。请刷新终端后再决定是否重试。'); }
    finally { setBusy(false); actionLock.current = false; }
  }

  async function refresh() {
    if (refreshing || !ready) return;
    setRefreshing(true);
    setLocalError('');
    try { await controller.readScreen(); }
    catch { setLocalError('终端刷新失败，当前显示可能不是最新内容。'); }
    finally { setRefreshing(false); }
  }

  function switchMode(next: 'messages' | 'terminal') {
    followBottom.current = true;
    olderAnchor.current = null;
    setNewContent(false);
    setMode(next);
  }

  return <section className="conversation-view">
    <header className="page-header conversation-header"><button className="icon-button" title="返回会话" aria-label="返回会话" onClick={() => controller.backToSessions()}><ArrowLeft size={21} /></button><div className="header-copy"><h1>{paneTitle(pane)}</h1><p className="session-host-name"><Server size={13} aria-hidden="true" />{host?.host.name || '未知节点'}</p></div>{host && <Status host={host} />}</header>
    <div className="view-toolbar"><div className="view-tabs" role="tablist" aria-label="会话视图"><button role="tab" id="messages-tab" aria-controls="session-content" aria-selected={!terminal} disabled={session.unsupported} className={!terminal ? 'is-active' : ''} onClick={() => switchMode('messages')}><MessageSquare size={16} />消息</button><button role="tab" id="terminal-tab" aria-controls="session-content" aria-selected={terminal} className={terminal ? 'is-active' : ''} onClick={() => switchMode('terminal')}><Terminal size={16} />终端</button></div>{terminal && <div className="terminal-options"><button className={`icon-button ${wrap ? 'is-active' : ''}`} title={wrap ? '切换为保留原始行' : '切换为自动换行'} aria-label={wrap ? '切换为保留原始行' : '切换为自动换行'} aria-pressed={wrap} onClick={() => setWrap(value => !value)}><WrapText size={18} /></button><button className="icon-button" title="刷新终端" aria-label="刷新终端" disabled={!ready || refreshing} onClick={() => void refresh()}><RefreshCw size={18} className={refreshing ? 'spin' : ''} /></button></div>}</div>
    <div className="session-notices">
      {!ready && <Notice error>{host?.status === 'connecting' ? '连接恢复中，暂时无法发送。' : '节点未连接，暂时无法发送。'}{host && host.status !== 'connecting' && <button className="inline-button" onClick={() => controller.retryHost(host.host.id)}>重新连接</button>}</Notice>}
      {session.unsupported && <Notice>{pane?.agent
        ? <>Herdr 还没收到这个 agent 的会话 ID，暂时读不到聊天记录。已在终端视图，读到后会自动切回。<button className="inline-button" onClick={() => void controller.reloadSession()}>立即重试</button></>
        : '这是一个普通终端会话，没有聊天记录，可直接在终端操作。'}</Notice>}
      {session.uncertain && <Notice error><strong>操作结果不确定</strong><p>{session.uncertain}</p><p>请先核对消息或终端内容，避免重复操作。</p></Notice>}
      {session.error && <Notice error>{session.error}</Notice>}
      {localError && <Notice error>{localError}</Notice>}
    </div>
    {prompt && !terminal && <div className="prompt-card" role="group" aria-label="需要你选择">
      <div className="prompt-head"><CircleAlert size={16} aria-hidden="true" /><span>需要你选择</span></div>
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
      <p className="prompt-hint">点击后会重新核对终端内容，若问题已变化将取消。也可以在终端里直接操作。</p>
    </div>}
    <div className="transcript-shell">
      <div ref={scroll} id="session-content" className={`transcript-scroll ${terminal ? 'terminal-scroll' : ''}`} role="tabpanel" aria-labelledby={terminal ? 'terminal-tab' : 'messages-tab'} aria-busy={session.loading} onScroll={trackScroll} tabIndex={0}>
        {terminal ? <>{session.loading && !session.screen && <Loading label="正在读取终端…" />}{session.screen ? <pre className={`terminal-screen ${wrap ? 'is-wrapped' : ''}`} tabIndex={0} aria-label="终端画面">{stripAnsi(session.screen)}</pre> : !session.loading && <EmptyState icon={<Terminal size={28} />} title={session.error ? '终端画面暂不可用' : '尚无终端画面'}><button className="secondary-button" disabled={!ready || refreshing} onClick={() => void refresh()}><RefreshCw size={16} />读取终端</button></EmptyState>}</> : <>
          {session.start > 0 && <div className="older-messages"><button className="text-button" disabled={session.loadingOlder || !ready} onClick={() => void loadOlder()}>{session.loadingOlder ? <Loader2 size={15} className="spin" /> : <ArrowUp size={15} />}{session.loadingOlder ? '正在加载' : '更早的记录'}</button></div>}
          {session.loading && !session.items.length ? <Loading label="正在读取消息…" /> : !session.items.length ? <EmptyState icon={<MessageSquare size={28} />} title={session.error ? '消息暂不可用' : '暂无消息记录'} /> : <div className="messages">{session.items.map(item => <Message item={item} key={item.id} />)}</div>}
          {session.queued.length > 0 && <div className="queued-messages">{session.queued.map(item => <article className="message message-user queued-message" key={item.id}><div className="message-meta"><span>你</span><span><Loader2 size={12} className="spin" />等待发送</span></div><RichText text={item.text} /></article>)}</div>}
        </>}
      </div>
      {newContent && <button className="new-content-button secondary-button" onClick={toBottom}><ArrowDown size={16} />最新内容</button>}
    </div>
    {terminal && <div className="terminal-keys" role="group" aria-label="终端按键">
      <button className="key-button icon-button" title="向上" aria-label="发送向上键" disabled={disabled} onClick={() => void sendKey('Up')}><ArrowUp size={18} /></button>
      <button className="key-button icon-button" title="向下" aria-label="发送向下键" disabled={disabled} onClick={() => void sendKey('Down')}><ArrowDown size={18} /></button>
      <button className="key-button icon-button" title="向左" aria-label="发送向左键" disabled={disabled} onClick={() => void sendKey('Left')}><ArrowLeft size={18} /></button>
      <button className="key-button icon-button" title="向右" aria-label="发送向右键" disabled={disabled} onClick={() => void sendKey('Right')}><ArrowRight size={18} /></button>
      <button className="key-button" title="发送回车键" disabled={disabled} onClick={() => void sendKey('Enter')}><CornerDownLeft size={16} /><span>Enter</span></button>
      <button className="key-button" title="发送退出键" disabled={disabled} onClick={() => void sendKey('Escape')}>Esc</button>
      <button className="key-button interrupt-key" title="中断当前终端任务" disabled={disabled} onClick={() => void sendKey('C-c')}><Square size={13} /><span>Ctrl+C</span></button>
    </div>}
    <form className="composer" onSubmit={event => { event.preventDefault(); void send(); }}>
      <label className="sr-only" htmlFor="message-input">{terminal ? '终端输入' : '消息'}</label>
      <textarea ref={composer} id="message-input" rows={1} value={draft} onChange={event => setDraft(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={composerKey} placeholder={!ready ? '节点连接后可发送' : terminal ? '输入终端内容…' : '发送消息…'} disabled={!ready} />
      <button type="submit" className="send-button" title={busy || session.sending ? '正在发送' : terminal ? '发送并回车' : '发送'} aria-label={busy || session.sending ? '正在发送' : terminal ? '发送并回车' : '发送'} disabled={disabled || !draft.trim()}>{busy || session.sending ? <Loader2 size={20} className="spin" /> : <Send size={20} />}</button>
    </form>
    <div className="composer-status" role="status">{busy || session.sending ? <><Loader2 size={12} className="spin" />正在发送</> : session.queued.length ? `${session.queued.length} 条待发送` : session.uncertain ? '操作结果未确认，发送已暂停' : ready ? <><Check size={12} />{host?.host.name}</> : '发送不可用'}</div>
  </section>;
}

export function App() {
  const state = useSyncExternalStore(subscribe, getSnapshot);
  const [view, setView] = useState<'sessions' | 'hosts'>('sessions');
  useEffect(initialize, []);
  // Reconcile the foreground service with the saved preference on every launch.
  useEffect(() => { void applyKeepAlive(); }, []);
  useAlerts(state.hosts);
  const showHosts = view === 'hosts' || (!state.loading && state.hosts.length === 0);
  const sessionHost = state.hosts.find(item => item.host.id === state.session?.hostId);

  return <main className="app-shell">
    {(state.storageWarning || state.error) && <div className="app-notices">{state.storageWarning && <Notice error>{state.storageWarning}</Notice>}{state.error && <Notice error>{state.error}</Notice>}</div>}
    {showHosts ? <HostSettings hosts={state.hosts} onClose={() => setView('sessions')} onOpen={id => { controller.selectHost(id); setView('sessions'); }} /> : state.session ? <Session key={`${state.session.hostId}:${state.session.paneId}`} session={state.session} host={sessionHost} /> : <Sessions state={state} onSettings={() => setView('hosts')} />}
  </main>;
}

export default App;
