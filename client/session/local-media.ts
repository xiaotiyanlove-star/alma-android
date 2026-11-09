export interface LocalMediaEntry {
  owner: string
  path: string
  name: string
  url: string
}

export function localMediaOwner(hostId: string, paneId: string): string {
  return `${hostId}\u0000${paneId}`
}

export function localMediaKey(owner: string, path: string): string {
  return `${owner}\u0000${path}`
}

export function basename(reference: string): string {
  return reference.split('/').filter(Boolean).pop() ?? ''
}

export function localCopy(
  localImages: Readonly<Record<string, LocalMediaEntry>> | undefined,
  owner: string,
  reference: string,
): string | undefined {
  if (!localImages) return undefined
  const exact = localImages[localMediaKey(owner, reference)]
  if (exact) return exact.url
  const name = basename(reference)
  if (!name) return undefined
  for (const entry of Object.values(localImages)) {
    if (entry.owner === owner && entry.name === name) return entry.url
  }
  return undefined
}

export function addLocalMedia(
  current: Readonly<Record<string, LocalMediaEntry>>,
  owner: string,
  uploadedPath: string,
  originalName: string,
  url: string,
): Record<string, LocalMediaEntry> {
  const key = localMediaKey(owner, uploadedPath)
  const previous = current[key]
  if (previous?.url && previous.url !== url) URL.revokeObjectURL(previous.url)
  return {
    ...current,
    [key]: { owner, path: uploadedPath, name: originalName || basename(uploadedPath), url },
  }
}

export function clearLocalMedia(
  current: Readonly<Record<string, LocalMediaEntry>>,
  owner: string,
): Record<string, LocalMediaEntry> {
  const next: Record<string, LocalMediaEntry> = {}
  for (const [key, entry] of Object.entries(current)) {
    if (entry.owner === owner) URL.revokeObjectURL(entry.url)
    else next[key] = entry
  }
  return next
}

export function evictOldestLocalMedia(
  current: Readonly<Record<string, LocalMediaEntry>>,
  maximum: number,
): Record<string, LocalMediaEntry> {
  const entries = Object.entries(current)
  if (entries.length <= maximum) return current as Record<string, LocalMediaEntry>
  const next: Record<string, LocalMediaEntry> = {}
  entries.forEach(([key, entry], index) => {
    if (index < entries.length - maximum) URL.revokeObjectURL(entry.url)
    else next[key] = entry
  })
  return next
}
