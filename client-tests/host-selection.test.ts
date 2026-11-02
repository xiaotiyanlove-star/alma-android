import { test } from 'node:test'
import assert from 'node:assert/strict'
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
