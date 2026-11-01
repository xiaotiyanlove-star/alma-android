// Read-only: probe every pane's chat endpoint to find why a pane with visible
// content reports "no transcript". Prints metadata only (no message text).
import { EncryptedTunnel } from '../client/transport.ts'
import { parsePairing } from '../client/pairing.ts'

const link = process.env.ALMA_TEST_LINK
if (!link) throw new Error('ALMA_TEST_LINK is required')
const host = await parsePairing('probe', link)
const tunnel = new EncryptedTunnel(host, () => {}, undefined, 25_000)
try {
  await tunnel.connect()
  const snapshot = await new Promise<Record<string, any>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('snapshot timeout')), 15_000)
    const socket = tunnel.subscribe('/ws/herdr', (event) => {
      if (event.type === 'snapshot' && event.snapshot) { clearTimeout(timer); socket.close(); resolve(event.snapshot) }
    }, () => reject(new Error('closed')))
  })
  const workspaces = new Map<string, string>((snapshot.workspaces || []).map((w: any) => [w.workspace_id, w.label || w.name || '']))
  const rows = []
  for (const pane of snapshot.panes || []) {
    const chat = await tunnel.request<Record<string, any>>(`/api/herdr/chat?pane=${encodeURIComponent(pane.pane_id)}&limit=5`)
    rows.push({
      pane: pane.pane_id,
      workspace: workspaces.get(pane.workspace_id) ?? pane.workspace_id,
      agent: pane.agent ?? null,
      status: pane.agent_status ?? null,
      sessionAgent: pane.agent_session?.agent ?? null,
      sessionKind: pane.agent_session?.kind ?? null,
      hasSessionValue: Boolean(pane.agent_session?.value),
      chatError: chat?.error?.code ?? null,
      chatErrorMsg: chat?.error?.message ?? null,
      items: chat?.page?.items?.length ?? 0,
      sessionIdPresent: Boolean(chat?.session_id),
    })
  }
  console.log(JSON.stringify(rows, null, 2))
} finally { tunnel.close() }
