/**
 * Retry pacing for a desktop that will not connect.
 *
 * A phone on a train loses its link for seconds at a time. Waiting a fixed
 * three-step ladder and then giving up for the rest of the process's life
 * means the user comes out of a tunnel to a red dot they have to tap.
 *
 * So the ladder has two stages:
 *
 * - **Fast**, right away: 1 s, 2 s, 4 s, 8 s. This covers the interruptions
 *   people actually hit — a train tunnel, a lift, a Wi-Fi handover.
 * - **Patient**, only while the user is looking at the app: one attempt every
 *   minute, indefinitely. A phone in a pocket stops retrying, so this costs no
 *   battery; a phone held in the hand recovers on its own.
 *
 * Every delay is jittered. Without that, a relay restart makes every client
 * redial on the same second and the surge keeps the relay saturated.
 * "Full jitter" (a random point in the whole window) spreads load best.
 */
import { t } from '../platform/i18n'

/** The burst stage: fast enough to cover a tunnel, still gentle on battery. */
export const FAST_DELAYS = [1_000, 2_000, 4_000, 8_000] as const

/** The patient stage: one probe a minute, foreground only. */
export const SLOW_DELAY_MS = 60_000

/** Automatic retries still offered before the UI calls them exhausted. */
export const MAX_RETRIES = FAST_DELAYS.length

export type StopReason = 'exhausted' | 'auth' | 'unknown-host'

/**
 * Whether the app is on screen. The patient stage is paced by this: a hidden
 * app does not retry at all, so leaving the phone in a pocket costs nothing.
 */
export interface RetryContext {
  /** The user is looking at the app. */
  foreground: boolean
}

/**
 * Delay before the next attempt, or null when this attempt is not due.
 *
 * A hidden app gets exactly one grace attempt. Android keeps the page running
 * for a moment after the screen turns off, and losing that first reconnect
 * makes the return-to-app path slow; beyond it, retrying is pure battery.
 * Past the burst nothing is scheduled while hidden — the return-to-foreground
 * and network listeners pick the ladder back up.
 */
export function nextDelay(attempt: number, context: RetryContext = { foreground: true }): number | null {
  if (attempt < 0) return FAST_DELAYS[0]
  if (!context.foreground) return attempt === 0 ? jitter(FAST_DELAYS[0]) : null
  if (attempt < FAST_DELAYS.length) return jitter(FAST_DELAYS[attempt])
  return jitter(SLOW_DELAY_MS)
}

/**
 * Full jitter, floored so a client cannot redial instantly.
 *
 * The AWS guidance is `random(0, cap)`. Taking a quarter as the floor keeps
 * the spread while never turning a "wait 8 s" into "wait 3 ms", which a pure
 * full-jitter draw allows and which would hammer a relay that is already down.
 */
export function jitter(delay: number, random: () => number = Math.random): number {
  const floor = delay / 4
  return Math.round(floor + random() * (delay - floor))
}

/**
 * Attempts left in the burst stage. The patient stage has no count to show,
 * so the UI says "still trying" rather than "0 left".
 */
export function retriesLeft(attempt: number): number {
  return Math.max(0, MAX_RETRIES - attempt)
}

/** Why automatic retrying stopped, in words the node list can show. */
export function stopMessage(reason: StopReason): string {
  if (reason === 'auth') return t('配对已失效，请重新添加节点')
  if (reason === 'unknown-host') return t('中继上找不到这台电脑')
  return t('已暂停自动重连')
}

/**
 * Some failures will never succeed by waiting: a rejected pairing or a relay
 * that does not know this desktop. Retrying those only wastes battery.
 *
 * Classification uses the error's code, never its message text — the text is
 * translated, so matching on it breaks the moment the interface language
 * changes.
 */
export function isPermanentFailure(code: string | undefined): StopReason | null {
  if (code === 'auth') return 'auth'
  if (code === 'unknown-host') return 'unknown-host'
  return null
}

/**
 * The session refresh cadence when a load fails or a subscription drops.
 *
 * Separate from the connection ladder: this one runs while a tunnel exists but
 * the session is not loading, which is what a weak link looks like from the
 * UI. The old fixed 1.8 s meant a phone with the session open and the desktop
 * away made hundreds of failed requests a minute.
 */
export const SESSION_DELAYS = [1_800, 3_000, 6_000, 12_000, 30_000] as const

/** Delay before the next session refresh, capped rather than stopping. */
export function sessionDelay(failures: number, random: () => number = Math.random): number {
  const index = Math.min(Math.max(failures, 0), SESSION_DELAYS.length - 1)
  return jitter(SESSION_DELAYS[index], random)
}
