import { test } from 'node:test'
import assert from 'node:assert/strict'
import './locale.ts'
import { Controller } from '../client/controller.ts'
import type { Host } from '../client/model.ts'
import type { HostStorage } from '../client/storage.ts'
import type { Transport } from '../client/transport.ts'

/**
 * The REST verb belongs to the route, not to "has a body".
 *
 * The tunnel's default is POST because most Alma mutations are RPC-ish. Two
 * routes are REST-shaped, and sending one of those a POST reaches Express's 404:
 * the tunnel is healthy, the payload is valid, and the desktop still refuses.
 * Muting a session looked exactly like a broken button because of it.
 */

const host: Host = { id: 'A', name: 'A', relayUrl: 'https://a.invalid', connectCode: 'A'.repeat(43), addedAt: 0 }

interface Seen { method?: string; path: string; body?: unknown }

function fake() {
  const seen: Seen[] = []
  const transport: Transport = {
    async connect() {},
    async request<T>(path: string, body?: unknown, init?: { method?: string }): Promise<T> {
      seen.push({ method: init?.method, path, body })
      if (path === '/api/herdr/info') return { online: true } as T
      if (path === '/api/herdr/mutes') return { tabs: ['t1'], workspaces: [] } as T
      return {} as T
    },
    subscribe() { return { close() {} } },
    lastInboundAt() { return Date.now() },
    close() {},
  }
  const storage: HostStorage = { persistent: true, async load() { return [host] }, async save() {} }
  return { controller: new Controller(storage, () => transport), seen }
}

test('muting is a PUT, because that is how Alma mounts the route', async () => {
  const { controller, seen } = fake()
  try {
    await controller.initialize()
    await new Promise((resolve) => setTimeout(resolve, 30))
    await controller.setMuted('A', { tab: 't1' }, true)
    const mute = seen.find((entry) => entry.path === '/api/herdr/mutes' && entry.body !== undefined)
    assert.ok(mute, 'the mutation was sent')
    assert.equal(mute.method, 'PUT', 'POST reaches a 404 on this route')
    assert.deepEqual(mute.body, { tab: 't1', muted: true })
  } finally { controller.dispose() }
})

test('reading the mute list has no body and needs no method', async () => {
  const { controller, seen } = fake()
  try {
    await controller.initialize()
    await new Promise((resolve) => setTimeout(resolve, 30))
    await controller.refreshMutes('A')
    const read = seen.find((entry) => entry.path === '/api/herdr/mutes' && entry.body === undefined)
    assert.ok(read, 'the list was read')
    assert.equal(read.method, undefined, 'a read is a GET by construction')
  } finally { controller.dispose() }
})
