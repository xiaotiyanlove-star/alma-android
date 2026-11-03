/**
 * Local measurements for the weak-network work.
 *
 * Deliberately two numbers, both about behaviour the user can feel:
 *
 * - `stale_detect_ms`: how long a dead link stays undetected. If this is large,
 *   the app shows "connected" while nothing works.
 * - `retries_5min`: attempts made while a desktop is unreachable. If this is
 *   large, the phone is burning battery in someone's pocket.
 *
 * Kept in memory and on the device only. Nothing here is uploaded, and there is
 * no network path in this file at all.
 */

export interface MetricSample {
  staleDetectMs?: number
  retryBurst?: number
}

const MAX_SAMPLES = 50

export class Metrics {
  private samples: MetricSample[] = []
  /** When the current run of "screens should show a problem" began. */
  private unhealthySince?: number
  private retryWindowStart?: number
  private retryCount = 0

  /**
   * Marks the moment the UI should start looking wrong.
   *
   * Called when a send is issued and no acknowledgement arrives, which is the
   * earliest honest signal that the link may be dead.
   */
  markUnhealthy(now = Date.now()) {
    if (this.unhealthySince === undefined) this.unhealthySince = now
  }

  /** Records how long the UI stayed unaware, and clears the run. */
  markHealthy(now = Date.now()) {
    if (this.unhealthySince !== undefined) {
      this.record({ staleDetectMs: Math.max(0, now - this.unhealthySince) })
      this.unhealthySince = undefined
    }
  }

  /** Counts one reconnect attempt, closing a five-minute window when it ends. */
  countRetry(now = Date.now()) {
    if (this.retryWindowStart === undefined) this.retryWindowStart = now
    this.retryCount++
    if (now - this.retryWindowStart >= 5 * 60_000) {
      this.record({ retryBurst: this.retryCount })
      this.retryWindowStart = now
      this.retryCount = 0
    }
  }

  record(sample: MetricSample) {
    this.samples.push(sample)
    if (this.samples.length > MAX_SAMPLES) this.samples.shift()
  }

  snapshot(): MetricSample[] { return [...this.samples] }

  /** Median, which is the number to look at: averages hide the bad tail. */
  static median(values: number[]): number | undefined {
    if (!values.length) return undefined
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
  }

  summary() {
    const stale = this.samples.map((s) => s.staleDetectMs).filter((n): n is number => typeof n === 'number')
    const bursts = this.samples.map((s) => s.retryBurst).filter((n): n is number => typeof n === 'number')
    return {
      staleDetectMs: Metrics.median(stale),
      staleSamples: stale.length,
      retryBurstMax: bursts.length ? Math.max(...bursts) : undefined,
      retrySamples: bursts.length,
    }
  }

  reset() { this.samples = []; this.unhealthySince = undefined; this.retryWindowStart = undefined; this.retryCount = 0 }
}

export const metrics = new Metrics()
