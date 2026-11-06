/**
 * App updates, checked against this fork's public GitHub Releases.
 *
 * The APK is always signed with the same release key, so a newer version can
 * install over the current one and keep its paired desktops. The browser
 * preview has no installer, so it only reports what it found.
 */
import { Capacitor, registerPlugin } from '@capacitor/core'
import { APP_VERSION } from './version'

export const RELEASE_REPO = 'xiaotiyanlove-star/alma-android'
export const RELEASE_API = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`

export interface ReleaseInfo {
  version: string
  tag: string
  notes: string
  publishedAt: string
  apkUrl: string
  checksumUrl: string
  pageUrl: string
}

export interface UpdateResult {
  available: boolean
  current: string
  release?: ReleaseInfo
}

interface DownloaderPlugin {
  downloadAndInstall(options: { url: string; checksumUrl: string; version: string }): Promise<{ started: boolean }>
  status(): Promise<{ phase: 'idle' | 'downloading' | 'installing' | 'failed'; reason: string; progress: number }>
}
const downloader = registerPlugin<DownloaderPlugin>('Downloader')

/** Numeric comparison, so 0.1.10 is newer than 0.1.9. */
export function compareVersions(a: string, b: string): number {
  const left = a.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  const right = b.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0)
    if (delta) return delta
  }
  return 0
}

function newerRelease(value: unknown, current: string): ReleaseInfo | undefined {
  if (!value || typeof value !== 'object') return undefined
  const release = value as Record<string, unknown>
  const tag = typeof release.tag_name === 'string' ? release.tag_name : ''
  const assets = Array.isArray(release.assets) ? release.assets : []
  const apk = assets.find((asset): asset is { name: string; browser_download_url: string } => {
    if (!asset || typeof asset !== 'object') return false
    const entry = asset as Record<string, unknown>
    return typeof entry.name === 'string' && entry.name.endsWith('.apk') && typeof entry.browser_download_url === 'string'
  })
  const checksum = assets.find((asset): asset is { name: string; browser_download_url: string } => {
    if (!asset || typeof asset !== 'object') return false
    const entry = asset as Record<string, unknown>
    return typeof entry.name === 'string' && entry.name.endsWith('.apk.sha256') && typeof entry.browser_download_url === 'string'
  })
  if (!tag || !apk || !checksum) return undefined
  if (compareVersions(tag, current) <= 0) return undefined
  return {
    version: tag.replace(/^v/, ''),
    tag,
    notes: typeof release.body === 'string' ? release.body : '',
    publishedAt: typeof release.published_at === 'string' ? release.published_at : '',
    apkUrl: apk.browser_download_url,
    checksumUrl: checksum.browser_download_url,
    pageUrl: typeof release.html_url === 'string' ? release.html_url : `https://github.com/${RELEASE_REPO}/releases/tag/${tag}`,
  }
}

export async function checkForUpdate(current = APP_VERSION, signal?: AbortSignal): Promise<UpdateResult> {
  const response = await fetch(RELEASE_API, {
    headers: { Accept: 'application/vnd.github+json' },
    signal,
  })
  if (!response.ok) throw new Error(`Update check failed (${response.status})`)
  const release = newerRelease(await response.json(), current)
  return { available: Boolean(release), current, release }
}

export async function installUpdate(release: ReleaseInfo): Promise<void> {
  if (!Capacitor.isNativePlatform()) throw new Error('Installing an update needs the Android app')
  await downloader.downloadAndInstall({
    url: release.apkUrl,
    checksumUrl: release.checksumUrl,
    version: release.version,
  })
}

export type UpdatePhase = 'idle' | 'downloading' | 'installing' | 'failed'

export interface UpdateProgress {
  phase: UpdatePhase
  reason: string
  progress: number
}

/** The native download's state; the page polls while an update is in flight. */
export async function updateProgress(): Promise<UpdateProgress> {
  if (!Capacitor.isNativePlatform()) return { phase: 'idle', reason: '', progress: 0 }
  const state = await downloader.status()
  return {
    phase: state?.phase ?? 'idle',
    reason: typeof state?.reason === 'string' ? state.reason : '',
    progress: Number.isFinite(state?.progress) ? Number(state.progress) : 0,
  }
}
