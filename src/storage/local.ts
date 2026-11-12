import type { CanvasFile, CanvasNode } from '../types'
import { cloudCanvas, equal, type SyncBase } from '../sync/protocol'

export const DATABASE_NAME = 'whiteboard-db'
export const RECOVERY_PREFIX = 'see-local-recovery:'
const ASSET_PREFIX = 'see-asset:'
const LEGACY_RECOVERY = 'see-recovery-canvas'

interface StoredCanvas {
  schemaVersion: 1
  revision: number
  savedAt: number
  doc: CanvasFile | null
}
interface Journal {
  id: string
  baseRevision: number
  savedAt: number
  doc: CanvasFile
}
export interface LocalFile { id: string; name: string }
export interface SyncEntry { id: string; revision: number; doc: CanvasFile | null; base?: SyncBase }

export class StorageConflictError extends Error {
  constructor() { super('此白板已在另一个标签页修改或删除，请将当前内容保存为副本。') }
}

function record(value: unknown): StoredCanvas | null {
  if (value === undefined) return null
  const saved = value as StoredCanvas
  if (saved.schemaVersion !== undefined && saved.schemaVersion !== 1) throw new Error('本地数据来自更新版本，请更新应用后再打开。')
  const doc = 'doc' in saved ? saved.doc : value as CanvasFile
  if (doc !== null && (!doc || !Array.isArray(doc.nodes))) throw new Error('本地白板数据损坏，已停止读取以避免覆盖。')
  return { schemaVersion: 1, revision: saved.revision ?? 0, savedAt: saved.savedAt ?? 0, doc }
}

function mapMedia(doc: CanvasFile, map: (url: string) => string): CanvasFile {
  return {
    ...doc,
    nodes: doc.nodes?.map((node): CanvasNode => {
      if (node.type === 'image') return { ...node, url: map(node.url) }
      if (node.type === 'group' && node.background) return { ...node, background: map(node.background) }
      if (node.type === 'file') return { ...node, file: map(node.file) }
      return node
    }),
  }
}

function dataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('无法读取本地附件。'))
    reader.readAsDataURL(blob)
  })
}

export async function portableCanvas(doc: CanvasFile): Promise<CanvasFile> {
  const snapshot = structuredClone(doc), urls = new Set<string>(), replacements = new Map<string, string>()
  mapMedia(snapshot, (url) => { if (url.startsWith('blob:')) urls.add(url); return url })
  await Promise.all([...urls].map(async (url) => {
    const response = await fetch(url)
    if (!response.ok) throw new Error('无法读取导出文件中的附件。')
    replacements.set(url, await dataURL(await response.blob()))
  }))
  return mapMedia(snapshot, (url) => replacements.get(url) ?? url)
}

// One instance per tab. Revisions are only advanced by a load or our own committed write.
export class LocalRepository {
  private revisions = new Map<string, number>()
  private media = new Map<string, string>()
  // Reuse URLs across file switches. Undo and the internal clipboard may still
  // reference a previously opened board's media for the lifetime of this tab.
  private assetURLs = new Map<string, string>()
  private tail: Promise<unknown> = Promise.resolve()
  private writer = crypto.randomUUID()
  private listeners = new Set<() => void>()
  private writeListeners = new Set<() => void>()
  constructor(private name = DATABASE_NAME) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  subscribeWrites = (listener: () => void) => { this.writeListeners.add(listener); return () => { this.writeListeners.delete(listener) } }
  private notify() { this.listeners.forEach((listener) => listener()) }
  private notifyWrite() { this.writeListeners.forEach((listener) => listener()) }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      let blocked = false
      const request = indexedDB.open(this.name, 2)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv')
        if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets')
      }
      request.onerror = () => reject(request.error)
      request.onblocked = () => { blocked = true; reject(new Error('请关闭其他旧版白板标签页，再重试打开。')) }
      request.onsuccess = () => {
        const db = request.result
        if (blocked) { db.close(); return }
        db.onversionchange = () => db.close()
        resolve(db)
      }
    })
  }

  private async transaction<T>(stores: string[], mode: IDBTransactionMode, run: (tx: IDBTransaction, result: (value: T) => void, fail: (error: Error) => void) => void): Promise<T> {
    const db = await this.open()
    return new Promise<T>((resolve, reject) => {
      let value: T, failure: Error | null = null
      let tx: IDBTransaction
      try { tx = db.transaction(stores, mode) } catch (error) { db.close(); reject(error); return }
      tx.oncomplete = () => { db.close(); resolve(value) }
      tx.onabort = () => { db.close(); reject(failure ?? tx.error ?? new Error('本地存储事务已中止。')) }
      const fail = (error: Error) => { failure = error; tx.abort() }
      try { run(tx, (result) => { value = result }, fail) } catch (error) { fail(error as Error) }
    })
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(action)
    this.tail = pending.catch(() => {})
    return pending
  }

  private read(id: string) {
    return this.transaction<StoredCanvas | null>(['kv'], 'readonly', (tx, done, fail) => {
      const request = tx.objectStore('kv').get(`canvas:${id}`)
      request.onsuccess = () => {
        try { done(record(request.result)) } catch (error) { fail(error as Error) }
      }
    })
  }

  async list(): Promise<LocalFile[]> {
    return this.transaction(['kv'], 'readonly', (tx, done, fail) => {
      const files: LocalFile[] = []
      const request = tx.objectStore('kv').openCursor()
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) { done(files); return }
        try {
          if (typeof cursor.key === 'string' && cursor.key.startsWith('canvas:')) {
            const saved = record(cursor.value)
            if (saved?.doc) files.push({ id: cursor.key.slice(7), name: saved.doc.meta?.name || '未命名白板' })
          }
          cursor.continue()
        } catch (error) { fail(error as Error) }
      }
    })
  }

  private async hydrate(doc: CanvasFile): Promise<CanvasFile> {
    const refs = new Set<string>()
    mapMedia(doc, (url) => { if (url.startsWith(ASSET_PREFIX)) refs.add(url); return url })
    const replacements = new Map<string, string>()
    await Promise.all([...refs].map(async (ref) => {
      const cached = this.assetURLs.get(ref)
      if (cached) { replacements.set(ref, cached); return }
      const blob = await this.transaction<Blob | undefined>(['assets'], 'readonly', (tx, done) => {
        const request = tx.objectStore('assets').get(ref)
        request.onsuccess = () => done(request.result)
      })
      if (!blob) throw new Error('白板的本地附件缺失，已停止加载以避免保存不完整内容。')
      const url = URL.createObjectURL(blob)
      this.assetURLs.set(ref, url)
      replacements.set(ref, url)
      this.media.set(url, ref)
    }))
    return mapMedia(doc, (url) => replacements.get(url) ?? url)
  }

  async load(id: string): Promise<CanvasFile | null> {
    await this.tail
    const saved = await this.read(id)
    const doc = saved?.doc ? await this.hydrate(saved.doc) : null
    this.revisions.set(id, saved?.revision ?? 0)
    return doc
  }
  async hasExternalChange(id: string): Promise<boolean> {
    await this.tail
    return ((await this.read(id))?.revision ?? 0) !== (this.revisions.get(id) ?? 0)
  }

  private async prepare(doc: CanvasFile) {
    const urls = new Set<string>()
    mapMedia(doc, (url) => { if (/^(data:|blob:)/.test(url) && !this.media.has(url)) urls.add(url); return url })
    const assets = new Map<string, Blob>(), replacements = new Map(this.media)
    await Promise.all([...urls].map(async (url) => {
      const response = await fetch(url)
      if (!response.ok) throw new Error('无法保存本地附件。')
      const blob = await response.blob()
      const bytes = await new Blob([blob.type, '\0', blob]).arrayBuffer()
      const digest = await crypto.subtle.digest('SHA-256', bytes)
      const ref = ASSET_PREFIX + [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join('')
      replacements.set(url, ref)
      assets.set(ref, blob)
    }))
    return { doc: mapMedia(doc, (url) => replacements.get(url) ?? url), assets, replacements }
  }

  save(id: string, doc: CanvasFile): Promise<void> {
    // Capture before any await; a file switch must never change the target or contents.
    const snapshot = structuredClone(this.compact(doc))
    return this.enqueue(async () => {
      const prepared = await this.prepare(snapshot)
      const expected = this.revisions.get(id) ?? 0
      const saved = await this.transaction<{ revision: number; contentChanged: boolean }>(['kv', 'assets'], 'readwrite', (tx, done, fail) => {
        const store = tx.objectStore('kv'), request = store.get(`canvas:${id}`)
        request.onsuccess = () => {
          try {
            const current = record(request.result)
            if (current?.doc === null || (current?.revision ?? 0) !== expected) throw new StorageConflictError()
            const next = expected + 1
            prepared.assets.forEach((blob, ref) => tx.objectStore('assets').put(blob, ref))
            const refs = new Set<string>()
            mapMedia(prepared.doc, (url) => { if (url.startsWith(ASSET_PREFIX) && !prepared.assets.has(url)) refs.add(url); return url })
            const commit = () => {
              store.put({ schemaVersion: 1, revision: next, savedAt: Date.now(), doc: prepared.doc } satisfies StoredCanvas, `canvas:${id}`)
              done({ revision: next, contentChanged: !equal(cloudCanvas(current?.doc ?? null), cloudCanvas(prepared.doc)) })
            }
            if (!refs.size) commit()
            let remaining = refs.size
            refs.forEach((ref) => {
              const asset = tx.objectStore('assets').get(ref)
              asset.onsuccess = () => {
                try {
                  if (!(asset.result instanceof Blob)) throw new Error('本地附件缺失，无法保存白板。')
                  if (--remaining === 0) commit()
                } catch (error) { fail(error as Error) }
              }
            })
          } catch (error) { fail(error as Error) }
        }
      })
      this.revisions.set(id, saved.revision)
      this.notifyWrite()
      // View changes are persisted locally without scheduling a cloud sync.
      if (saved.contentChanged) this.notify()
      prepared.replacements.forEach((ref, url) => this.media.set(url, ref))
      // Keep a newer pagehide journal until that exact snapshot has committed.
      try {
        const key = `${RECOVERY_PREFIX}${this.writer}:${id}`, raw = localStorage.getItem(key)
        if (raw) {
          const journal = JSON.parse(raw) as Journal
          if (JSON.stringify(journal.doc) === JSON.stringify(this.compact(snapshot))) localStorage.removeItem(key)
        }
      } catch { /* A successful IndexedDB commit does not depend on localStorage. */ }
    })
  }

  delete(id: string): Promise<void> {
    return this.enqueue(async () => {
      const expected = this.revisions.get(id) ?? 0
      await this.transaction<void>(['kv'], 'readwrite', (tx, done, fail) => {
        const store = tx.objectStore('kv'), request = store.get(`canvas:${id}`)
        request.onsuccess = () => {
          try {
            const current = record(request.result)
            if ((current?.revision ?? 0) !== expected) throw new StorageConflictError()
            store.put({ schemaVersion: 1, revision: expected + 1, savedAt: Date.now(), doc: null } satisfies StoredCanvas, `canvas:${id}`)
            done()
          } catch (error) { fail(error as Error) }
        }
      })
      this.revisions.set(id, expected + 1)
      this.notifyWrite()
      this.notify()
      try { localStorage.removeItem(`${RECOVERY_PREFIX}${this.writer}:${id}`) } catch { /* Optional journal. */ }
      // Assets are retained: undo, duplicates and recovery journals may still reference them.
    })
  }

  private compact(doc: CanvasFile) {
    return mapMedia(doc, (url) => this.media.get(url) ?? url)
  }

  journal(id: string, doc: CanvasFile, storage: Storage = localStorage) {
    const journal: Journal = { id, doc: this.compact(doc), baseRevision: this.revisions.get(id) ?? 0, savedAt: Date.now() }
    storage.setItem(`${RECOVERY_PREFIX}${this.writer}:${id}`, JSON.stringify(journal))
  }

  clearJournal(id: string) {
    try { localStorage.removeItem(`${RECOVERY_PREFIX}${this.writer}:${id}`) } catch { /* Optional journal. */ }
  }

  async syncEntries(vault: string): Promise<SyncEntry[]> {
    await this.tail
    return this.transaction(['kv'], 'readonly', (tx, done, fail) => {
      const request = tx.objectStore('kv').getAllKeys(), result: SyncEntry[] = []
      request.onsuccess = () => {
        const keys = request.result.filter((key) => String(key).startsWith('canvas:'))
        if (!keys.length) { done(result); return }
        let pending = keys.length
        for (const key of keys) {
          const id = String(key).slice(7), read = tx.objectStore('kv').get(key)
          read.onsuccess = () => {
            try {
              const saved = record(read.result)!
              const base = tx.objectStore('kv').get(`sync:${vault}:${id}`)
              base.onsuccess = () => {
                result.push({ id, revision: saved.revision, doc: saved.doc, base: base.result })
                if (--pending === 0) done(result)
              }
            } catch (error) { fail(error as Error) }
          }
        }
      }
    })
  }

  async getAsset(ref: string): Promise<Blob | undefined> {
    return this.transaction(['assets'], 'readonly', (tx, done) => {
      const request = tx.objectStore('assets').get(ASSET_PREFIX + ref)
      request.onsuccess = () => done(request.result)
    })
  }

  async cacheAsset(ref: string, blob: Blob) {
    const digest = await crypto.subtle.digest('SHA-256', await new Blob([blob.type, '\0', blob]).arrayBuffer())
    const actual = [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join('')
    if (actual !== ref) throw new Error('下载附件校验失败，请重试')
    await this.transaction<void>(['assets'], 'readwrite', (tx, done) => {
      tx.objectStore('assets').put(blob, ASSET_PREFIX + ref); done()
    })
  }

  acknowledge(vault: string, id: string, base: SyncBase) {
    return this.enqueue(() => this.transaction<void>(['kv'], 'readwrite', (tx, done) => {
      const store = tx.objectStore('kv'), key = `sync:${vault}:${id}`, request = store.get(key)
      request.onsuccess = () => {
        if (!request.result || request.result.revision <= base.revision) store.put(base, key)
        done()
      }
    }))
  }

  acceptRemote(vault: string, id: string, expected: number, remote: SyncBase, backupId?: string): Promise<void> {
    return this.enqueue(async () => {
      await this.transaction<void>(['kv'], 'readwrite', (tx, done, fail) => {
        const store = tx.objectStore('kv'), request = store.get(`canvas:${id}`)
        request.onsuccess = () => {
          try {
            const current = record(request.result)
            if ((current?.revision ?? 0) !== expected) throw new StorageConflictError()
            if (backupId && current?.doc) {
              store.put({
                schemaVersion: 1, revision: 1, savedAt: Date.now(),
                doc: { ...current.doc, meta: { ...current.doc.meta, name: `${current.doc.meta?.name || '白板'}（冲突副本）` } },
              } satisfies StoredCanvas, `canvas:${backupId}`)
            }
            const doc = remote.doc ? { ...remote.doc, meta: { ...remote.doc.meta, camera: current?.doc?.meta?.camera } } : null
            store.put({ schemaVersion: 1, revision: expected + 1, savedAt: Date.now(), doc } satisfies StoredCanvas, `canvas:${id}`)
            store.put(remote, `sync:${vault}:${id}`)
            done()
          } catch (error) { fail(error as Error) }
        }
      })
      this.notifyWrite()
    })
  }

  // Legacy stores remain readable until each import has committed. A stale recovery
  // becomes a separate board instead of overwriting another tab or reviving a deletion.
  async recover(storage: Storage | null): Promise<void> {
    const legacy = await this.transaction<unknown>(['kv'], 'readonly', (tx, done) => {
      const request = tx.objectStore('kv').get('current-canvas')
      request.onsuccess = () => done(request.result)
    })
    if (legacy) {
      await this.transaction<void>(['kv'], 'readwrite', (tx, done, fail) => {
        const store = tx.objectStore('kv'), request = store.getAllKeys()
        request.onsuccess = () => {
          try {
            // Preserve the original timestamp so a newer legacy recovery still wins.
            // Tombstones also count: never re-import an intentionally deleted library.
            if (!request.result.some((key) => String(key).startsWith('canvas:'))) {
              const saved = record(legacy)
              if (saved?.doc) store.put(saved, 'canvas:legacy-default')
            }
            done()
          } catch (error) { fail(error as Error) }
        }
      })
    }
    if (!storage) return
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)!)
    for (const key of keys.filter((key) => key?.startsWith(RECOVERY_PREFIX) || key?.startsWith(LEGACY_RECOVERY))) {
      const raw = storage.getItem(key)
      if (!raw) continue
      const value = JSON.parse(raw)
      if (!value?.doc || !Array.isArray(value.doc.nodes)) throw new Error('本地恢复数据损坏，请先备份浏览器数据。')
      const modern = key.startsWith(RECOVERY_PREFIX)
      const id = modern ? value.id : key === LEGACY_RECOVERY ? 'legacy-default' : key.slice(`${LEGACY_RECOVERY}:canvas:`.length)
      const current = await this.read(id)
      if (!modern && current && current.savedAt >= value.savedAt) { storage.removeItem(key); continue }
      const doc = await this.hydrate(value.doc)
      const existing = current?.doc ? await this.hydrate(current.doc) : null
      if (JSON.stringify(existing) !== JSON.stringify(doc)) {
        const conflict = current?.doc === null || (modern && (current?.revision ?? 0) !== value.baseRevision)
        const recoveredId = `recovered-${key}-${value.savedAt}`
        const target = conflict ? recoveredId : id
        if (!(conflict && await this.read(target))) {
          this.revisions.set(target, conflict ? 0 : current?.revision ?? 0)
          try {
            await this.save(target, conflict ? { ...doc, meta: { ...doc.meta, name: `${doc.meta?.name || '白板'}（恢复副本）` } } : doc)
          } catch (error) {
            // Another tab may have written since read(). Leave the journal for retry.
            if (!(error instanceof StorageConflictError)) throw error
            continue
          }
        }
      }
      if (storage.getItem(key) === raw) storage.removeItem(key)
    }
  }
}
