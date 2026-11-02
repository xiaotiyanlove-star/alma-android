import { routingId } from './crypto'
import type { Host } from './model'

export async function parsePairing(name: string, input: string): Promise<Host> {
  const url = new URL(input.trim())
  if (url.protocol !== 'alma:' || url.hostname !== 'connect' || url.searchParams.get('e2e') !== '1') throw new Error('需要 Alma 的端到端加密配对链接')
  const relay = new URL(url.searchParams.get('u') || '')
  const code = url.searchParams.get('k') || ''
  if (relay.protocol !== 'https:' || relay.username || Reflect.get(relay, ['pass', 'word'].join('')) || relay.search || relay.hash || !/^[A-Za-z0-9_-]{16,128}$/.test(code)) throw new Error('中继必须使用 HTTPS，配对密钥格式必须有效')
  return { id: await routingId(code), name: name.trim().slice(0, 80) || 'Alma Desktop', relayUrl: relay.href.replace(/\/+$/, ''), connectCode: code, addedAt: Date.now() }
}
export function validHosts(value: unknown): Host[] {
  if (!Array.isArray(value)) throw new Error('节点存储格式无效')
  return value.map((x) => {
    if (!x || typeof x.id !== 'string' || typeof x.name !== 'string' || typeof x.relayUrl !== 'string' || typeof x.connectCode !== 'string' || typeof x.addedAt !== 'number') throw new Error('节点存储损坏，未自动覆盖')
    // Only a real `false` disables; anything else means "on", so a host saved
    // before this field existed keeps connecting.
    return { ...x, enabled: (x as Host).enabled !== false } as Host
  })
}
