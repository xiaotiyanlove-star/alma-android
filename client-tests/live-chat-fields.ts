import { EncryptedTunnel } from '../client/transport.ts'
import { parsePairing } from '../client/pairing.ts'
const link = process.env.ALMA_TEST_LINK
if (!link) throw new Error('ALMA_TEST_LINK required')
const host = await parsePairing('p', link)
const tunnel = new EncryptedTunnel(host, () => {}, undefined, 25_000)
try {
  await tunnel.connect()
  for (const pane of ['w1:p2', 'w1:p1']) {
    const r = await tunnel.request<Record<string, any>>(`/api/herdr/chat?pane=${encodeURIComponent(pane)}&limit=3`)
    const items = r.page?.items ?? []
    console.log(JSON.stringify({ pane, error: r.error?.code ?? null, count: items.length, keys: items.length ? Object.keys(items[items.length - 1]) : [] }))
  }
} catch (e) { console.log('ERR', String(e).slice(0, 160)) } finally { tunnel.close() }
