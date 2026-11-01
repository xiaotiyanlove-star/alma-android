// Live read-only verification against a real Alma node.
// The pairing link comes from ALMA_TEST_LINK and is never written to disk or printed.
// Only GET-style reads: info, snapshot, chat, screen. No prompt/keys/text mutations.
import { EncryptedTunnel } from '../client/transport.ts'
import { parsePairing } from '../client/pairing.ts'

const link = process.env.ALMA_TEST_LINK
if (!link) throw new Error('ALMA_TEST_LINK is required')

const host = await parsePairing('live-test', link)
const states: string[] = []
const tunnel = new EncryptedTunnel(host, (status) => states.push(status), undefined, 25_000)
const timeout = setTimeout(() => { console.error('overall timeout'); process.exit(1) }, 90_000)

try {
  await tunnel.connect()
  const info = await tunnel.request<{ online: boolean; herdr?: { version?: string } }>('/api/herdr/info')

  const snapshot = await new Promise<Record<string, any>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('snapshot timeout')), 15_000)
    const socket = tunnel.subscribe('/ws/herdr', (event) => {
      if (event.type === 'snapshot' && event.snapshot) { clearTimeout(timer); socket.close(); resolve(event.snapshot) }
    }, () => reject(new Error('hub closed before snapshot')))
  })

  const panes = (snapshot.panes || []) as Array<Record<string, any>>
  const workspaces = (snapshot.workspaces || []) as Array<Record<string, any>>
  // Prefer a pane that actually reports a native agent session.
  const first = panes.find((p) => p.agent_session?.value) ?? panes[0]

  let chat: Record<string, any> | null = null
  let older: Record<string, any> | null = null
  let screen: Record<string, any> | null = null
  if (first) {
    chat = await tunnel.request<Record<string, any>>(`/api/herdr/chat?pane=${encodeURIComponent(first.pane_id)}&limit=20`)
    const start = chat?.page?.start
    if (typeof start === 'number' && start > 0) {
      older = await tunnel.request<Record<string, any>>(`/api/herdr/chat?pane=${encodeURIComponent(first.pane_id)}&before=${start}&limit=20`)
    }
    screen = await tunnel.request<Record<string, any>>('/api/herdr/rpc', { method: 'pane.read', params: { pane_id: first.pane_id, source: 'visible', format: 'text' } })
  }

  console.log(JSON.stringify({
    connected: true,
    states,
    herdrOnline: info.online,
    herdrVersion: info.herdr?.version ?? null,
    workspaces: workspaces.map((w) => w.label || w.name || '(未命名)'),
    paneCount: panes.length,
    panes: panes.slice(0, 8).map((p) => ({ agent: p.agent, status: p.agent_status, hasSession: Boolean(p.agent_session?.value), titleLength: String(p.terminal_title_stripped || '').length })),
    chat: chat && {
      hasSessionId: Boolean(chat.session_id),
      errorCode: chat.error?.code ?? null,
      items: chat.page?.items?.length ?? 0,
      kinds: [...new Set((chat.page?.items || []).map((i: any) => i.kind))],
      start: chat.page?.start,
      end: chat.page?.end,
      queued: chat.queued?.length ?? 0,
    },
    olderPage: older && {
      items: older.page?.items?.length ?? 0,
      start: older.page?.start,
      end: older.page?.end,
      overlapsNewer: typeof older.page?.end === 'number' && typeof chat?.page?.start === 'number' ? older.page.end > chat.page.start : null,
      errorCode: older.error?.code ?? null,
    },
    screen: screen && { chars: (screen.result?.read?.text ?? '').length, errorCode: screen.error?.code ?? null },
  }, null, 2))
} finally {
  clearTimeout(timeout)
  tunnel.close()
}
