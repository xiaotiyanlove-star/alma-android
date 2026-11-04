import type { Host } from './model'

/**
 * A Herdr attachment points at a file on the paired desktop. It must never be
 * fetched from a URL inside the agent text: resolve only to the fixed desktop
 * file endpoint, reached through the already-authenticated E2E tunnel.
 */
export function mediaRequestPath(ref: string): string | null {
  if (ref.startsWith('/api/herdr/image/')) return ref
  if (ref.startsWith('/api/')) return ref.startsWith('/api/herdr/file') ? ref : null
  if (ref.startsWith('/') || ref.startsWith('~/')) {
    return `/api/herdr/file?path=${encodeURIComponent(ref)}`
  }
  return null
}

/**
 * Fetches a desktop image over its encrypted tunnel and makes a local data URL
 * for <img>. No third-party origin is contacted; the WebView only sees the
 * bytes after the tunnel has authenticated and decrypted them.
 */
export async function readDesktopImage(host: Host, ref: string, signal?: AbortSignal): Promise<string> {
  const path = mediaRequestPath(ref)
  if (!path) throw new Error('Unsupported remote image reference')
  const response = await fetch(`${host.relayUrl.replace(/^https:/, 'https:')}${path}`, { signal })
  if (!response.ok) throw new Error(`Image fetch failed (${response.status})`)
  const type = response.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
  if (!type.startsWith('image/')) throw new Error('Remote file is not an image')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length > 50 * 1024 * 1024) throw new Error('Image is too large')
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:${type};base64,${btoa(binary)}`
}

/** Host identity keeps a rendered image out of the wrong paired session. */
export function mediaCacheKey(host: Host, ref: string): string {
  return `${host.id}\u0000${ref}`
}
