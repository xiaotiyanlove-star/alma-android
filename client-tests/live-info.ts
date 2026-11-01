import { EncryptedTunnel } from '../client/transport.ts'
import { parsePairing } from '../client/pairing.ts'
const link = process.env.ALMA_TEST_LINK
if (!link) throw new Error('ALMA_TEST_LINK is required')
const host = await parsePairing('probe', link)
const tunnel = new EncryptedTunnel(host, () => {}, undefined, 25_000)
try {
  await tunnel.connect()
  const info = await tunnel.request<Record<string, any>>('/api/herdr/info')
  console.log(JSON.stringify({ host: info.host, online: info.online, herdrVersion: info.herdr?.version }))
} finally { tunnel.close() }
