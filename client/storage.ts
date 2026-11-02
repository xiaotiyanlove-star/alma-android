import { Capacitor, registerPlugin } from '@capacitor/core'
import type { Host } from './model'
import { validHosts } from './pairing'
interface Vault { load(): Promise<{ value: string | null }>; save(options: { value: string }): Promise<void> }
const vault = registerPlugin<Vault>('HerdrVault')
export interface HostStorage { persistent: boolean; load(): Promise<Host[]>; save(hosts: Host[]): Promise<void>; loadSelection?(): Promise<string | null>; saveSelection?(id: string): Promise<void> }
const SELECTION_KEY = 'herdr.lastHost'
let browserHosts: Host[] = []
export const hostStorage: HostStorage = {
  persistent: Capacitor.isNativePlatform(),
  async load() {
    if (!this.persistent) return browserHosts
    const { value } = await vault.load()
    return value ? validHosts(JSON.parse(value)) : []
  },
  async save(hosts) {
    if (this.persistent) await vault.save({ value: JSON.stringify(hosts) })
    else browserHosts = hosts
  },
  // The last desktop is UI state, not a credential: plain storage is enough.
  async loadSelection() {
    try { return localStorage.getItem(SELECTION_KEY) } catch { return null }
  },
  async saveSelection(id: string) {
    try { localStorage.setItem(SELECTION_KEY, id) } catch { /* storage blocked */ }
  },
}
