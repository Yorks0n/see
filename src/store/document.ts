import type { CanvasEdge, CanvasFile, CanvasNode, NodeSide } from '../types'

type Listener = () => void

const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`)

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

const NODE_TYPES = new Set(['text', 'file', 'link', 'group', 'draw'])
const SIDES: NodeSide[] = ['top', 'right', 'bottom', 'left']

export function restoreNode(raw: unknown): CanvasNode | null {
  if (!raw || typeof raw !== 'object') return null
  const n = raw as Record<string, unknown>
  if (typeof n.id !== 'string' || typeof n.type !== 'string') return null
  if (!NODE_TYPES.has(n.type)) return null
  if (!isFiniteNumber(n.x) || !isFiniteNumber(n.y)) return null
  const base = {
    id: n.id,
    type: n.type,
    x: n.x,
    y: n.y,
    width: isFiniteNumber(n.width) ? n.width : 200,
    height: isFiniteNumber(n.height) ? n.height : 80,
    color: typeof n.color === 'string' ? (n.color as CanvasNode['color']) : undefined,
  }
  switch (n.type) {
    case 'text':
      return { ...base, type: 'text', text: typeof n.text === 'string' ? n.text : '' }
    case 'file':
      return { ...base, type: 'file', file: typeof n.file === 'string' ? n.file : '' }
    case 'link':
      return { ...base, type: 'link', url: typeof n.url === 'string' ? n.url : '' }
    case 'group':
      return { ...base, type: 'group', label: typeof n.label === 'string' ? n.label : undefined }
    case 'draw': {
      const points = Array.isArray(n.points)
        ? n.points
            .filter((p): p is { x: number; y: number } =>
              !!p && typeof p === 'object' && isFiniteNumber((p as any).x) && isFiniteNumber((p as any).y),
            )
            .map((p) => ({ x: p.x, y: p.y }))
        : []
      return { ...base, type: 'draw', points }
    }
    default:
      return null
  }
}

export function restoreEdge(raw: unknown, nodeIds: Set<string>): CanvasEdge | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  if (typeof e.id !== 'string') return null
  if (typeof e.fromNode !== 'string' || typeof e.toNode !== 'string') return null
  if (!nodeIds.has(e.fromNode) || !nodeIds.has(e.toNode)) return null
  const side = (v: unknown): NodeSide | undefined =>
    typeof v === 'string' && (SIDES as string[]).includes(v) ? (v as NodeSide) : undefined
  return {
    id: e.id,
    fromNode: e.fromNode,
    fromSide: side(e.fromSide),
    fromEnd: e.fromEnd === 'arrow' || e.fromEnd === 'none' ? e.fromEnd : undefined,
    toNode: e.toNode,
    toSide: side(e.toSide),
    toEnd: e.toEnd === 'arrow' || e.toEnd === 'none' ? e.toEnd : undefined,
    color: typeof e.color === 'string' ? (e.color as CanvasEdge['color']) : undefined,
    label: typeof e.label === 'string' ? e.label : undefined,
  }
}

export function restoreCanvas(raw: unknown): CanvasFile {
  const doc = (raw && typeof raw === 'object' ? raw : {}) as CanvasFile
  const nodes = (Array.isArray(doc.nodes) ? doc.nodes : [])
    .map(restoreNode)
    .filter((n): n is CanvasNode => n !== null)
  const nodeIds = new Set(nodes.map((n) => n.id))
  const edges = (Array.isArray(doc.edges) ? doc.edges : [])
    .map((e) => restoreEdge(e, nodeIds))
    .filter((e): e is CanvasEdge => e !== null)
  return { nodes, edges, meta: doc.meta && typeof doc.meta === 'object' ? doc.meta : {} }
}

const HISTORY_LIMIT = 100

export class DocumentStore {
  private doc: CanvasFile = { nodes: [], edges: [], meta: { name: '未命名画布', app: 'whiteboard', appVersion: '0.1.0' } }
  private listeners = new Set<Listener>()
  private past: CanvasFile[] = []
  private future: CanvasFile[] = []

  subscribe = (l: Listener) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  getSnapshot = (): CanvasFile => this.doc
  private emit() {
    this.doc = { ...this.doc }
    this.listeners.forEach((l) => l())
  }

  private clone(): CanvasFile {
    return JSON.parse(JSON.stringify(this.doc))
  }

  checkpoint() {
    this.past.push(this.clone())
    if (this.past.length > HISTORY_LIMIT) this.past.shift()
    this.future = []
  }

  undo() {
    const prev = this.past.pop()
    if (!prev) return
    this.future.push(this.clone())
    this.doc = prev
    this.emit()
  }

  redo() {
    const next = this.future.pop()
    if (!next) return
    this.past.push(this.clone())
    this.doc = next
    this.emit()
  }

  canUndo() {
    return this.past.length > 0
  }
  canRedo() {
    return this.future.length > 0
  }

  load(file: CanvasFile) {
    this.doc = restoreCanvas(file)
    this.past = []
    this.future = []
    this.emit()
  }
  toJSON(): CanvasFile {
    return JSON.parse(JSON.stringify(this.doc))
  }

  getNode(id: string) {
    return this.doc.nodes?.find((n) => n.id === id)
  }
  getEdge(id: string) {
    return this.doc.edges?.find((e) => e.id === id)
  }

  addNode(node: CanvasNode) {
    this.checkpoint()
    this.doc = { ...this.doc, nodes: [...(this.doc.nodes ?? []), node] }
    this.emit()
    return node
  }
  updateNode(id: string, patch: Partial<CanvasNode>, opts?: { transient?: boolean }) {
    if (!opts?.transient) this.checkpoint()
    this.doc = {
      ...this.doc,
      nodes: (this.doc.nodes ?? []).map((n) => (n.id === id ? ({ ...n, ...patch, id: n.id, type: n.type } as CanvasNode) : n)),
    }
    this.emit()
  }
  deleteNode(id: string) {
    this.checkpoint()
    this.doc = {
      ...this.doc,
      nodes: (this.doc.nodes ?? []).filter((n) => n.id !== id),
      edges: (this.doc.edges ?? []).filter((e) => e.fromNode !== id && e.toNode !== id),
    }
    this.emit()
  }

  addEdge(edge: CanvasEdge) {
    this.checkpoint()
    this.doc = { ...this.doc, edges: [...(this.doc.edges ?? []), edge] }
    this.emit()
    return edge
  }
  updateEdge(id: string, patch: Partial<CanvasEdge>) {
    this.checkpoint()
    this.doc = {
      ...this.doc,
      edges: (this.doc.edges ?? []).map((e) => (e.id === id ? { ...e, ...patch, id: e.id } : e)),
    }
    this.emit()
  }
  deleteEdge(id: string) {
    this.checkpoint()
    this.doc = { ...this.doc, edges: (this.doc.edges ?? []).filter((e) => e.id !== id) }
    this.emit()
  }

  bringToFront(id: string) {
    const nodes = this.doc.nodes ?? []
    const node = nodes.find((n) => n.id === id)
    if (!node) return
    this.doc = { ...this.doc, nodes: [...nodes.filter((n) => n.id !== id), node] }
    this.emit()
  }
}

export const documentStore = new DocumentStore()
export { uid }
