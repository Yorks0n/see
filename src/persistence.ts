import { documentStore } from './store/document'
import { cameraStore } from './store/camera'
import { LocalRepository, portableCanvas, StorageConflictError } from './storage/local'
import type { CanvasFile } from './types'

export const localRepository = new LocalRepository()
let activeFileId = 'legacy-default'
const savedDocuments = new Map<string, string>()
const pendingSaves = new Map<string, Promise<void>>()
type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'
let status: { state: SaveState; message: string } = { state: 'saved', message: '' }
const listeners = new Set<() => void>()
function publish(state: SaveState, message = '') {
  status = { state, message }
  listeners.forEach((listener) => listener())
}
export const persistenceStore = {
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  getSnapshot: () => status,
}
function currentCanvas(): CanvasFile {
  const doc = documentStore.toJSON()
  doc.meta = { ...doc.meta, camera: cameraStore.getSnapshot() }
  return doc
}
export function setActiveFile(id: string) { activeFileId = id; savedDocuments.clear(); publish('saved') }
export function markLoaded() {
  savedDocuments.set(activeFileId, JSON.stringify(currentCanvas()))
  publish('saved')
}
export function markDirty() {
  if (status.state !== 'error' && status.state !== 'conflict') publish('dirty')
}
export function reportSaveError(error: unknown) {
  const message = error instanceof StorageConflictError ? error.message
    : error instanceof DOMException && error.name === 'QuotaExceededError' ? '本地空间不足，未能保存。请下载白板备份后释放空间，再重试。'
    : `本地保存失败，请重试或下载白板备份。${error instanceof Error ? ` ${error.message}` : ''}`
  publish(error instanceof StorageConflictError ? 'conflict' : 'error', message)
}
export function saveRecovery() {
  if (savedDocuments.get(activeFileId) === JSON.stringify(currentCanvas())) return
  try { localRepository.journal(activeFileId, currentCanvas()) }
  catch (error) { reportSaveError(error) }
}
export function saveLocal(): Promise<void> {
  const id = activeFileId, existing = pendingSaves.get(id)
  if (existing) return existing
  const pending = flushLocal(id)
  pendingSaves.set(id, pending)
  pending.then(() => pendingSaves.delete(id), () => pendingSaves.delete(id))
  return pending
}
async function flushLocal(id: string): Promise<void> {
  // Include edits made while an earlier transaction was committing before switching files.
  do {
    const doc = currentCanvas(), serialized = JSON.stringify(doc)
    if (savedDocuments.get(id) === serialized) {
      if (id === activeFileId) publish('saved')
      return
    }
    publish('saving')
    try {
      await localRepository.save(id, doc)
      savedDocuments.set(id, serialized)
      if (id === activeFileId) publish(serialized === JSON.stringify(currentCanvas()) ? 'saved' : 'dirty')
    } catch (error) {
      if (id === activeFileId) { saveRecovery(); reportSaveError(error) }
      throw error
    }
  } while (id === activeFileId && savedDocuments.get(id) !== JSON.stringify(currentCanvas()))
}
export function saveCanvas(id: string, doc: CanvasFile) { return localRepository.save(id, doc) }
export function loadLocal(id = activeFileId) { return localRepository.load(id) }
export function deleteLocalFile(id: string) { return localRepository.delete(id) }
export async function initializeLocal() {
  let storage: Storage | null = null
  try { storage = localStorage; void storage.length } catch { storage = null }
  await localRepository.recover(storage)
}
export async function requestPersistentStorage() {
  try { await navigator.storage?.persist?.() } catch { /* Browser grants this on a best-effort basis. */ }
}

export function exportCanvasFile() {
  const doc = documentStore.toJSON()
  return downloadCanvasFile({ ...doc, meta: { ...doc.meta, camera: cameraStore.getSnapshot() } })
}
export async function downloadCanvasFile(doc: CanvasFile) {
  const portable = await portableCanvas(doc)
  const file = { ...portable, meta: { ...portable.meta, app: 'whiteboard', appVersion: '0.1.0' } }
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${doc.meta?.name ?? 'canvas'}.canvas`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
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
