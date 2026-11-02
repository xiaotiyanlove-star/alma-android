// Creates one throwaway session to prove tab.create + agent.start work over the
// tunnel. Prints nothing about existing sessions.
import { EncryptedTunnel } from '../client/transport.ts'
import { parsePairing } from '../client/pairing.ts'
const link = process.env.ALMA_TEST_LINK
if (!link) throw new Error('ALMA_TEST_LINK is required')
const host = await parsePairing('probe', link)
const tunnel = new EncryptedTunnel(host, () => {}, undefined, 25_000)
const rpc = async <T>(method: string, params: Record<string, unknown>) => {
  const r = await tunnel.request<{ result?: T; error?: { code?: string; message?: string } }>('/api/herdr/rpc', { method, params })
  if (r.error) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.result as T
}
try {
  await tunnel.connect()
  const created = await rpc<{ root_pane?: { pane_id?: string; workspace_id?: string }; tab?: { tab_id?: string } }>('tab.create', { cwd: '/private/tmp', focus: false })
  const paneId = created?.root_pane?.pane_id
  console.log(JSON.stringify({ tabCreated: true, paneId, workspaceId: created?.root_pane?.workspace_id }))
  if (!paneId) throw new Error('no root pane')
  let started = false
  for (let i = 0; i < 6 && !started; i++) {
    try {
      await rpc('agent.start', { name: `probe-${Date.now() % 10000}`, kind: 'claude', pane_id: paneId, timeout_ms: 45000 })
      started = true
    } catch (e) {
      if (!/not an available shell/i.test(String(e))) throw e
      await new Promise((r) => setTimeout(r, 900))
    }
  }
  console.log(JSON.stringify({ agentStarted: started, paneId }))
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error).slice(0, 240) }))
} finally { tunnel.close() }
