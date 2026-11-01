import { Capacitor, registerPlugin } from '@capacitor/core'
import type { Host } from './model'
import { validHosts } from './pairing'
interface Vault { load(): Promise<{ value: string | null }>; save(options: { value: string }): Promise<void> }
const vault = registerPlugin<Vault>('HerdrVault')
export interface HostStorage { persistent: boolean; load(): Promise<Host[]>; save(hosts: Host[]): Promise<void> }
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
}
