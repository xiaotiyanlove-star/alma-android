export interface Host { id: string; name: string; relayUrl: string; connectCode: string; addedAt: number }
export interface Pane { pane_id: string; workspace_id: string; tab_id: string; agent?: string; agent_status?: string; terminal_title_stripped?: string; cwd?: string; agent_session?: { value?: string; agent?: string } }
export interface Workspace { workspace_id: string; label?: string; name?: string; cwd?: string }
export interface Snapshot { panes: Pane[]; workspaces: Workspace[]; tabs?: unknown[] }
export interface ChatItem { id: string; kind: string; text?: string; summary?: string; from?: string; tool?: { id?: string; name?: string; input?: unknown; output?: unknown; done?: boolean }; time?: string }
export interface SessionState { hostId: string; paneId: string; sessionId?: string; items: ChatItem[]; start: number; end: number; queued: { id: string; text: string }[]; loading: boolean; loadingOlder: boolean; screen: string; error?: string; unsupported: boolean; sending: boolean; uncertain?: string }
export interface HostState { host: Host; status: 'offline' | 'connecting' | 'online' | 'error'; herdrOnline: boolean; snapshot?: Snapshot; error?: string }
export interface AppState { hosts: HostState[]; loading: boolean; storageWarning?: string; selectedHostId?: string; selectedPaneId?: string; session?: SessionState; error?: string }
