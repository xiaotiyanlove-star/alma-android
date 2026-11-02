import { Capacitor, registerPlugin } from '@capacitor/core'

interface KeepAlive { start(): Promise<void>; stop(): Promise<void>; isRunning(): Promise<{ running: boolean }> }
const plugin = registerPlugin<KeepAlive>('KeepAlive')

export const KEEPALIVE_KEY = 'herdr.keepalive'

export function keepAliveEnabled(): boolean {
  try { return localStorage.getItem(KEEPALIVE_KEY) === 'on' } catch { return false }
}

export function setKeepAliveEnabled(enabled: boolean) {
  try { localStorage.setItem(KEEPALIVE_KEY, enabled ? 'on' : 'off') } catch { /* storage blocked */ }
}

/** Start or stop the foreground service to match the saved preference. */
export async function applyKeepAlive(enabled = keepAliveEnabled()): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  try {
    if (enabled) await plugin.start()
    else await plugin.stop()
  } catch { /* Notification permission denied or the OS refused the service. */ }
}
