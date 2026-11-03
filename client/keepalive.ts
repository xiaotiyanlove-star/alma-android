import { Capacitor, registerPlugin } from '@capacitor/core'

interface KeepAlive { start(): Promise<void>; stop(): Promise<void>; isRunning(): Promise<{ running: boolean }> }
const plugin = registerPlugin<KeepAlive>('KeepAlive')

export const KEEPALIVE_KEY = 'herdr.keepalive'

/**
 * When the foreground service runs.
 *
 * - `reply`: only while an agent is actually working, then it stops itself.
 *   This is the default, and what the official client does: the service exists
 *   to survive the minutes between "I sent something" and "it finished", not to
 *   keep a socket open all day. Android shows nothing permanent for it.
 * - `always`: the previous behaviour — a persistent status-bar entry and an
 *   unrestricted network for as long as the app is installed. Useful for
 *   someone who wants notifications even after hours in the background, at the
 *   cost of a permanent notification and Android 15's six-hour dataSync cap.
 * - `off`: never; notifications only while the app is open.
 */
export type KeepAliveMode = 'reply' | 'always' | 'off'

export function keepAliveMode(): KeepAliveMode {
  try {
    const value = localStorage.getItem(KEEPALIVE_KEY)
    if (value === 'off') return 'off'
    if (value === 'on') return 'always'
    if (value === 'reply') return 'reply'
  } catch { /* storage blocked */ }
  // Nothing stored: the quiet, self-limiting mode is what a new install wants.
  return 'reply'
}

export function setKeepAliveMode(mode: KeepAliveMode) {
  try { localStorage.setItem(KEEPALIVE_KEY, mode === 'always' ? 'on' : mode) } catch { /* storage blocked */ }
}

/** Whether a reply is in progress, which is what `reply` mode keys on. */
export function replyInProgress(hosts: Array<{ host?: { enabled?: boolean }; status?: string; snapshot?: { panes: Array<{ agent_status?: string }> } }>): boolean {
  return hosts.some((host) => host.host?.enabled !== false
    // Only a live connection can finish the work: the last snapshot survives a
    // disconnect, so reading `working` from it kept the service (and its
    // permanent notification) running until Android's six-hour cap after the
    // desktop had already gone away.
    && host.status === 'online'
    && (host.snapshot?.panes ?? []).some((pane) => pane.agent_status === 'working'))
}

/**
 * Reconciles the service with both the saved mode and whether work is running.
 *
 * Called on launch, on every snapshot change, and when the app comes back to
 * the foreground — the three moments the answer can change.
 */
export async function applyKeepAlive(mode = keepAliveMode(), working = false): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  const running = mode === 'always' || (mode === 'reply' && working)
  try {
    if (running) await plugin.start()
    else await plugin.stop()
  } catch { /* Notification permission denied or the OS refused the service. */ }
}
