import { Capacitor } from '@capacitor/core'
import type { HostState, Pane, Snapshot } from './model'

export type AlertKind = 'blocked' | 'done' | 'offline'
export interface Alert {
  hostId: string
  hostName: string
  paneId: string
  title: string
  body: string
  kind: AlertKind
}

/** Statuses worth waking a phone for: the agent needs input, or it just finished. */
const LOUD: Record<string, AlertKind | undefined> = { blocked: 'blocked', done: 'done' }

export interface Notifier {
  notify(alert: Alert): Promise<void>
  permission(): Promise<'granted' | 'denied' | 'prompt'>
  request(): Promise<'granted' | 'denied' | 'prompt'>
}

const KIND_LABEL: Record<AlertKind, string> = { blocked: '需要你处理', done: '已完成', offline: '节点离线' }

/**
 * Pure state diff. Kept free of Capacitor so it can be unit-tested in node.
 * A pane must be seen once before it can alert, so opening the app after the
 * fact does not replay old transitions.
 */
export class AlertTracker {
  private seen = new Map<string, { status: string; snapshotReady: boolean }>()
  constructor(private mutedHosts: ReadonlySet<string> = new Set()) {}

  update(hosts: HostState[]): Alert[] {
    const alerts: Alert[] = []
    const live = new Set<string>()
    for (const host of hosts) {
      const snapshot = host.snapshot
      for (const pane of snapshot?.panes ?? []) {
        const key = `${host.host.id}:${pane.pane_id}`
        live.add(key)
        const next = pane.agent_status ?? ''
        const previous = this.seen.get(key)
        this.seen.set(key, { status: next, snapshotReady: true })
        if (!previous?.snapshotReady) continue
        if (previous.status === next) continue
        if (this.mutedHosts.has(host.host.id)) continue
        // Only real transitions into a loud state, never a snapshot that starts there.
        const kind = LOUD[next]
        if (!kind) continue
        alerts.push(buildAlert(host, pane, kind))
      }
    }
    for (const key of [...this.seen.keys()]) if (!live.has(key)) this.seen.delete(key)
    return alerts
  }

  reset() { this.seen.clear() }
}

function buildAlert(host: HostState, pane: Pane, kind: AlertKind): Alert {
  const name = pane.terminal_title_stripped?.trim() || pane.cwd?.split('/').filter(Boolean).pop() || pane.agent || '终端'
  return {
    hostId: host.host.id,
    hostName: host.host.name,
    paneId: pane.pane_id,
    title: `${KIND_LABEL[kind]} · ${name}`,
    body: host.host.name,
    kind,
  }
}

/** Statuses a pane can reach that a user cares about; exported for tests. */
export function statusesThatAlert(snapshot: Snapshot | undefined): string[] {
  return (snapshot?.panes ?? []).map((pane) => pane.agent_status ?? '').filter(Boolean)
}

export const localNotifier: Notifier = {
  async permission() {
    if (!Capacitor.isNativePlatform()) return 'denied'
    const { LocalNotifications } = await import('@capacitor/local-notifications')
    return (await LocalNotifications.checkPermissions()).display as 'granted' | 'denied' | 'prompt'
  },
  async request() {
    if (!Capacitor.isNativePlatform()) return 'denied'
    const { LocalNotifications } = await import('@capacitor/local-notifications')
    return (await LocalNotifications.requestPermissions()).display as 'granted' | 'denied' | 'prompt'
  },
  async notify(alert) {
    if (!Capacitor.isNativePlatform()) return
    const { LocalNotifications } = await import('@capacitor/local-notifications')
    // Stable id per pane so repeated alerts replace instead of stacking.
    const id = hashId(`${alert.hostId}:${alert.paneId}:${alert.kind}`)
    await LocalNotifications.schedule({
      notifications: [{
        id,
        title: alert.title,
        body: alert.body,
        channelId: 'herdr-alerts',
        smallIcon: 'ic_stat_herdr',
        extra: { hostId: alert.hostId, paneId: alert.paneId },
      }],
    })
  },
}

function hashId(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) | 0
  return Math.abs(hash) % 2_000_000_000 + 1
}
