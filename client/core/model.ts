export interface Host {
  id: string
  name: string
  relayUrl: string
  connectCode: string
  addedAt: number
  /**
   * Whether the client keeps a tunnel to this desktop. `false` is the user's
   * own decision — a machine that is off, or on a network they do not want to
   * pay for — so it survives restarts and is never undone automatically.
   * Absent means enabled, so hosts saved before this field existed still work.
   */
  enabled?: boolean
}
export interface Pane {
  pane_id: string
  workspace_id: string
  tab_id: string
  label?: string
  tab_label?: string
  agent?: string
  agent_status?: string
  terminal_title_stripped?: string
  cwd?: string
  /** Directory the pane's foreground process actually runs in, when reported. */
  foreground_cwd?: string
  /**
   * Git branch when the desktop includes it in its workspace snapshot.
   *
   * Herdr versions that do not expose Git leave both fields absent; the branch
   * chip is hidden rather than inventing a value from the terminal title.
   */
  git_branch?: string
  branch?: string
  agent_session?: { value?: string; agent?: string }
}
export interface Workspace { workspace_id: string; label?: string; name?: string; cwd?: string }
export interface Tab { tab_id: string; workspace_id: string; label?: string }
export interface Snapshot { panes: Pane[]; workspaces: Workspace[]; tabs?: Tab[] }
/**
 * An image the transcript points at.
 *
 * The desktop stores images under `/api/herdr/image/<name>` and reports that
 * path; it is fetched through the tunnel rather than by a plain URL load, so a
 * message still cannot make the WebView reach the network on its own.
 */
export interface ImageRef { url: string; mediaType?: string }
export interface ChatItem {
  id: string
  /**
   * `user`, `assistant`, `thinking`, `tool`, `notice`… — the desktop's own
   * vocabulary. `thinking` is the agent's running commentary, folded away with
   * the tool calls rather than shown as an answer.
   */
  kind: string
  text?: string
  summary?: string
  from?: string
  /**
   * `result_images` is the desktop's own field for pictures a tool produced;
   * `images` is kept because item-level and tool-level payloads have used both
   * spellings, and a tool result that renders nothing is hard to notice.
   */
  tool?: { id?: string; name?: string; input?: unknown; output?: unknown; done?: boolean; background?: boolean; images?: ImageRef[]; result_images?: ImageRef[] }
  /** Images the user attached, reported by the desktop. */
  images?: ImageRef[]
  time?: string
}
/**
 * Why a pane has no transcript to read.
 *
 * `terminal` is a plain shell, which never has one. `waiting` is an agent that
 * has not reported its session id yet, which is the normal state for a moment
 * after it starts. `integration` is an agent that has already been given work
 * and still has no session id, which means the Herdr integration never
 * reported one. `transcript` is an agent whose id was reported but whose
 * transcript the desktop cannot find where it looks. `unsupported` is an
 * agent whose transcript this desktop cannot read at all.
 */
export type TranscriptGap = 'terminal' | 'waiting' | 'integration' | 'transcript' | 'unsupported'
/**
 * What the agent is running with, as the desktop reads it from the transcript.
 *
 * Both fields are null when the desktop cannot tell — an agent whose transcript
 * does not record them, or a desktop too old to send them at all.
 */
export interface AgentSettings { model: string | null; effort: string | null }
export interface SessionState { hostId: string; paneId: string; sessionId?: string; items: ChatItem[]; start: number; end: number; queued: { id: string; text: string }[]; loading: boolean; loadingOlder: boolean; screen: string; details?: string; error?: string; unsupported: boolean; gap?: TranscriptGap; sentMessage: boolean; sending: boolean; uncertain?: string; settings?: AgentSettings }
/**
 * Tabs and workspaces the desktop is not alerting for.
 *
 * The list lives on the desktop, so silencing a session here also silences it
 * there and on any other device — which is the point: muting is a statement
 * about the work, not about this phone.
 */
export interface Mutes { workspaces: string[]; tabs: string[] }

export interface HostState {
  host: Host
  /** `disabled` is the user's switch, not a connection result. */
  status: 'offline' | 'connecting' | 'online' | 'error' | 'disabled'
  herdrOnline: boolean
  snapshot?: Snapshot
  error?: string
  /** Why Herdr itself is unavailable, when the desktop says. */
  offlineReason?: string
  /** Empty until the desktop has answered; absent means "unknown, assume none". */
  mutes?: Mutes
  /** Automatic retries still available; 0 means it stopped. */
  retriesLeft?: number
  /**
   * Which path the current connection uses: the local network or the relay.
   *
   * Worth showing: the two differ by two orders of magnitude in latency, and
   * without it "it feels slow" is impossible to act on.
   */
  route?: 'direct' | 'relay'
  /**
   * The desktop's address on the local network, found by scanning.
   *
   * Never a setting and never persisted: it is a guess that has been verified
   * by a full handshake once, and it is safe to forget the moment it stops
   * answering or the phone changes networks.
   */
  discoveredLan?: { host: string; port: number }
  /** Set when the retry ladder deliberately stopped. */
  stopReason?: 'exhausted' | 'auth' | 'unknown-host'
}
export interface AppState {
  hosts: HostState[]
  loading: boolean
  storageWarning?: string
  selectedHostId?: string
  selectedPaneId?: string
  session?: SessionState
  error?: string
  /**
   * The app is on screen. Retry pacing and the idle probe consult it so a
   * hidden app neither burns battery nor redials into the void.
   */
  foreground?: boolean
}
