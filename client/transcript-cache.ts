/**
 * Recently viewed transcripts, owned independently of the network layer.
 *
 * The cache is a paint aid only: callers must refresh from the live transcript
 * after reading it. It never decides whether a transcript is current.
 */
import type { ChatItem, SessionState } from './model'

export interface StoredTranscript {
  sessionId?: string
  items: ChatItem[]
  start: number
  end: number
  queued: SessionState['queued']
  screen: string
  settings?: SessionState['settings']
  details?: string
  at: number
}

export const TRANSCRIPT_TTL = 5 * 60_000
export const TRANSCRIPT_CACHE = 6

const key = (hostId: string, paneId: string) => `${hostId}\u0000${paneId}`

export class TranscriptCache {
  private entries = new Map<string, StoredTranscript>()

  constructor(
    private readonly limit = TRANSCRIPT_CACHE,
    private readonly ttl = TRANSCRIPT_TTL,
  ) {}

  has(hostId: string, paneId: string, now = Date.now()): boolean {
    const id = key(hostId, paneId)
    const stored = this.entries.get(id)
    if (!stored) return false
    if (now - stored.at > this.ttl) { this.entries.delete(id); return false }
    return true
  }

  put(hostId: string, paneId: string, transcript: StoredTranscript, keep?: { hostId: string; paneId: string }): void {
    const id = key(hostId, paneId)
    this.entries.delete(id)
    this.entries.set(id, transcript)
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      if (keep && oldest === key(keep.hostId, keep.paneId)) {
        const entry = this.entries.get(oldest)!
        this.entries.delete(oldest)
        this.entries.set(oldest, entry)
        continue
      }
      this.entries.delete(oldest)
    }
  }

  take(hostId: string, paneId: string, now = Date.now()): StoredTranscript | undefined {
    const id = key(hostId, paneId)
    const stored = this.entries.get(id)
    if (!stored) return undefined
    if (now - stored.at > this.ttl) {
      this.entries.delete(id)
      return undefined
    }
    return stored
  }

  get size(): number { return this.entries.size }
  clear(): void { this.entries.clear() }
}
