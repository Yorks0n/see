import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { LocalRepository, portableCanvas, RECOVERY_PREFIX, StorageConflictError } from '../src/storage/local'
import { documentStore } from '../src/store/document'
import { importCanvasFile, loadLocal, markDirty, persistenceStore, saveLocal, serializeCanvasFile, setActiveFile } from '../src/persistence'
import type { CanvasFile } from '../src/types'

class MemoryStorage {
  private values = new Map<string, string>()
  get length() { return this.values.size }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
  clear() { this.values.clear() }
}

// Node provides Blob but not FileReader; exercise real binary round-trips.
class BlobReader {
  result: string | null = null
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  readAsDataURL(blob: Blob) {
    void blob.arrayBuffer().then((bytes) => {
      this.result = `data:${blob.type};base64,${btoa(String.fromCharCode(...new Uint8Array(bytes)))}`
      this.onload?.()
    }).catch(() => this.onerror?.())
  }
}
beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() })
  Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: BlobReader })
})

const canvas = (text = 'original'): CanvasFile => ({
  nodes: [{ id: 'text', type: 'text', x: -20, y: 40, width: 200, height: 80, text }],
  edges: [],
  meta: { name: text, camera: { x: 30, y: -40, zoom: 0.8 } },
})
const imageURL = 'data:image/png;base64,aGVsbG8='
const withImage = (): CanvasFile => ({
  ...canvas(),
  nodes: [
    ...canvas().nodes!,
    { id: 'image', type: 'image', x: 0, y: 10, width: 50, height: 90, url: imageURL, naturalWidth: 100, naturalHeight: 180, crop: { x: 0.2, y: 0.1, width: 0.6, height: 0.8 }, text: '说明' },
    { id: 'group', type: 'group', x: -50, y: -50, width: 400, height: 400, memberIds: ['image'], background: imageURL, backgroundStyle: 'cover' },
  ],
})

test('downloaded canvas restores every main content state, order, camera and embedded attachment', async () => {
  const url = URL.createObjectURL(new Blob(['attachment'], { type: 'image/png' }))
  try {
    documentStore.load({
      nodes: [
        { id: 'text', type: 'text', x: -10, y: 10, width: 220, height: 100, color: '4', text: '# 标题\n\n**粗体**\n\n- 列表\n- [ ] 待办' },
        { id: 'photo', type: 'image', x: 300, y: 40, width: 160, height: 120, url, text: '图片说明', naturalWidth: 800, naturalHeight: 600, crop: { x: 0.2, y: 0.1, width: 0.5, height: 0.7 } },
        { id: 'file', type: 'file', x: 50, y: 200, width: 120, height: 60, file: url, subpath: '#section' },
        { id: 'link', type: 'link', x: 300, y: 200, width: 200, height: 60, url: 'https://example.com' },
        { id: 'draw', type: 'draw', x: -100, y: 400, width: 60, height: 60, color: '#123456', strokeWidth: 7, points: [{ x: 0, y: 0 }, { x: 60, y: 60 }] },
        { id: 'rect', type: 'rectangle', x: 0, y: 400, width: 180, height: 80, color: '2' },
        { id: 'list', type: 'group', x: 600, y: 0, width: 260, height: 400, minHeight: 400, label: '有序列表', layout: 'list', memberIds: ['photo', 'text'] },
        { id: 'group', type: 'group', x: -200, y: -100, width: 1200, height: 800, label: '分组', memberIds: ['list', 'rect'], color: '5', background: url, backgroundStyle: 'ratio' },
      ],
      edges: [{ id: 'edge', fromNode: 'text', toNode: 'photo', fromSide: 'right', toSide: 'left', fromEnd: 'none', toEnd: 'arrow', color: '#abcdef', label: '隐藏的标签', labelIsVisible: false, labelOffset: { x: 12, y: -8 }, lineStyle: 'straight' }],
      meta: { name: '状态备份', camera: { x: -45, y: 70, zoom: 0.75 }, tldraw: { source: { records: [{ id: 'source' }] }, warnings: ['原始数据'] } },
    })
    const before = documentStore.toJSON()
    const serialized = await serializeCanvasFile(before)
    URL.revokeObjectURL(url)
    assert.equal(serialized.includes('blob:'), false)
    const imported = await importCanvasFile(new File([serialized], 'backup.canvas'))
    documentStore.load(imported)
    const after = documentStore.toJSON()
    const embedded = 'data:image/png;base64,YXR0YWNobWVudA=='
    const expected = JSON.parse(JSON.stringify(before).replaceAll(url, embedded))
    expected.meta = { ...expected.meta, app: 'whiteboard', appVersion: '0.1.0' }
    assert.deepEqual(after, expected)
    assert.deepEqual(before.nodes!.map((n) => n.id), after.nodes!.map((n) => n.id))
    assert.equal((before.nodes!.find((n) => n.id === 'photo') as any).url, url)
  } finally { URL.revokeObjectURL(url) }
})

async function database(name = 'whiteboard-db', version = 2) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, version)
    request.onupgradeneeded = () => request.result.createObjectStore('kv')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
async function inspect(store: string, key?: string) {
  const db = await database()
  try {
    return await new Promise<any>((resolve, reject) => {
      const tx = db.transaction(store, 'readonly')
      const request = key ? tx.objectStore(store).get(key) : tx.objectStore(store).getAll()
      tx.oncomplete = () => resolve(request.result)
      tx.onabort = () => reject(tx.error)
    })
  } finally { db.close() }
}
async function seedLegacy(key: string, value: unknown) {
  const db = await database('whiteboard-db', 1)
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite')
    tx.objectStore('kv').put(value, key)
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error)
  })
  db.close()
}

test('reload preserves document properties, embedded images and group backgrounds in separate Blob storage', async () => {
  const writer = new LocalRepository()
  const doc = withImage()
  await writer.save('board', doc)
  await writer.save('duplicate', doc)
  const stored = await inspect('kv', 'canvas:board')
  assert.equal(stored.schemaVersion, 1)
  assert.match(stored.doc.nodes[1].url, /^see-asset:/)
  assert.equal(stored.doc.nodes[1].url, stored.doc.nodes[2].background)
  assert.equal((await inspect('assets')).length, 1)
  assert.ok((await inspect('assets'))[0] instanceof Blob)
  assert.deepEqual(await new LocalRepository().load('board'), doc)
  assert.deepEqual(await new LocalRepository().list(), [{ id: 'board', name: 'original' }, { id: 'duplicate', name: 'original' }])
})

test('a temporary blob URL survives reload after the source URL is revoked', async () => {
  const url = URL.createObjectURL(new Blob(['video bytes'], { type: 'video/mp4' }))
  const doc: CanvasFile = { nodes: [{ id: 'file', type: 'file', file: url, x: 0, y: 0, width: 100, height: 100 }] }
  await new LocalRepository().save('blob', doc)
  const exported = await portableCanvas(doc)
  URL.revokeObjectURL(url)
  const restored = await new LocalRepository().load('blob')
  assert.match((restored!.nodes![0] as any).file, /^data:video\/mp4;base64,/)
  assert.deepEqual(restored, exported)
  assert.equal(JSON.stringify(exported).includes('blob:'), false)
})

test('concurrent tabs cannot replace a newer document, including simultaneous first writes', async () => {
  const left = new LocalRepository(), right = new LocalRepository()
  await left.save('shared', canvas())
  await right.load('shared')
  await left.save('shared', canvas('left wins'))
  await assert.rejects(right.save('shared', canvas('right stale')), StorageConflictError)
  assert.equal((await right.load('shared'))!.meta!.name, 'left wins')
  await right.save('shared', canvas('after explicit reload'))
  const results = await Promise.allSettled([left.save('new', canvas('a')), right.save('new', canvas('b'))])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
})

test('a pending snapshot retains its contents and FIFO order', async () => {
  const repository = new LocalRepository(), first = canvas('first')
  const pending = repository.save('one', first)
  first.nodes = []
  const last = repository.save('one', canvas('last'))
  await Promise.all([pending, last, repository.save('two', canvas('other board'))])
  const reopened = new LocalRepository()
  assert.deepEqual(await reopened.load('one'), canvas('last'))
  assert.deepEqual(await reopened.load('two'), canvas('other board'))
})

test('a tombstone prevents stale saves and journals from resurrecting a deleted board', async () => {
  const left = new LocalRepository(), right = new LocalRepository()
  await left.save('deleted', canvas())
  await right.load('deleted')
  await left.delete('deleted')
  await assert.rejects(right.save('deleted', canvas('offline changes')), StorageConflictError)
  right.journal('deleted', canvas('offline changes'))
  const reopened = new LocalRepository()
  await reopened.recover(localStorage)
  assert.equal(await reopened.load('deleted'), null)
  const files = await reopened.list()
  assert.equal(files.length, 1)
  assert.match(files[0].name, /恢复副本/)
  assert.equal((await reopened.load(files[0].id))!.nodes![0].type, 'text')
  await reopened.recover(localStorage)
  assert.equal((await reopened.list()).length, 1)
})

test('recovery restores empty documents and preserves divergent edits as a separate board', async () => {
  const left = new LocalRepository(), right = new LocalRepository()
  await left.save('shared', canvas())
  await right.load('shared')
  left.journal('shared', { nodes: [], edges: [], meta: { name: 'empty' } })
  await new LocalRepository().recover(localStorage)
  assert.deepEqual((await new LocalRepository().load('shared'))!.nodes, [])
  right.journal('shared', canvas('stale text'))
  const reopened = new LocalRepository()
  await reopened.recover(localStorage)
  const files = await reopened.list()
  assert.equal(files.length, 2)
  assert.equal((await reopened.load('shared'))!.meta!.name, 'empty')
  assert.equal(localStorage.length, 0)
})

test('pagehide journals reuse committed assets and remain recoverable after a later save', async () => {
  const repo = new LocalRepository()
  const doc = withImage()
  await repo.save('images', doc)
  repo.journal('images', { ...doc, meta: { name: 'latest' } })
  const journal = localStorage.getItem(localStorage.key(0)!)!
  assert.doesNotMatch(journal, /data:image/)
  assert.match(journal, /see-asset:/)
  await repo.save('images', doc)
  await new LocalRepository().recover(localStorage)
  const files = await new LocalRepository().list()
  assert.ok(files.some((file) => /latest/.test(file.name)))
})

test('legacy IndexedDB and localStorage recovery migrate without a file directory', async () => {
  await seedLegacy('current-canvas', { savedAt: 1, doc: canvas('old single board') })
  localStorage.setItem('see-recovery-canvas', JSON.stringify({ savedAt: 2, doc: canvas('latest single board') }))
  localStorage.setItem('see-recovery-canvas:canvas:orphan', JSON.stringify({ savedAt: 2, doc: canvas('orphan board') }))
  const repo = new LocalRepository()
  await repo.recover(localStorage)
  assert.deepEqual((await repo.list()).map((file) => file.name), ['latest single board', 'orphan board'])
  assert.equal(localStorage.getItem('see-recovery-canvas:canvas:orphan'), null)
  await repo.recover(localStorage)
  assert.equal((await repo.list()).length, 2)
})

test('failed transactions roll back document and assets together and can be retried', async () => {
  const repository = new LocalRepository()
  await repository.save('board', canvas('before'))
  const original = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function (value, key) {
    if (this.name === 'kv') throw new DOMException('disk full', 'QuotaExceededError')
    return original.call(this, value, key)
  }
  try { await assert.rejects(repository.save('board', withImage()), { name: 'QuotaExceededError' }) }
  finally { IDBObjectStore.prototype.put = original }
  assert.equal((await new LocalRepository().load('board'))!.meta!.name, 'before')
  assert.equal((await inspect('assets')).length, 0)
  await repository.save('board', withImage())
  assert.deepEqual(await new LocalRepository().load('board'), withImage())
})

test('missing assets and newer storage schemas fail closed without overwriting stored content', async () => {
  await seedLegacy('canvas:newer', { schemaVersion: 99, revision: 8, doc: canvas() })
  const repo = new LocalRepository()
  await assert.rejects(repo.load('newer'), /更新版本/)
  await assert.rejects(repo.save('newer', canvas('overwrite')), /更新版本/)
  assert.equal((await inspect('kv', 'canvas:newer')).schemaVersion, 99)
  await assert.rejects(repo.save('missing', { nodes: [{ id: 'image', type: 'image', url: 'see-asset:absent', x: 0, y: 0, width: 1, height: 1 }] }), /附件缺失/)
  assert.equal(await repo.load('missing'), null)
})

test('saved status never reports success when IndexedDB and the recovery journal both fail', async () => {
  setActiveFile('failed-save-status')
  await loadLocal()
  documentStore.load(canvas('must not disappear'))
  markDirty()
  const original = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = () => { throw new DOMException('full', 'QuotaExceededError') }
  localStorage.setItem = () => { throw new DOMException('full', 'QuotaExceededError') }
  try {
    await assert.rejects(saveLocal(), { name: 'QuotaExceededError' })
    assert.equal(persistenceStore.getSnapshot().state, 'error')
    assert.match(persistenceStore.getSnapshot().message, /空间不足/)
    assert.equal(documentStore.getSnapshot().meta!.name, 'must not disappear')
  } finally { IDBObjectStore.prototype.put = original }
  await saveLocal()
  assert.equal(persistenceStore.getSnapshot().state, 'saved')
})

test('no-op changes clear pending status without writing an additional revision', async () => {
  setActiveFile('no-op')
  await loadLocal()
  documentStore.load(canvas())
  await saveLocal()
  const revision = (await inspect('kv', 'canvas:no-op')).revision
  markDirty()
  await saveLocal()
  assert.equal(persistenceStore.getSnapshot().state, 'saved')
  assert.equal((await inspect('kv', 'canvas:no-op')).revision, revision)
})

test('a corrupt recovery journal is preserved and not silently discarded', async () => {
  localStorage.setItem(`${RECOVERY_PREFIX}bad`, '{broken')
  await assert.rejects(new LocalRepository().recover(localStorage))
  assert.equal(localStorage.getItem(`${RECOVERY_PREFIX}bad`), '{broken')
})

test('remote updates are atomic with sync base and never overwrite a newer local edit', async () => {
  const repo = new LocalRepository()
  await repo.save('board', canvas('local'))
  const [entry] = await repo.syncEntries('vault')
  await repo.save('board', canvas('newer edit'))
  await assert.rejects(repo.acceptRemote('vault', 'board', entry.revision, { revision: 2, doc: canvas('remote') }), StorageConflictError)
  assert.equal((await repo.load('board'))!.meta!.name, 'newer edit')
  assert.equal((await repo.syncEntries('vault'))[0].base, undefined)
})

test('conflict copies and remote tombstones commit together and survive reopening', async () => {
  const repo = new LocalRepository()
  await repo.save('board', canvas('offline'))
  await repo.acceptRemote('vault', 'board', 1, { revision: 3, doc: null }, 'copy')
  const reopened = new LocalRepository()
  assert.equal(await reopened.load('board'), null)
  assert.equal((await reopened.load('copy'))!.meta!.name, 'offline（冲突副本）')
  const entry = (await reopened.syncEntries('vault')).find((value) => value.id === 'board')!
  assert.deepEqual(entry.base, { revision: 3, doc: null })
})

test('sync acknowledgements never move the common base backwards across tabs', async () => {
  const repo = new LocalRepository()
  await repo.save('board', canvas())
  await repo.acknowledge('vault', 'board', { revision: 10, doc: canvas('newer') })
  await repo.acknowledge('vault', 'board', { revision: 2, doc: canvas('older') })
  assert.equal((await repo.syncEntries('vault'))[0].base!.revision, 10)
  assert.equal((await repo.syncEntries('different-vault'))[0].base, undefined)
})
