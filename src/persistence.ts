import { documentStore } from './store/document'
import { cameraStore } from './store/camera'
import type { CanvasFile } from './types'

const DB_NAME = 'whiteboard-db'
const STORE = 'kv'
const DOC_KEY = 'current-canvas'

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
  try {
    const db = await openDB()
    const doc = documentStore.toJSON()
    doc.meta = { ...doc.meta, camera: cameraStore.getSnapshot() }
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(doc, DOC_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  } catch {
    // IndexedDB 不可用时静默跳过（如隐私模式）
  }
}

export async function loadLocal(): Promise<CanvasFile | null> {
  try {
    const db = await openDB()
    const doc = await new Promise<CanvasFile | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(DOC_KEY)
      req.onsuccess = () => resolve(req.result as CanvasFile | undefined)
      req.onerror = () => reject(req.error)
    })
    db.close()
    return doc ?? null
  } catch {
    return null
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
  return file.text().then((text) => JSON.parse(text) as CanvasFile)
}
