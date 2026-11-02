import { EncryptedTunnel } from '../client/transport.ts'
import { parsePairing } from '../client/pairing.ts'
const link = process.env.ALMA_TEST_LINK
if (!link) throw new Error('x')
const host = await parsePairing('p', link)
const t = new EncryptedTunnel(host, () => {}, undefined, 25_000)
try {
  await t.connect()
  const r = await t.request<Record<string, any>>('/api/herdr/rpc', { method: 'pane.get', params: { pane_id: 'w1:p2' } })
  const pane = r.result?.pane ?? {}
  console.log(JSON.stringify({ keys: Object.keys(pane), session: pane.agent_session, title: pane.terminal_title_stripped }))
} catch (e) { console.log('ERR', String(e).slice(0, 160)) } finally { t.close() }
