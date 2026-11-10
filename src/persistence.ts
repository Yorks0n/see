import { documentStore } from './store/document'
import { cameraStore } from './store/camera'
import type { CanvasFile } from './types'

const DB_NAME = 'whiteboard-db'
const STORE = 'kv'
const DOC_KEY = 'current-canvas'
const RECOVERY_KEY = 'see-recovery-canvas'
interface SavedCanvas { savedAt: number; doc: CanvasFile }
let lastRevision = 0
const nextRevision = () => (lastRevision = Math.max(Date.now(), lastRevision + 1))

function readRecovery(): SavedCanvas | null {
  try {
    const saved = JSON.parse(localStorage.getItem(RECOVERY_KEY) ?? 'null') as SavedCanvas | null
    return saved && typeof saved.savedAt === 'number' && Array.isArray(saved.doc?.nodes) ? saved : null
  } catch { return null }
}
function currentCanvas(): CanvasFile {
  const doc = documentStore.toJSON()
  doc.meta = { ...doc.meta, camera: cameraStore.getSnapshot() }
  return doc
}
export function saveRecovery() {
  // pagehide cannot wait for IndexedDB to open. Keep a synchronous recovery copy.
  try { localStorage.setItem(RECOVERY_KEY, JSON.stringify({ savedAt: nextRevision(), doc: currentCanvas() })) } catch { /* IndexedDB remains the primary store for large canvases. */ }
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

export async function saveLocal() {
  const saved: SavedCanvas = { savedAt: nextRevision(), doc: currentCanvas() }
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(saved, DOC_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
    const recovery = readRecovery()
    if (recovery && recovery.savedAt <= saved.savedAt) {
      try { localStorage.removeItem(RECOVERY_KEY) } catch { /* Storage may be disabled. */ }
    }
  } catch {
    saveRecovery()
  }
}

export async function loadLocal(): Promise<CanvasFile | null> {
  const recovery = readRecovery()
  if (recovery) lastRevision = Math.max(lastRevision, recovery.savedAt)
  try {
    const db = await openDB()
    const stored = await new Promise<SavedCanvas | CanvasFile | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(DOC_KEY)
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
  doc.meta = { ...doc.meta, camera: cameraStore.getSnapshot(), app: 'whiteboard', appVersion: '0.1.0' }
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' })
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
