import { Capacitor } from '@capacitor/core'
import { t } from './i18n'
import type { HostState, Pane } from './model'

export type AlertKind = 'blocked' | 'done' | 'offline'
export interface Alert {
  hostId: string
  hostName: string
  paneId: string
  /** The tab and workspace, so an action can reach the desktop's own mutes. */
  tabId?: string
  workspaceId?: string
  title: string
  body: string
  kind: AlertKind
  /** SHA-256 of the approval menu shown when the alert was created. */
  promptFingerprint?: string
  /** The screen at the moment the transition was seen, for drift evidence. */
  screen?: string
}

/**
 * Notification buttons.
 *
 * A `blocked` alert gets Allow/Deny; a `done` alert gets an inline reply field.
 * Both are wired to the same drift-checked path the in-app prompt uses, so a
 * button on a stale notification is refused rather than pressing whatever the
 * terminal shows by then.
 */
export type AlertAction = 'allow' | 'deny' | 'reply' | 'open'

/** Statuses worth waking a phone for: the agent needs input, or it just finished. */
const LOUD: Record<string, AlertKind | undefined> = { blocked: 'blocked', done: 'done' }

export interface Notifier {
  notify(alert: Alert): Promise<void>
  permission(): Promise<'granted' | 'denied' | 'prompt'>
  request(): Promise<'granted' | 'denied' | 'prompt'>
}

/** Action type ids, registered once at launch. */
export const ACTION_BLOCKED = 'herdr.blocked'
export const ACTION_DONE = 'herdr.done'

/**
 * The notification title's prefix.
 *
 * Resolved through `t` at build time rather than stored as a literal: Android
 * keeps the notification after it is posted, so the title has to be written in
 * the language the user is reading now, and the alert is built at that moment.
 */
const KIND_LABEL: Record<AlertKind, string> = { blocked: t('需要你处理'), done: t('已完成'), offline: t('节点离线') }

/**
 * Pure state diff. Kept free of Capacitor so it can be unit-tested in node.
 *
 * A pane must be seen once before it can alert, so opening the app after the
 * fact does not replay old transitions. Muting is checked here rather than at
 * the notifier: a silenced session must not even produce an alert, otherwise
 * the same pane would keep waking the device through a path the UI already
 * considers quiet.
 */
export class AlertTracker {
  private seen = new Map<string, { status: string; snapshotReady: boolean }>()

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
        // The desktop's mute list is authoritative: silence applies to both the
        // in-app badge and this diff, because it is a statement about the work.
        if (mutedOn(host, pane)) continue
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

/** Whether a pane's tab or its workspace is silenced on that desktop. */
export function mutedOn(host: HostState, pane: { tab_id?: string; workspace_id?: string }): boolean {
  const mutes = host.mutes
  if (!mutes) return false
  return Boolean(pane.tab_id && mutes.tabs.includes(pane.tab_id))
    || Boolean(pane.workspace_id && mutes.workspaces.includes(pane.workspace_id))
}

function buildAlert(host: HostState, pane: Pane, kind: AlertKind): Alert {
  const name = pane.terminal_title_stripped?.trim() || pane.cwd?.split('/').filter(Boolean).pop() || pane.agent || '终端'
  return {
    hostId: host.host.id,
    hostName: host.host.name,
    paneId: pane.pane_id,
    tabId: pane.tab_id,
    workspaceId: pane.workspace_id,
    title: `${KIND_LABEL[kind]} · ${name}`,
    body: host.host.name,
    kind,
  }
}

/**
 * What a tapped notification action means.
 *
 * `open` is the body tap and every action whose id is not one of ours; a
 * notification from an older build has no actions at all, so it must still
 * open the session rather than do nothing.
 */
export function actionFor(
  alert: Pick<Alert, 'kind'>,
  actionId?: string,
  input?: string,
): { kind: AlertAction; text?: string } {
  if (actionId === 'allow' && alert.kind === 'blocked') return { kind: 'allow' }
  if (actionId === 'deny' && alert.kind === 'blocked') return { kind: 'deny' }
  if (actionId === 'reply' && alert.kind === 'done') return { kind: 'reply', text: (input ?? '').trim() }
  return { kind: 'open' }
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
        // Without a registered action type Android shows no buttons at all;
        // the id is what the tap handler reads back.
        ...(alert.kind === 'blocked' ? { actionTypeId: ACTION_BLOCKED } : {}),
        ...(alert.kind === 'done' ? { actionTypeId: ACTION_DONE } : {}),
        extra: {
          hostId: alert.hostId,
          paneId: alert.paneId,
          kind: alert.kind,
          ...(alert.tabId ? { tabId: alert.tabId } : {}),
          ...(alert.workspaceId ? { workspaceId: alert.workspaceId } : {}),
          ...(alert.promptFingerprint ? { promptFingerprint: alert.promptFingerprint } : {}),
        },
      }],
    })
  },
}

/**
 * Registers the notification buttons once per launch.
 *
 * `reply` is an inline text field: Capacitor's Android implementation maps it
 * to a `RemoteInput`, so the answer is typed in the shade and arrives with the
 * action instead of opening the app.
 */
export async function registerAlertActions(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications')
    await LocalNotifications.registerActionTypes({
      types: [
        {
          id: ACTION_BLOCKED,
          actions: [
            { id: 'allow', title: t('允许') },
            { id: 'deny', title: t('拒绝'), destructive: true },
          ],
        },
        {
          id: ACTION_DONE,
          actions: [{ id: 'reply', title: t('回复'), input: true }],
        },
      ],
    })
  } catch { /* An older shell simply shows no buttons. */ }
}

function hashId(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) | 0
  return Math.abs(hash) % 2_000_000_000 + 1
}
