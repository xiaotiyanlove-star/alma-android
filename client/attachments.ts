/**
 * Uploading files to a paired desktop.
 *
 * Alma exposes two raw-body routes on the same HTTP server our tunnel already
 * reaches: `/api/attachments/image` and `/api/attachments/file`.
 * Both take the bytes as the request body and the name in `x-alma-filename`,
 * and answer `{ filePath, filename, size }`. We put the returned absolute path
 * into the message, which is what a desktop user gets when they attach a file.
 *
 * The ceiling is not Alma's 50 MB per route: it is the tunnel. Our whole upload
 * is one sealed WebSocket message, and the relay accepts at most 32 MiB per
 * message (a Durable Object limit that both relay editions inherit). A file
 * over that is refused mid-upload, after the user has waited for it — and
 * because the send is a mutation, it is reported as "may have run" rather than
 * "too big". Checking here turns that into an immediate, honest refusal.
 *
 * `FRAME_LIMIT_BYTES` mirrors `transport.ts`. When the relay gains streamed
 * bodies (protocol 2), raise both together; the live probe in
 * `client-tests/live-upload-limit.ts` measures the real ceiling on a given
 * deployment rather than trusting this comment.
 */
export const FRAME_LIMIT_BYTES = 32 * 1024 * 1024

/**
 * The most a single attachment may be.
 *
 * The body is base64-encoded inside the sealed frame when the desktop did not
 * negotiate binary frames, and base64 costs four bytes for every three: at
 * 24 MiB the encoded body alone lands on the 32 MiB relay limit, before the
 * IV, the tag and the JSON header. That failed mid-send every time against a
 * desktop without `bin: 1`, and because an upload is a mutation the user was
 * told it might have run. 16 MiB encodes to about 21.3 MiB, which leaves the
 * same headroom in the worst case as the old figure did in the best.
 */
export const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024

/** What the size check and the error copy agree on. */
export const MAX_ATTACHMENT_MB = MAX_ATTACHMENT_BYTES / (1024 * 1024)
export const MAX_ATTACHMENTS = 6

export interface UploadedFile {
  /** Absolute path on the desktop. */
  path: string
  name: string
  size: number
  /** True when the desktop stored it under its own content-hash name. */
  renamed: boolean
}

export interface UploadResponse {
  filePath?: string
  filename?: string
  size?: number
  error?: string
}

/**
 * The path an image reference is fetched from.
 *
 * The desktop reports two shapes: a route under `/api/…` that is used as-is,
 * and a plain absolute path (`/Users/me/shot.png`) for a local file, which the
 * desktop serves through `/api/herdr/file?path=`. The official client rewrites
 * exactly the same way, so anything else is refused rather than turned into a
 * request the message chose.
 */
export function imageRequestPath(ref: string): string {
  if (ref.startsWith('/api/')) return ref
  // Only absolute paths. `//host` is excluded because a URL parser reads it as
  // a host, and the desktop resolves a bare `~/` itself, which is how a
  // transcript names a picture in the user's home directory.
  if ((ref.startsWith('/') && !ref.startsWith('//')) || ref.startsWith('~/')) {
    return `/api/herdr/file?path=${encodeURIComponent(ref)}`
  }
  throw new Error('不支持这个图片来源')
}

/**
 * Whether an attachment will render as a picture.
 *
 * Not just `file.type`: Android's document picker frequently hands back an
 * empty MIME type for a perfectly ordinary PNG, and a picture that is not
 * recognised here is later fetched from the desktop, which does not serve an
 * uploaded attachment back through its image route.
 */
export function looksLikeImage(file: { name: string; type?: string }): boolean {
  if (/^image\//i.test(file.type ?? '')) return true
  return /\.(png|jpe?g|gif|webp|heic|avif)$/i.test(file.name)
}

/**
 * The type an attachment is really in.
 *
 * Android's picker returns `''` for many files, and a type that is neither a
 * real image type nor `application/octet-stream` is worse than useless: it
 * decides both the upload route and what the agent is told it received. A PNG
 * uploaded as `application/octet-stream` reaches the desktop as a generic file
 * — the agent then sees "a file", and the phone can never show it as a picture.
 *
 * So the bytes decide, then the name, and only then the browser's guess.
 */
export function resolveMediaType(file: { name: string; type?: string }, bytes: Uint8Array): string {
  const declared = (file.type ?? '').toLowerCase()
  if (declared && declared !== 'application/octet-stream') {
    // A declared type wins unless it is generic; browsers sometimes declare
    // `application/octet-stream` for a plain PNG.
    if (declared !== 'binary/octet-stream') return declared
  }
  const sniffed = sniffMediaType(bytes)
  if (sniffed) return sniffed
  const byName = extensionMediaType(file.name)
  return byName || 'application/octet-stream'
}

/** Reads the first bytes of the common formats the desktop accepts. */
export function sniffMediaType(bytes: Uint8Array): string | null {
  const at = (index: number, ...values: number[]) => values.every((value, offset) => bytes[index + offset] === value)
  if (bytes.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (bytes.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (bytes.length >= 6 && at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  // RIFF....WEBP
  if (bytes.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'
  // ISO-BMFF brands: ....ftyp<brand>
  if (bytes.length >= 12 && at(4, 0x66, 0x74, 0x79, 0x70)) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]).toLowerCase()
    if (brand === 'avif' || brand === 'avis') return 'image/avif'
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return 'image/heic'
  }
  if (bytes.length >= 4 && at(0, 0x25, 0x50, 0x44, 0x46)) return 'application/pdf'
  return null
}

function extensionMediaType(name: string): string | null {
  const match = /\.([a-z0-9]+)$/i.exec(name)
  if (!match) return null
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', heic: 'image/heic', avif: 'image/avif', pdf: 'application/pdf',
    txt: 'text/plain', md: 'text/markdown', json: 'application/json', log: 'text/plain',
  }
  return map[match[1].toLowerCase()] ?? null
}

/** Chooses the image route only for what the desktop will accept there. */
export function uploadRoute(mediaType: string): string {
  const type = mediaType.toLowerCase()
  if (type === 'image/png' || type === 'image/jpeg' || type === 'image/webp' || type === 'image/gif' || type === 'image/heic') {
    return '/api/attachments/image'
  }
  return '/api/attachments/file'
}

/** Rejects what the desktop would reject, before spending an upload. */
export function checkFile(name: string, size: number, existing: number): string | null {
  if (!name.trim()) return '文件名为空'
  if (size <= 0) return `「${name}」是空文件`
  if (size > MAX_ATTACHMENT_BYTES) return `「${name}」超过 ${MAX_ATTACHMENT_MB} MB`
  if (existing >= MAX_ATTACHMENTS) return `一次最多 ${MAX_ATTACHMENTS} 个附件`
  return null
}

/**
 * Appends the upload path to the message. Paths are shown plainly so the user
 * can see exactly what the agent will read.
 */
export function buildMessage(text: string, files: UploadedFile[]): string {
  if (!files.length) return text
  // One path per line with a blank line before the list, so markdown renders
  // it as its own block instead of running into the sentence above.
  const listing = files.map((file) => `- ${file.path}`).join('\n')
  const body = text.trim()
  return body ? `${body}\n\n附件：\n\n${listing}` : `附件：\n\n${listing}`
}

