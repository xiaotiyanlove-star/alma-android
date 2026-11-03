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
 * Deliberately below the frame limit: the sealed frame carries the attachment
 * plus its authentication tag and the JSON header that names the route, and a
 * user who picks a file in the last few megabytes of headroom would otherwise
 * hit the wall with no useful error.
 */
export const MAX_ATTACHMENT_BYTES = 24 * 1024 * 1024

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
