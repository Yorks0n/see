import type { CanvasEdge, CanvasFile, CanvasNode, NodeSide } from '../types'

type Listener = () => void

const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`)

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

const NODE_TYPES = new Set(['text', 'file', 'link', 'image', 'group', 'draw'])
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
    width: isFiniteNumber(n.width) ? Math.max(1, n.width) : 200,
    height: isFiniteNumber(n.height) ? Math.max(1, n.height) : 80,
    color: typeof n.color === 'string' ? (n.color as CanvasNode['color']) : undefined,
  }
  switch (n.type) {
    case 'text':
      return { ...base, type: 'text', text: typeof n.text === 'string' ? n.text : '' }
    case 'file':
      return { ...base, type: 'file', file: typeof n.file === 'string' ? n.file : '', subpath: typeof n.subpath === 'string' ? n.subpath : undefined }
    case 'link':
      return { ...base, type: 'link', url: typeof n.url === 'string' ? n.url : '' }
    case 'image': {
      const c = n.crop as Record<string, unknown> | undefined
      const crop = c && isFiniteNumber(c.x) && isFiniteNumber(c.y) && isFiniteNumber(c.width) && isFiniteNumber(c.height)
        && c.x >= 0 && c.y >= 0 && c.width > 0 && c.height > 0 && c.x + c.width <= 1.001 && c.y + c.height <= 1.001
        ? { x: c.x, y: c.y, width: c.width, height: c.height } : undefined
      return {
        ...base,
        type: 'image',
        url: typeof n.url === 'string' ? n.url : '',
        text: typeof n.text === 'string' ? n.text : undefined,
        naturalWidth: isFiniteNumber(n.naturalWidth) && n.naturalWidth > 0 ? n.naturalWidth : undefined,
        naturalHeight: isFiniteNumber(n.naturalHeight) && n.naturalHeight > 0 ? n.naturalHeight : undefined,
        crop,
      }
    }
    case 'group':
      return {
        ...base, type: 'group', label: typeof n.label === 'string' ? n.label : undefined,
        memberIds: Array.isArray(n.memberIds) ? n.memberIds.filter((id): id is string => typeof id === 'string' && id !== n.id) : undefined,
        background: typeof n.background === 'string' ? n.background : undefined,
        backgroundStyle: ['cover', 'ratio', 'repeat', 'center'].includes(n.backgroundStyle as string)
          ? n.backgroundStyle as import('../types').BackgroundStyle : undefined,
      }
    case 'draw': {
      const points = Array.isArray(n.points)
        ? n.points
            .filter((p): p is { x: number; y: number } =>
              !!p && typeof p === 'object' && isFiniteNumber((p as any).x) && isFiniteNumber((p as any).y),
            )
            .map((p) => ({ x: p.x, y: p.y }))
        : []
      return { ...base, type: 'draw', points, strokeWidth: isFiniteNumber(n.strokeWidth) ? Math.max(1, Math.min(24, n.strokeWidth)) : 3 }
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
    labelIsVisible: typeof e.labelIsVisible === 'boolean' ? e.labelIsVisible : undefined,
    labelOffset: e.labelOffset && typeof e.labelOffset === 'object' && isFiniteNumber((e.labelOffset as Record<string, unknown>).x) && isFiniteNumber((e.labelOffset as Record<string, unknown>).y)
      ? { x: (e.labelOffset as { x: number }).x, y: (e.labelOffset as { y: number }).y } : undefined,
    lineStyle: e.lineStyle === 'curve' || e.lineStyle === 'straight' ? e.lineStyle : undefined,
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

export class DocumentStore {
  private doc: CanvasFile = { nodes: [], edges: [], meta: { name: '未命名画布', app: 'whiteboard', appVersion: '0.1.0' } }
  private listeners = new Set<Listener>()
  private past: CanvasFile[] = []
  private future: CanvasFile[] = []
  private interaction: CanvasFile | null = null

  get canUndo() { return this.past.length > 0 }
  get canRedo() { return this.future.length > 0 }

  private commit(next: CanvasFile) {
    if (!this.interaction) {
      this.past = [...this.past.slice(-79), this.doc]
      this.future = []
    }
    this.doc = next
    this.emit()
  }

  beginInteraction() {
    if (!this.interaction) this.interaction = this.doc
  }
  endInteraction() {
    if (!this.interaction) return
    if (this.doc !== this.interaction) {
      this.past = [...this.past.slice(-79), this.interaction]
      this.future = []
    }
    this.interaction = null
    this.emit()
  }
  cancelInteraction() {
    if (!this.interaction) return
    this.doc = this.interaction
    this.interaction = null
    this.emit()
  }
  transact(action: () => void) {
    const nested = !!this.interaction
    if (!nested) this.beginInteraction()
    try { action() } finally { if (!nested) this.endInteraction() }
  }
  undo() {
    this.endInteraction()
    const previous = this.past.pop()
    if (!previous) return
    this.future.push(this.doc)
    this.doc = previous
    this.emit()
  }
  redo() {
    const next = this.future.pop()
    if (!next) return
    this.past.push(this.doc)
    this.doc = next
    this.emit()
  }

  subscribe = (l: Listener) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  getSnapshot = (): CanvasFile => this.doc
  private emit() {
    this.doc = { ...this.doc }
    this.listeners.forEach((l) => l())
  }

  load(file: CanvasFile) {
    this.doc = restoreCanvas(file)
    this.past = []
    this.future = []
    this.interaction = null
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
    this.commit({ ...this.doc, nodes: [...(this.doc.nodes ?? []), node] })
    return node
  }
  updateNode(id: string, patch: Partial<CanvasNode>) {
    const node = this.getNode(id)
    if (!node || Object.entries(patch).every(([key, value]) => (node as unknown as Record<string, unknown>)[key] === value)) return
    this.commit({
      ...this.doc,
      nodes: (this.doc.nodes ?? []).map((n) => (n.id === id ? ({ ...n, ...patch, id: n.id, type: n.type } as CanvasNode) : n)),
    })
  }
  updateNodes(patches: Map<string, Partial<CanvasNode>>) {
    if (patches.size === 0) return
    this.commit({ ...this.doc, nodes: (this.doc.nodes ?? []).map((n) => {
      const patch = patches.get(n.id)
      return patch ? { ...n, ...patch, id: n.id, type: n.type } as CanvasNode : n
    }) })
  }
  updateTextLayout(id: string, height: number) {
    const node = this.getNode(id)
    if (node?.type !== 'text' || height <= node.height) return
    // Content measurement should not create a second undo step after typing.
    const measure = (doc: CanvasFile): CanvasFile => ({
      ...doc,
      nodes: doc.nodes?.map((n) => n.id === id && n.type === 'text' && n.text === node.text && n.width === node.width && n.height < height
        ? { ...n, height } : n),
    })
    this.doc = measure(this.doc)
    this.past = this.past.map(measure)
    this.future = this.future.map(measure)
    if (this.interaction) this.interaction = measure(this.interaction)
    this.emit()
  }
  initializeImage(id: string, naturalWidth: number, naturalHeight: number) {
    // Image decoding is metadata hydration, not a separate user action.
    const hydrate = (doc: CanvasFile): CanvasFile => ({
      ...doc,
      nodes: doc.nodes?.map((node) => node.id === id && node.type === 'image' && !node.naturalWidth
        ? {
            ...node, naturalWidth, naturalHeight,
            ...(!node.crop && node.width === 280 && node.height === 180
              ? { height: node.width * naturalHeight / naturalWidth } : {}),
          }
        : node),
    })
    this.doc = hydrate(this.doc)
    this.past = this.past.map(hydrate)
    this.future = this.future.map(hydrate)
    if (this.interaction) this.interaction = hydrate(this.interaction)
    this.emit()
  }
  deleteNode(id: string) {
    this.commit({
      ...this.doc,
      nodes: (this.doc.nodes ?? []).filter((n) => n.id !== id).map((n) =>
        n.type === 'group' && n.memberIds?.includes(id) ? { ...n, memberIds: n.memberIds.filter((member) => member !== id) } : n),
      edges: (this.doc.edges ?? []).filter((e) => e.fromNode !== id && e.toNode !== id),
    })
  }

  addEdge(edge: CanvasEdge) {
    this.commit({ ...this.doc, edges: [...(this.doc.edges ?? []), edge] })
    return edge
  }
  updateEdge(id: string, patch: Partial<CanvasEdge>) {
    this.commit({
      ...this.doc,
      edges: (this.doc.edges ?? []).map((e) => (e.id === id ? { ...e, ...patch, id: e.id } : e)),
    })
  }
  deleteEdge(id: string) {
    this.commit({ ...this.doc, edges: (this.doc.edges ?? []).filter((e) => e.id !== id) })
  }

  bringToFront(id: string) {
    const nodes = this.doc.nodes ?? []
    const node = nodes.find((n) => n.id === id)
    if (!node) return
    if (nodes[nodes.length - 1]?.id === id) return
    this.commit({ ...this.doc, nodes: [...nodes.filter((n) => n.id !== id), node] })
  }
  sendToBack(id: string) {
    const node = this.getNode(id)
    if (!node) return
    this.commit({ ...this.doc, nodes: [node, ...(this.doc.nodes ?? []).filter((n) => n.id !== id)] })
  }
}

export const documentStore = new DocumentStore()
export { uid }
