/**
 * One bounded path for remote transcript pictures.
 *
 * The cache never performs I/O itself. It only coalesces concurrent reads and
 * remembers successful data URLs per host, so a controller replacement cannot
 * reuse bytes from another desktop.
 */
export class MediaCache {
  private pending = new Map<string, Promise<string>>()
  private values = new Map<string, string>()
  private generations = new Map<string, number>()

  constructor(private readonly limit = 24) {}

  private key(hostId: string, path: string): string {
    return `${hostId}\u0000${path}`
  }

  get(hostId: string, path: string): string | undefined {
    const key = this.key(hostId, path)
    const value = this.values.get(key)
    if (value === undefined) return undefined
    // Refresh insertion order so eviction is least-recently-used.
    this.values.delete(key)
    this.values.set(key, value)
    return value
  }

  load(hostId: string, path: string, factory: () => Promise<string>): Promise<string> {
    const key = this.key(hostId, path)
    const cached = this.get(hostId, path)
    if (cached !== undefined) return Promise.resolve(cached)
    const inFlight = this.pending.get(key)
    if (inFlight) return inFlight
    const generation = this.generations.get(hostId) ?? 0
    const request = factory()
      .then((value) => {
        if ((this.generations.get(hostId) ?? 0) !== generation) return value
        this.values.set(key, value)
        while (this.values.size > this.limit) {
          const oldest = this.values.keys().next().value
          if (oldest === undefined) break
          this.values.delete(oldest)
        }
        return value
      })
      .finally(() => this.pending.delete(key))
    this.pending.set(key, request)
    return request
  }

  clear(hostId: string): void {
    this.generations.set(hostId, (this.generations.get(hostId) ?? 0) + 1)
    const prefix = `${hostId}\u0000`
    for (const key of [...this.values.keys()]) if (key.startsWith(prefix)) this.values.delete(key)
    for (const key of [...this.pending.keys()]) if (key.startsWith(prefix)) this.pending.delete(key)
  }

  clearAll(): void {
    for (const hostId of new Set([...this.generations.keys(), ...this.values.keys(), ...this.pending.keys()].map((key) => key.split('\u0000')[0]))) {
      this.generations.set(hostId, (this.generations.get(hostId) ?? 0) + 1)
    }
    this.values.clear()
    this.pending.clear()
  }

  get cachedSize(): number { return this.values.size }
  get pendingSize(): number { return this.pending.size }
}
