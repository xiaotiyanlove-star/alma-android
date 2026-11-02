/**
 * Uploading files to a paired desktop.
 *
 * Alma exposes two raw-body routes on the same HTTP server our tunnel already
 * reaches: `/api/attachments/image` and `/api/attachments/file` (50 MB each).
 * Both take the bytes as the request body and the name in `x-alma-filename`,
 * and answer `{ filePath, filename, size }`. We put the returned absolute path
 * into the message, which is what a desktop user gets when they attach a file.
 */

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
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
  if (size > MAX_ATTACHMENT_BYTES) return `「${name}」超过 50 MB`
  if (existing >= MAX_ATTACHMENTS) return `一次最多 ${MAX_ATTACHMENTS} 个附件`
  return null
}

/**
 * Appends the upload path to the message. Paths are shown plainly so the user
 * can see exactly what the agent will read.
 */
export function buildMessage(text: string, files: UploadedFile[]): string {
  if (!files.length) return text
  const listing = files.map((file) => `- ${file.path}`).join('\n')
  const body = text.trim()
  return body ? `${body}\n\n附件：\n${listing}` : `附件：\n${listing}`
}
