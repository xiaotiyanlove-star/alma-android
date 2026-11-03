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
export interface Pane { pane_id: string; workspace_id: string; tab_id: string; label?: string; tab_label?: string; agent?: string; agent_status?: string; terminal_title_stripped?: string; cwd?: string; agent_session?: { value?: string; agent?: string } }
export interface Workspace { workspace_id: string; label?: string; name?: string; cwd?: string }
export interface Tab { tab_id: string; workspace_id: string; label?: string }
export interface Snapshot { panes: Pane[]; workspaces: Workspace[]; tabs?: Tab[] }
export interface ChatItem { id: string; kind: string; text?: string; summary?: string; from?: string; tool?: { id?: string; name?: string; input?: unknown; output?: unknown; done?: boolean; background?: boolean }; time?: string }
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
export interface SessionState { hostId: string; paneId: string; sessionId?: string; items: ChatItem[]; start: number; end: number; queued: { id: string; text: string }[]; loading: boolean; loadingOlder: boolean; screen: string; error?: string; unsupported: boolean; gap?: TranscriptGap; sentMessage: boolean; sending: boolean; uncertain?: string }
export interface HostState {
  host: Host
  /** `disabled` is the user's switch, not a connection result. */
  status: 'offline' | 'connecting' | 'online' | 'error' | 'disabled'
  herdrOnline: boolean
  snapshot?: Snapshot
  error?: string
  /** Automatic retries still available; 0 means it stopped. */
  retriesLeft?: number
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
   * The app is on screen. Retry pacing and liveness probes consult it so a
   * hidden app neither burns battery nor redials into the void.
   */
  foreground?: boolean
}
