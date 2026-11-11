import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IDBFactory } from 'fake-indexeddb'
import { LocalRepository } from '../src/storage/local'
import type { CanvasFile } from '../src/types'

test('client persists offline edits, merges after reconnect, retries races and preserves conflicting versions', async () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() })
  const originalFetch = globalThis.fetch
  let connected = true, race = false
  const remote = new Map<string, { id: string; revision: number; doc: CanvasFile | null }>()
  globalThis.fetch = async (input, init) => {
    if (!connected) throw new TypeError('network disconnected')
    const path = new URL(String(input)).pathname.replace('/api/', '')
    if (path === 'login') return Response.json({ token: 'a'.repeat(64), vaultId: 'vault', username: 'owner' })
    if (path === 'session') return Response.json({ vaultId: 'vault' })
    if (path === 'boards') return Response.json({ boards: [...remote.values()].map(({ id, revision }) => ({ id, revision })) })
    const id = decodeURIComponent(path.slice('boards/'.length))
    const current = remote.get(id) ?? { id, revision: 0, doc: null }
    if (init?.method !== 'PUT') return Response.json(current)
    const body = JSON.parse(init.body as string)
    if (race) {
      race = false
      current.revision++
      current.doc = { ...current.doc, meta: { name: 'racing server edit' } }
      remote.set(id, current)
    }
    if (body.baseRevision !== current.revision) return Response.json({ current, error: 'conflict' }, { status: 409 })
    const result = { id, revision: current.revision + 1, doc: body.doc }
    remote.set(id, result)
    return Response.json(result)
  }
  const cloud = await import('../src/sync/cloud')
  const repo = new LocalRepository()
  const original: CanvasFile = { nodes: [{ id: 'a', type: 'text', text: 'original', x: 10, y: 20, width: 100, height: 50 }], edges: [], meta: { name: 'original' } }
  await repo.save('board', original)
  const stop = cloud.startCloudSync(repo, () => true, async (action) => { await action(); return true })
  try {
    await cloud.loginCloud('https://see.example', 'owner', 'test password')
    await cloud.syncNow()
    assert.equal(remote.get('board')!.revision, 1)
    assert.equal(cloud.cloudStore.getSnapshot().state, 'synced')
    connected = false
    const offline = structuredClone(original)
    offline.nodes![0].x = 80
    await repo.save('board', offline)
    await cloud.syncNow()
    assert.equal(cloud.cloudStore.getSnapshot().state, 'offline')
    assert.equal((await new LocalRepository().load('board'))!.nodes![0].x, 80)
    remote.set('board', { id: 'board', revision: 2, doc: { ...original, meta: { name: 'renamed remotely' } } })
    connected = true
    await cloud.syncNow()
    assert.equal(remote.get('board')!.doc!.nodes![0].x, 80)
    assert.equal((await repo.load('board'))!.meta!.name, 'renamed remotely')
    connected = false
    const competing = (await repo.load('board'))!
    competing.meta = { name: 'offline name' }
    await repo.save('board', competing)
    remote.set('board', { id: 'board', revision: 4, doc: { ...remote.get('board')!.doc!, meta: { name: 'other device name' } } })
    connected = true
    await cloud.syncNow()
    await cloud.syncNow()
    assert.ok([...remote.values()].some((board) => board.doc?.meta?.name === 'offline name（冲突副本）'))
    assert.equal((await repo.load('board'))!.meta!.name, 'other device name')
    const after = (await repo.load('board'))!
    after.nodes![0].color = '3'
    await repo.save('board', after)
    race = true
    await cloud.syncNow()
    await cloud.syncNow()
    assert.equal(remote.get('board')!.doc!.nodes![0].color, '3')
    assert.equal((await repo.load('board'))!.meta!.name, 'racing server edit')
    assert.equal(cloud.cloudStore.getSnapshot().state, 'synced')
  } finally { stop(); globalThis.fetch = originalFetch }
})
