// Real upload check against the paired desktop. Uploads a tiny synthetic file
// under the same directory Alma uses for attachments; touches no session.
import { EncryptedTunnel } from '../client/transport.ts'
import { parsePairing } from '../client/pairing.ts'
const link = process.env.ALMA_TEST_LINK
if (!link) throw new Error('ALMA_TEST_LINK is required')
const host = await parsePairing('probe', link)
const tunnel = new EncryptedTunnel(host, () => {}, undefined, 25_000)
try {
  await tunnel.connect()
  const bytes = new TextEncoder().encode('herdr-remote upload probe\n')
  const result = await tunnel.request<Record<string, unknown>>('/api/attachments/file', undefined, {
    raw: bytes,
    headers: { 'content-type': 'text/plain', 'x-alma-filename': encodeURIComponent('herdr-probe.txt') },
  })
  console.log(JSON.stringify({ ok: true, filePath: result.filePath, filename: result.filename, size: result.size }, null, 2))
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error).slice(0, 200) }))
} finally { tunnel.close() }
