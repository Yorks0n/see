import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IDBFactory } from 'fake-indexeddb'
import { LocalRepository, StorageConflictError } from '../src/storage/local'
import { startLocalSync } from '../src/sync/local'
import type { CanvasFile } from '../src/types'

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check()) {
    assert.ok(Date.now() < deadline, 'expected the other window to update automatically')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('windows read committed changes, defer while editing, catch up on focus and do not echo reads', async () => {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: Object.assign(new EventTarget(), { visibilityState: 'visible' }) })
  const a = new LocalRepository(), b = new LocalRepository()
  const original: CanvasFile = { nodes: [], edges: [], meta: { name: 'original' } }
  await a.save('board', original)
  let seen: CanvasFile | null = null, blocked = false, reads = 0
  const errors: unknown[] = []
  const stopA = startLocalSync(a, async () => true, (error) => errors.push(error))
  const stopB = startLocalSync(b, async () => {
    if (blocked) return false
    seen = await b.load('board'); reads++
    return true
  }, (error) => errors.push(error))
  try {
    await until(() => seen?.meta?.name === 'original')
    await a.save('board', { ...original, meta: { name: 'from another window' } })
    await until(() => seen?.meta?.name === 'from another window')
    // A read must advance this window's storage revision so its next edit can save.
    await b.save('board', { ...original, meta: { name: 'edited in receiver' } })
    await a.load('board')
    blocked = true
    await a.save('board', { ...original, meta: { name: 'wait for local editing' } })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(seen?.meta?.name, 'from another window')
    blocked = false
    await until(() => seen?.meta?.name === 'wait for local editing')
    const count = reads
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(reads, count, 'reading IndexedDB must not create a broadcast loop')
    stopA()
    await a.save('board', { ...original, meta: { name: 'missed notification' } })
    window.dispatchEvent(new Event('focus'))
    await until(() => seen?.meta?.name === 'missed notification')
    const entries = await a.syncEntries('vault'), entry = entries.find((value) => value.id === 'board')!
    const stopRemote = startLocalSync(a, async () => true, (error) => errors.push(error))
    try {
      await a.acceptRemote('vault', 'board', entry.revision, { revision: 10, doc: { ...original, meta: { name: 'from server' } } })
      await until(() => seen?.meta?.name === 'from server')
      await a.load('board')
      await a.delete('board')
      await until(() => seen === null)
    } finally { stopRemote() }
    assert.deepEqual(errors, [])
  } finally { stopA(); stopB() }
})

test('failed writes do not notify other windows', async () => {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() })
  const a = new LocalRepository(), b = new LocalRepository()
  const doc: CanvasFile = { nodes: [], edges: [], meta: { name: 'original' } }
  await a.save('board', doc)
  await b.load('board')
  await a.save('board', { ...doc, meta: { name: 'new version' } })
  let notifications = 0
  const stop = b.subscribeWrites(() => notifications++)
  try {
    await assert.rejects(b.save('board', doc), StorageConflictError)
    await assert.rejects(b.acceptRemote('vault', 'board', 1, { revision: 1, doc }), StorageConflictError)
    assert.equal(notifications, 0)
  } finally { stop() }
})
