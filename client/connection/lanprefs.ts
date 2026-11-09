/**
 * The switch for local-network discovery.
 *
 * On by default: it only runs when the phone is on a small private network, and
 * the result is a large latency win. Off means the app never scans, which is
 * the right answer on a network whose operator would object to it — a
 * corporate LAN with intrusion detection, for instance.
 */
export const LAN_DISCOVERY_KEY = 'herdr.lan.discovery'

export function lanDiscoveryEnabled(): boolean {
  try { return localStorage.getItem(LAN_DISCOVERY_KEY) !== 'off' } catch { return true }
}

export function setLanDiscoveryEnabled(enabled: boolean) {
  try { localStorage.setItem(LAN_DISCOVERY_KEY, enabled ? 'on' : 'off') } catch { /* storage blocked */ }
}
