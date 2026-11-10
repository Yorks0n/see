import { documentStore } from './store/document'
import { cameraStore } from './store/camera'
import type { CanvasFile } from './types'

const DB_NAME = 'whiteboard-db'
const STORE = 'kv'
const DOC_KEY = 'current-canvas'
const RECOVERY_KEY = 'see-recovery-canvas'
let activeFileKey = DOC_KEY
const deletedFiles = new Set<string>()
export function setActiveFile(id: string) { activeFileKey = `canvas:${id}` }
const recoveryKey = (key: string) => key === DOC_KEY ? RECOVERY_KEY : `${RECOVERY_KEY}:${key}`
interface SavedCanvas { savedAt: number; doc: CanvasFile }
let lastRevision = 0
const nextRevision = () => (lastRevision = Math.max(Date.now(), lastRevision + 1))

function readRecovery(key = activeFileKey): SavedCanvas | null {
  try {
    const saved = JSON.parse(localStorage.getItem(recoveryKey(key)) ?? 'null') as SavedCanvas | null
    return saved && typeof saved.savedAt === 'number' && Array.isArray(saved.doc?.nodes) ? saved : null
  } catch { return null }
}
function currentCanvas(): CanvasFile {
  const doc = documentStore.toJSON()
  doc.meta = { ...doc.meta, camera: cameraStore.getSnapshot() }
  return doc
}
function writeRecovery(saved: SavedCanvas, key: string) {
  if (deletedFiles.has(key)) return
  try { localStorage.setItem(recoveryKey(key), JSON.stringify(saved)) } catch { /* IndexedDB remains the primary store for large canvases. */ }
}
export function saveRecovery() {
  // pagehide cannot wait for IndexedDB to open. Keep a synchronous recovery copy.
  writeRecovery({ savedAt: nextRevision(), doc: currentCanvas() }, activeFileKey)
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function saveSnapshot(key: string, doc: CanvasFile) {
  if (deletedFiles.has(key)) return
  const saved: SavedCanvas = { savedAt: nextRevision(), doc }
  try {
    const db = await openDB()
    if (deletedFiles.has(key)) { db.close(); return }
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(saved, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
    const recovery = readRecovery(key)
    if (recovery && recovery.savedAt <= saved.savedAt) {
      try { localStorage.removeItem(recoveryKey(key)) } catch { /* Storage may be disabled. */ }
    }
  } catch {
    writeRecovery(saved, key)
  }
}

export function saveLocal() { return saveSnapshot(activeFileKey, currentCanvas()) }
export function saveCanvas(id: string, doc: CanvasFile) { return saveSnapshot(`canvas:${id}`, doc) }

export async function deleteLocalFile(id: string) {
  const key = `canvas:${id}`
  deletedFiles.add(key)
  try {
    const db = await openDB()
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).delete(key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    } finally { db.close() }
  } catch (error) {
    // Recovery is the only storage when IndexedDB is unavailable.
    if (typeof indexedDB !== 'undefined') { deletedFiles.delete(key); throw error }
  }
  localStorage.removeItem(recoveryKey(key))
}

export async function loadLocal(fileId?: string): Promise<CanvasFile | null> {
  const key = fileId ? `canvas:${fileId}` : activeFileKey
  const recovery = readRecovery(key)
  if (recovery) lastRevision = Math.max(lastRevision, recovery.savedAt)
  try {
    const db = await openDB()
    const stored = await new Promise<SavedCanvas | CanvasFile | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(key)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    db.close()
    const saved = stored && 'doc' in stored ? stored as SavedCanvas : null
    if (saved) lastRevision = Math.max(lastRevision, saved.savedAt)
    if (recovery && (!saved || recovery.savedAt >= saved.savedAt)) return recovery.doc
    return saved ? saved.doc : (stored as CanvasFile | undefined) ?? null
  } catch {
    return recovery?.doc ?? null
  }
}

export function exportCanvasFile() {
  const doc = documentStore.toJSON()
  downloadCanvasFile({ ...doc, meta: { ...doc.meta, camera: cameraStore.getSnapshot() } })
}
export function downloadCanvasFile(doc: CanvasFile) {
  const file = { ...doc, meta: { ...doc.meta, app: 'whiteboard', appVersion: '0.1.0' } }
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${doc.meta?.name ?? 'canvas'}.canvas`
  a.click()
  URL.revokeObjectURL(url)
}

export function importCanvasFile(file: File): Promise<CanvasFile> {
  return file.text().then((text) => {
    const doc: unknown = JSON.parse(text)
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('无效的画布文件')
    const canvas = doc as CanvasFile
    if (!Array.isArray(canvas.nodes) || (canvas.edges !== undefined && !Array.isArray(canvas.edges))) throw new Error('无效的画布文件')
    return canvas
  })
}
