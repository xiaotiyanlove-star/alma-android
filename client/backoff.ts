/**
 * Retry pacing for a desktop that will not connect.
 *
 * A dead relay or a sleeping laptop must not cost battery, so retrying is
 * bounded: three attempts, never more than 30 seconds apart, then stop.
 * Automatic retries only resume when something genuinely changed — the app
 * comes back to the foreground, the network returns, or the user asks.
 */
import { t } from './i18n'

/** Millisecond delays before attempts 1, 2 and 3. */
export const RETRY_DELAYS = [3_000, 10_000, 30_000] as const

/** Attempts after the initial try. */
export const MAX_RETRIES = RETRY_DELAYS.length

export type StopReason = 'exhausted' | 'auth' | 'unknown-host'

/**
 * Delay before the next attempt, or null when automatic retrying is over.
 * `attempt` is the number of failures so far (0 = first failure).
 */
export function nextDelay(attempt: number): number | null {
  if (attempt >= MAX_RETRIES) return null
  return RETRY_DELAYS[attempt]
}

export function retriesLeft(attempt: number): number {
  return Math.max(0, MAX_RETRIES - attempt)
}

/** Why automatic retrying stopped, in words the node list can show. */
export function stopMessage(reason: StopReason): string {
  if (reason === 'auth') return t('配对已失效，请重新添加节点')
  if (reason === 'unknown-host') return t('中继上找不到这台电脑')
  return t('已停止自动重连')
}

/**
 * Some failures will never succeed by waiting: a rejected pairing or a relay
 * that does not know this desktop. Retrying those only wastes battery.
 */
export function isPermanentFailure(message: string): StopReason | null {
  if (/配对验证失败|auth-failed|Pairing verification/i.test(message)) return 'auth'
  if (/找不到|not registered|unknown (id|token)|502/i.test(message)) return 'unknown-host'
  return null
}
