import { deleteLocalFile, downloadCanvasFile, initializeLocal, localRepository, loadLocal, markLoaded, saveCanvas, saveLocal, setActiveFile } from '../persistence'
import type { CanvasFile } from '../types'
import { cameraStore } from './camera'
import { documentStore, uid } from './document'

export const LIBRARY_KEY = 'see-file-library'
export interface BoardFile { id: string; name: string; pinned?: boolean }
interface Library { files: BoardFile[]; activeFileId: string | null; ready: boolean; busy: boolean }
const pinnedFirst = (files: BoardFile[]) => [...files].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned))

export class LibraryStore {
  private state: Library = { files: [], activeFileId: null, ready: false, busy: false }
  private listeners = new Set<() => void>()
  private initialization: Promise<void> | null = null
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  getSnapshot = () => this.state
  private emit(patch: Partial<Library>) {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((listener) => listener())
  }
  private persist() {
    const { files, activeFileId } = this.state
    // Optional device preferences; the file directory is derived from IndexedDB.
    try { localStorage.setItem(LIBRARY_KEY, JSON.stringify({ files, activeFileId })) } catch { /* No document data is stored here. */ }
  }
  initialize() {
    if (!this.initialization) this.initialization = this.open().catch((error) => { this.initialization = null; throw error })
    return this.initialization
  }
  private async open() {
    let library: Pick<Library, 'files' | 'activeFileId'> | null = null
    try {
      const raw = JSON.parse(localStorage.getItem(LIBRARY_KEY) ?? 'null')
      if (Array.isArray(raw?.files) && raw.files.some((file: BoardFile) => file.id === raw.activeFileId)) {
        // Flatten old project libraries while preserving every board and its storage ID.
        library = { files: pinnedFirst(raw.files.map((file: BoardFile) => ({ id: file.id, name: file.name, ...(file.pinned ? { pinned: true } : {}) }))), activeFileId: raw.activeFileId }
      }
    } catch { /* Start with the existing single-file document. */ }
    await initializeLocal()
    const stored = await localRepository.list()
    if (stored.length) {
      const hints = library
      const ids = hints?.files.map((file) => file.id) ?? []
      const files = pinnedFirst(stored.map((file) => ({ ...file, pinned: hints?.files.find((hint) => hint.id === file.id)?.pinned }))
        .sort((a, b) => {
          const left = ids.indexOf(a.id), right = ids.indexOf(b.id)
          return (left < 0 ? ids.length : left) - (right < 0 ? ids.length : right)
        }))
      library = { files, activeFileId: files.some((file) => file.id === hints?.activeFileId) ? hints!.activeFileId : files[0].id }
    } else library = null
    if (library) {
      const file = library.files.find((file) => file.id === library!.activeFileId)!
      const doc = await loadLocal(file.id)
      if (!doc) throw new Error('无法读取白板，请刷新重试')
      setActiveFile(file.id)
      this.applyDocument(doc)
      this.emit({ ...library, ready: true })
    } else {
      const file = { id: uid(), name: '我的白板' }
      const doc = { nodes: [], edges: [], meta: { name: file.name } }
      await saveCanvas(file.id, doc)
      setActiveFile(file.id)
      this.applyDocument(doc)
      this.emit({ files: [file], activeFileId: file.id, ready: true })
    }
    this.persist()
    documentStore.subscribe(() => {
      const name = documentStore.getSnapshot().meta?.name || '未命名画布'
      const current = this.state.files.find((file) => file.id === this.state.activeFileId)
      if (!current || current.name === name) return
      this.emit({ files: this.state.files.map((file) => file.id === current.id ? { ...file, name } : file) })
      this.persist()
    })
  }
  private applyDocument(doc: CanvasFile) {
    documentStore.load(doc)
    cameraStore.set(doc.meta?.camera ?? { x: 0, y: 0, zoom: 1 })
    markLoaded()
  }
  async switchFile(id: string) {
    if (id === this.state.activeFileId || this.state.busy) return
    if (!this.state.files.some((file) => file.id === id)) return
    this.emit({ busy: true })
    try {
      await saveLocal()
      const doc = await loadLocal(id)
      if (!doc) throw new Error('无法读取白板，请重试')
      setActiveFile(id)
      // Update the active ID before loading, so the name subscription sees the right file.
      this.emit({ activeFileId: id })
      this.applyDocument(doc)
      this.persist()
    } finally { this.emit({ busy: false }) }
  }
  private async readFile(id: string) {
    if (id === this.state.activeFileId) await saveLocal()
    const doc = await loadLocal(id)
    if (!doc) throw new Error('无法读取白板，请重试')
    return doc
  }
  private async addFile(name: string, content?: CanvasFile) {
    const file = { id: uid(), name }
    const doc = content ? { ...content, meta: { ...content.meta, name } } : { nodes: [], edges: [], meta: { name } }
    await saveCanvas(file.id, doc)
    setActiveFile(file.id)
    this.emit({ files: [...this.state.files, file], activeFileId: file.id })
    this.applyDocument(doc)
    this.persist()
    return file
  }
  async createFile(name = '未命名白板', content?: CanvasFile) {
    if (this.state.busy) return
    this.emit({ busy: true })
    try {
      await saveLocal()
      return await this.addFile(name, content)
    } finally { this.emit({ busy: false }) }
  }
  async renameFile(id: string, name: string) {
    if (this.state.busy || !this.state.files.some((file) => file.id === id)) return
    const value = name.trim() || '未命名白板'
    this.emit({ busy: true })
    try {
      if (id === this.state.activeFileId) {
        documentStore.rename(value)
        await saveLocal()
      } else {
        const doc = await this.readFile(id)
        await saveCanvas(id, { ...doc, meta: { ...doc.meta, name: value } })
      }
      this.emit({ files: this.state.files.map((file) => file.id === id ? { ...file, name: value } : file) })
      this.persist()
    } finally { this.emit({ busy: false }) }
  }
  async duplicateFile(id: string) {
    const file = this.state.files.find((file) => file.id === id)
    if (this.state.busy || !file) return
    this.emit({ busy: true })
    try {
      await saveLocal()
      return await this.addFile(`${file.name} 副本`, await this.readFile(id))
    } finally { this.emit({ busy: false }) }
  }
  async downloadFile(id: string) {
    if (this.state.busy || !this.state.files.some((file) => file.id === id)) return
    this.emit({ busy: true })
    try {
      const doc = id === this.state.activeFileId
        ? { ...documentStore.toJSON(), meta: { ...documentStore.getSnapshot().meta, camera: cameraStore.getSnapshot() } }
        : await loadLocal(id)
      if (!doc) throw new Error('无法读取白板')
      await downloadCanvasFile(doc)
    }
    finally { this.emit({ busy: false }) }
  }
  togglePin(id: string) {
    if (this.state.busy) return
    this.emit({ files: pinnedFirst(this.state.files.map((file) => file.id === id ? { ...file, pinned: !file.pinned } : file)) })
    this.persist()
  }
  async saveCopy() {
    if (this.state.busy) return
    this.emit({ busy: true })
    try {
      const sourceId = this.state.activeFileId
      const doc = documentStore.toJSON()
      doc.meta = { ...doc.meta, camera: cameraStore.getSnapshot() }
      await this.addFile(`${doc.meta.name || '白板'} 副本`, doc)
      if (sourceId) localRepository.clearJournal(sourceId)
    } finally { this.emit({ busy: false }) }
  }
  async deleteFile(id: string) {
    if (this.state.busy || !this.state.files.some((file) => file.id === id)) return
    this.emit({ busy: true })
    try {
      let files = this.state.files.filter((file) => file.id !== id)
      if (id === this.state.activeFileId) {
        const next = files[0] ?? { id: uid(), name: '未命名白板' }
        const doc = files.length ? await this.readFile(next.id) : { nodes: [], edges: [], meta: { name: next.name } }
        if (!files.length) { await saveCanvas(next.id, doc); files = [next] }
        await deleteLocalFile(id)
        setActiveFile(next.id)
        this.emit({ files, activeFileId: next.id })
        this.applyDocument(doc)
      } else {
        await loadLocal(id)
        await deleteLocalFile(id)
        this.emit({ files })
      }
      this.persist()
    } finally { this.emit({ busy: false }) }
  }
}
export const libraryStore = new LibraryStore()
