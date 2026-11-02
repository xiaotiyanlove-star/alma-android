// Read-only probe: confirm the Alma attachment routes and Herdr tab create
// exist on a real desktop, without creating anything.
import { EncryptedTunnel } from '../client/transport.ts'
import { parsePairing } from '../client/pairing.ts'
const link = process.env.ALMA_TEST_LINK
if (!link) throw new Error('ALMA_TEST_LINK is required')
const host = await parsePairing('probe', link)
const tunnel = new EncryptedTunnel(host, () => {}, undefined, 25_000)
try {
  await tunnel.connect()
  const out: Record<string, unknown> = {}
  // Does the attachment route answer at all? Expect 400/413 for an empty body,
  // which still proves the route is mounted (404 would mean it is absent).
  for (const path of ['/api/attachments/resolve-path?path=/tmp', '/api/herdr/files?pane=w1:p1']) {
    try {
      const r = await tunnel.request<unknown>(path)
      out[path] = { ok: true, sample: JSON.stringify(r).slice(0, 120) }
    } catch (e) { out[path] = { ok: false, error: String(e).slice(0, 120) } }
  }
  // Snapshot tells us which workspace/cwd a new tab would inherit.
  const snap = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 12000)
    const s = tunnel.subscribe('/ws/herdr', (e) => { if (e.type === 'snapshot') { clearTimeout(timer); s.close(); resolve(e.snapshot) } }, () => reject(new Error('closed')))
  })
  out.panes = (snap.panes || []).map((p: any) => ({ pane: p.pane_id, ws: p.workspace_id, cwd: p.foreground_cwd ?? p.cwd }))
  out.workspaces = (snap.workspaces || []).map((w: any) => ({ id: w.workspace_id, cwd: w.cwd, label: w.label }))
  console.log(JSON.stringify(out, null, 2))
} finally { tunnel.close() }
