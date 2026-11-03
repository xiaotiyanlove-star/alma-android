/**
 * Network changes, from the OS rather than the page.
 *
 * `window` fires `online`/`offline` for the HTTP stack, which is close enough
 * on a laptop and not close enough on a phone: a Wi-Fi to cellular handover can
 * leave the old socket half-open without either event firing, and the page
 * cannot see the interface type at all — Chrome removed
 * `navigator.connection.type`, so the only place that knows is
 * `ConnectivityManager`.
 *
 * This wraps the Capacitor plugin, and degrades to the browser events when it
 * is unavailable (the web preview, or a build without the plugin).
 */
import { Capacitor, registerPlugin } from '@capacitor/core'

export type LinkKind = 'wifi' | 'cellular' | 'ethernet' | 'none' | 'other' | 'unknown'

interface NetworkStatus { connected: boolean; connectionType?: string }
interface NetworkPlugin {
  getStatus(): Promise<NetworkStatus>
  addListener(event: 'networkStatusChange', listener: (status: NetworkStatus) => void): Promise<{ remove(): Promise<void> }>
}
const plugin = registerPlugin<NetworkPlugin>('Network')

/** Normalises the plugin's free-form type into the handful that matter here. */
export function linkKind(connectionType: string | undefined): LinkKind {
  const type = (connectionType ?? '').toLowerCase()
  if (type === 'wifi') return 'wifi'
  if (type === 'cellular') return 'cellular'
  if (type === 'ethernet') return 'ethernet'
  if (type === 'none') return 'none'
  if (!type || type === 'unknown') return 'unknown'
  return 'other'
}

/**
 * Whether a status change means "the path to the desktop may have moved".
 *
 * Coming back online obviously does. So does a change of link type while still
 * connected: cellular to Wi-Fi keeps the app online but invalidates every open
 * socket, and nothing else in the app would notice.
 */
export function shouldRedial(previous: NetworkStatus | undefined, next: NetworkStatus): boolean {
  if (!next.connected) return false
  if (!previous) return true
  if (!previous.connected) return true
  return linkKind(previous.connectionType) !== linkKind(next.connectionType)
}

export interface NetworkWatcher { stop(): void }

/**
 * Calls `onChange` when the path may have changed, and never for a transition
 * into no network: there is nothing to redial then, and the reconnect would
 * only burn battery failing.
 */
export async function watchNetwork(onChange: () => void): Promise<NetworkWatcher> {
  let previous: NetworkStatus | undefined
  const cleanups: (() => void)[] = []
  let stopped = false

  if (Capacitor.isNativePlatform()) {
    try {
      const initial = await plugin.getStatus()
      if (stopped) return { stop() {} }
      previous = initial
      const handle = await plugin.addListener('networkStatusChange', (status) => {
        if (stopped) return
        const redial = shouldRedial(previous, status)
        previous = status
        if (redial) onChange()
      })
      cleanups.push(() => { void handle.remove().catch(() => undefined) })
    } catch { /* fall through to the browser events */ }
  }

  if (!cleanups.length) {
    // Browser fallback: only tells us about the HTTP stack, but better than
    // nothing, and the liveness probe covers the cases it misses.
    const onOnline = () => onChange()
    window.addEventListener('online', onOnline)
    cleanups.push(() => window.removeEventListener('online', onOnline))
  }

  return {
    stop() {
      stopped = true
      for (const cleanup of cleanups) cleanup()
    },
  }
}
