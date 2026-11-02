import { test } from 'node:test'
import assert from 'node:assert/strict'
import './locale.ts'
import { Controller } from '../client/controller.ts'
import type { Host } from '../client/model.ts'
import type { HostStorage } from '../client/storage.ts'
import type { Transport } from '../client/transport.ts'

const host = (id: string): Host => ({ id, name: id, relayUrl: `https://${id}.invalid`, connectCode: id.repeat(43), addedAt: 0 })
const A = host('A'), B = host('B'), C = host('C')

class Fake implements Transport {
  async connect() {}
  async request<T>(): Promise<T> { return { online: true, result: {} } as T }
  subscribe() { return { close() {} } }
  close() {}
}
const wait = () => new Promise((resolve) => setTimeout(resolve, 2))

function makeStorage(hosts: Host[], remembered: string | null) {
  const saved: string[] = []
  const storage: HostStorage = {
    persistent: true,
    async load() { return hosts },
    async save() {},
    async loadSelection() { return remembered },
    async saveSelection(id) { saved.push(id) },
  }
  return { storage, saved }
}

test('a single pairing is selected automatically', async () => {
  const { storage } = makeStorage([A], null)
  const controller = new Controller(storage, () => new Fake())
  try {
    await controller.initialize(); await wait()
    assert.equal(controller.getState().selectedHostId, 'A')
  } finally { controller.dispose() }
})

test('several pairings without a remembered choice stay unselected', async () => {
  const { storage } = makeStorage([A, B, C], null)
  const controller = new Controller(storage, () => new Fake())
  try {
    await controller.initialize(); await wait()
    assert.equal(controller.getState().selectedHostId, undefined, 'must not silently pick the first')
  } finally { controller.dispose() }
})

test('the last used desktop is restored on next launch', async () => {
  const { storage } = makeStorage([A, B, C], 'B')
  const controller = new Controller(storage, () => new Fake())
  try {
    await controller.initialize(); await wait()
    assert.equal(controller.getState().selectedHostId, 'B')
  } finally { controller.dispose() }
})

test('a remembered id that no longer exists falls back to no selection', async () => {
  const { storage } = makeStorage([A, B], 'gone')
  const controller = new Controller(storage, () => new Fake())
  try {
    await controller.initialize(); await wait()
    assert.equal(controller.getState().selectedHostId, undefined)
  } finally { controller.dispose() }
})

test('choosing a desktop is remembered', async () => {
  const { storage, saved } = makeStorage([A, B], null)
  const controller = new Controller(storage, () => new Fake())
  try {
    await controller.initialize(); await wait()
    controller.selectHost('B'); await wait()
    assert.deepEqual(saved, ['B'])
    assert.equal(controller.getState().selectedHostId, 'B')
  } finally { controller.dispose() }
})

test('renaming keeps the credential and connection intact', async () => {
  const { storage } = makeStorage([A, B], null)
  let persisted: Host[] = []
  storage.save = async (hosts) => { persisted = hosts }
  const controller = new Controller(storage, () => new Fake())
  try {
    await controller.initialize(); await wait()
    await controller.renameHost('A', '  新名字  ')
    const renamed = controller.getState().hosts.find((item) => item.host.id === 'A')!.host
    assert.equal(renamed.name, '新名字', 'trimmed')
    assert.equal(renamed.connectCode, A.connectCode, 'credential untouched')
    assert.equal(renamed.relayUrl, A.relayUrl)
    assert.equal(persisted.find((host) => host.id === 'A')!.name, '新名字', 'written to storage')
    assert.equal(controller.getState().hosts.find((item) => item.host.id === 'B')!.host.name, 'B', 'others untouched')
  } finally { controller.dispose() }
})

test('renaming rejects an empty or unknown target', async () => {
  const { storage } = makeStorage([A], null)
  const controller = new Controller(storage, () => new Fake())
  try {
    await controller.initialize(); await wait()
    await assert.rejects(controller.renameHost('A', '   '), /名称不能为空/)
    await assert.rejects(controller.renameHost('missing', 'x'), /节点不存在/)
    assert.equal(controller.getState().hosts[0].host.name, 'A')
  } finally { controller.dispose() }
})

test('a rename does not disturb the session in progress', async () => {
  const { storage } = makeStorage([A], null)
  const controller = new Controller(storage, () => new Fake())
  try {
    await controller.initialize(); await wait()
    controller.selectHost('A'); await controller.selectPane('w1:p1')
    await controller.renameHost('A', 'renamed')
    assert.equal(controller.getState().session?.hostId, 'A')
    assert.equal(controller.getState().selectedPaneId, 'w1:p1')
  } finally { controller.dispose() }
})

// ── the per-desktop switch ──────────────────────────────────────────────
class Counting implements Transport {
  connects = 0
  closed = false
  private stop = false
  async connect() { if (this.stop) throw new Error('closed'); this.connects++ }
  async request<T>(path: string): Promise<T> { return (path === '/api/herdr/info' ? { online: true } : { result: {} }) as T }
  subscribe() { return { close() {} } }
  close() { this.stop = true; this.closed = true }
}

function switched() {
  const made: Counting[] = []
  let saved: Host[] = [{ ...A }]
  const storage: HostStorage = { persistent: true, async load() { return saved }, async save(hosts) { saved = hosts } }
  const controller = new Controller(storage, () => { const transport = new Counting(); made.push(transport); return transport as any })
  return { controller, made, saved: () => saved }
}

test('a desktop switched off is loaded without dialling it', async () => {
  const made: Counting[] = []
  const storage: HostStorage = { persistent: true, async load() { return [{ ...A, enabled: false }] }, async save() {} }
  const controller = new Controller(storage, () => { const transport = new Counting(); made.push(transport); return transport as any })
  try {
    await controller.initialize(); await wait()
    assert.equal(made.length, 0, 'no connection is attempted')
    assert.equal(controller.getState().hosts[0].status, 'disabled')
  } finally { controller.dispose() }
})

test('switching one off releases its tunnel and stops retries, and on dials again', async () => {
  const { controller, made, saved } = switched()
  try {
    await controller.initialize(); await wait()
    assert.equal(made[0].connects, 1)

    await controller.setHostEnabled('A', false)
    assert.equal(made[0].closed, true, 'the socket is released')
    assert.equal(controller.getState().hosts[0].status, 'disabled')
    assert.equal(saved()[0].enabled, false, 'the choice is stored')

    await controller.setHostEnabled('A', true)
    await wait()
    assert.equal(made.length, 2, 'a fresh transport on the way back')
    assert.equal(controller.getState().hosts[0].status, 'online')
    assert.equal(saved()[0].enabled, true)
  } finally { controller.dispose() }
})

test('resuming the app leaves switched-off desktops alone', async () => {
  const { controller, made } = switched()
  try {
    await controller.initialize(); await wait()
    await controller.setHostEnabled('A', false)
    controller.resume(true)
    await wait()
    assert.equal(made.length, 1, 'the disabled desktop was not rebuilt')
    assert.equal(controller.getState().hosts[0].status, 'disabled')
  } finally { controller.dispose() }
})

test('pairing again updates the credential but keeps the switch off', async () => {
  // The id comes from the link, so the same link must pair onto the same row.
  const link = `alma://connect?u=https://again.invalid&k=${'G'.repeat(43)}&e2e=1`
  const made: Counting[] = []
  const controller = new Controller({ persistent: true, async load() { return [] }, async save() {} }, () => {
    const transport = new Counting(); made.push(transport); return transport as any
  })
  try {
    await controller.initialize(); await wait()
    await controller.addHost('again', link)
    await wait()
    const id = controller.getState().hosts[0].host.id
    await controller.setHostEnabled(id, false)
    const connections = made.length

    await controller.addHost('again renamed', link)
    await wait()
    assert.equal(controller.getState().hosts.length, 1, 'it is the same desktop, not a second one')
    assert.equal(controller.getState().hosts[0].host.enabled, false)
    assert.equal(controller.getState().hosts[0].host.name, 'again renamed')
    assert.equal(made.length, connections, 'still not dialled')
  } finally { controller.dispose() }
})
