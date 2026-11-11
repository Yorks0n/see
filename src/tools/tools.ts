import { cameraStore } from '../store/camera'
import { documentStore, uid } from '../store/document'
import { preferencesStore } from '../store/preferences'
import { hitTest } from '../render/renderer'
import type { CanvasColor, CanvasNode, DrawNode, DrawPoint, GroupNode, ImageNode, TextNode } from '../types'
import { arrangement, type ArrangeMode } from './layout'

export type ToolId = 'select' | 'box' | 'draw' | 'hand' | 'list' | 'rectangle' | 'laser'
export interface DrawStyle { color?: CanvasColor; strokeWidth: number }
export interface ToolEnv {
  selection: Set<string>
  setSelection: (s: Set<string>) => void
  selectionOutline: boolean
  setSelectionOutline: (outline: boolean) => void
  setDragPreview: (p: { fromId: string; to: { x: number; y: number }; targetId?: string } | null) => void
  setMarquee: (m: { x: number; y: number; width: number; height: number } | null) => void
  setPaintTrail: (points: DrawPoint[] | null) => void
  addLaserPoint: (point: DrawPoint, start: boolean) => void
  setEditingId: (id: string | null) => void
  setTool: (t: ToolId) => void
  drawStyle: DrawStyle
}
export interface PointerInfo {
  screen: { x: number; y: number }
  world: { x: number; y: number }
  shiftKey: boolean
  altKey?: boolean
  nodeId?: string
}
interface DragState {
  type: 'pan' | 'move' | 'marquee' | 'connect' | 'box' | 'draw' | 'rectangle' | 'laser'
  startWorld: { x: number; y: number }
  startScreen: { x: number; y: number }
  originCamera?: { x: number; y: number }
  origins?: Map<string, { x: number; y: number }>
  initialSelection?: Set<string>
  initialSelectionOutline?: boolean
  currentWorld?: DrawPoint
  selectionMode?: 'paint' | 'box'
  paintedSelection?: Set<string>
  paintTrail?: DrawPoint[]
  fromId?: string
  rect?: { x: number; y: number; width: number; height: number }
  points?: { x: number; y: number }[]
  moved?: boolean
  duplicateSelection?: Set<string>
}
export class ToolState { dragging: DragState | null = null }
export interface Tool {
  id: ToolId
  onPointerDown?(info: PointerInfo, env: ToolEnv, state: ToolState): void
  onPointerMove?(info: PointerInfo, env: ToolEnv, state: ToolState): void
  onPointerUp?(info: PointerInfo, env: ToolEnv, state: ToolState): void
  onDoubleClick?(info: PointerInfo, env: ToolEnv): void
}

const topHitAt = (world: { x: number; y: number }) => hitTest(documentStore.getSnapshot(), world.x, world.y, 7 / cameraStore.getSnapshot().zoom)
export const contains = (outer: Pick<CanvasNode, 'x' | 'y' | 'width' | 'height'>, inner: CanvasNode) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height

export function expandSelection(ids: Set<string>): Set<string> {
  const result = new Set(ids)
  const nodes = documentStore.getSnapshot().nodes ?? []
  const visit = (id: string) => {
    const group = documentStore.getNode(id)
    if (group?.type !== 'group') return
    for (const node of nodes) {
      if (result.has(node.id)) continue
      if (group.memberIds ? group.memberIds.includes(node.id) : contains(group, node)) {
        result.add(node.id)
        visit(node.id)
      }
    }
  }
  ids.forEach(visit)
  return result
}
export function deleteNodes(ids: Set<string>) {
  documentStore.transact(() => ids.forEach((id) => documentStore.deleteNode(id)))
}
export function createTextCard(world: { x: number; y: number }): TextNode {
  const node: TextNode = { id: uid(), type: 'text', x: Math.round(world.x - 100), y: Math.round(world.y - 30), width: 200, height: 64, text: '', color: preferencesStore.getSnapshot().textColor }
  documentStore.transact(() => { documentStore.addNode(node); updateMembership([node.id]) })
  return node
}
export function viewportCenterWorld() {
  const board = document.querySelector('.board') as HTMLElement | null
  return cameraStore.screenToWorld((board?.clientWidth ?? window.innerWidth) / 2, (board?.clientHeight ?? window.innerHeight) / 2)
}
export function duplicateNodes(ids: Set<string>, offset = 24): Set<string> {
  const now = documentStore.getSnapshot()
  const all = expandSelection(ids)
  const idMap = new Map([...all].map((id) => [id, uid()]))
  documentStore.transact(() => {
    for (const n of now.nodes ?? []) {
      const id = idMap.get(n.id)
      if (!id) continue
      const copy = { ...n, id, x: n.x + offset, y: n.y + offset }
      if (copy.type === 'group') copy.memberIds = (copy.memberIds ?? []).map((member) => idMap.get(member)).filter((member): member is string => !!member)
      documentStore.addNode(copy)
    }
    for (const e of now.edges ?? []) {
      const from = idMap.get(e.fromNode), to = idMap.get(e.toNode)
      if (from && to) documentStore.addEdge({ ...e, id: uid(), fromNode: from, toNode: to })
    }
    updateMembership(idMap.values())
  })
  return new Set([...ids].map((id) => idMap.get(id)!).filter(Boolean))
}
export function createImageCard(world: { x: number; y: number }, url: string): ImageNode {
  const node: ImageNode = { id: uid(), type: 'image', x: Math.round(world.x - 140), y: Math.round(world.y - 100), width: 280, height: 180, url }
  documentStore.transact(() => { documentStore.addNode(node); updateMembership([node.id]) })
  return node
}
export function groupNodes(ids: Set<string>): GroupNode | null {
  const nodes = (documentStore.getSnapshot().nodes ?? []).filter((n) => ids.has(n.id))
  if (!nodes.length) return null
  const x = Math.min(...nodes.map((n) => n.x)) - 28
  const y = Math.min(...nodes.map((n) => n.y)) - 28
  const group: GroupNode = { id: uid(), type: 'group', x, y, width: Math.max(...nodes.map((n) => n.x + n.width)) - x + 28, height: Math.max(...nodes.map((n) => n.y + n.height)) - y + 28, label: '分组', memberIds: nodes.map((n) => n.id) }
  documentStore.transact(() => { documentStore.addNode(group); updateMembership([group.id]) })
  return group
}
export function createList(rect: { x: number; y: number; width: number; height: number }, ids = new Set<string>()) {
  const members = (documentStore.getSnapshot().nodes ?? []).filter((n) => ids.has(n.id) && (n.type === 'text' || n.type === 'image')).sort((a, b) => a.y - b.y || a.x - b.x)
  const list: GroupNode = { id: uid(), type: 'group', ...rect, width: Math.max(200, rect.width), minHeight: Math.max(140, rect.height), layout: 'list', label: '列表', memberIds: members.map((n) => n.id) }
  documentStore.transact(() => {
    // A card belongs to a single container.
    for (const group of documentStore.getSnapshot().nodes ?? []) {
      if (group.type === 'group' && group.memberIds?.some((id) => ids.has(id))) documentStore.updateNode(group.id, { memberIds: group.memberIds.filter((id) => !ids.has(id)) })
    }
    documentStore.addNode(list)
  })
  return list
}
export function listFromSelection(ids: Set<string>) {
  const nodes = (documentStore.getSnapshot().nodes ?? []).filter((n) => ids.has(n.id) && (n.type === 'text' || n.type === 'image'))
  if (!nodes.length) return null
  return createList({ x: Math.min(...nodes.map((n) => n.x)) - 16, y: Math.min(...nodes.map((n) => n.y)) - 44, width: Math.max(...nodes.map((n) => n.width)) + 32, height: 140 }, ids)
}
export function ungroupNodes(ids: Set<string>) {
  const next = new Set<string>()
  documentStore.transact(() => {
    for (const id of ids) {
      const node = documentStore.getNode(id)
      if (node?.type === 'group') { node.memberIds?.forEach((member) => next.add(member)); documentStore.deleteNode(id) }
      else next.add(id)
    }
  })
  return next
}
export function arrangeNodes(ids: Set<string>, mode: ArrangeMode) {
  documentStore.transact(() => {
    documentStore.updateNodes(arrangement((documentStore.getSnapshot().nodes ?? []).filter((n) => ids.has(n.id) && (n.type === 'text' || n.type === 'image')), mode))
    updateMembership(ids)
  })
}
export function startConnection(fromId: string, info: PointerInfo, env: ToolEnv, state: ToolState) {
  state.dragging = { type: 'connect', startWorld: info.world, startScreen: info.screen, fromId, moved: false }
  env.setSelection(new Set([fromId]))
  env.setDragPreview({ fromId, to: info.world })
}
export function moveConnection(info: PointerInfo, env: ToolEnv, state: ToolState) {
  const d = state.dragging
  if (d?.type !== 'connect' || !d.fromId) return
  if (Math.hypot(info.screen.x - d.startScreen.x, info.screen.y - d.startScreen.y) > 5) d.moved = true
  const target = topHitAt(info.world)
  env.setDragPreview({ fromId: d.fromId, to: info.world, targetId: target?.id !== d.fromId && target?.type !== 'group' && target?.type !== 'draw' ? target?.id : undefined })
}
export function finishConnection(info: PointerInfo, env: ToolEnv, state: ToolState) {
  const d = state.dragging
  env.setDragPreview(null)
  if (d?.type === 'connect' && d.fromId && d.moved) {
    let target = topHitAt(info.world)
    if (!target || target.type === 'group') {
      target = createTextCard({ x: info.world.x + 100, y: info.world.y + 30 })
      env.setSelection(new Set([target.id]))
      env.setEditingId(target.id)
    }
    if (target.id !== d.fromId && target.type !== 'draw') {
      const duplicate = documentStore.getSnapshot().edges?.some((e) => (e.fromNode === d.fromId && e.toNode === target!.id) || (e.toNode === d.fromId && e.fromNode === target!.id))
      if (!duplicate) documentStore.addEdge({ id: uid(), fromNode: d.fromId, toNode: target.id, fromEnd: 'none', toEnd: 'none', color: preferencesStore.getSnapshot().connectionColor })
    }
  }
  state.dragging = null
}

export function splitImageCaption(id: string, text: string): TextNode | null {
  const image = documentStore.getNode(id)
  if (image?.type !== 'image' || !text.trim()) return null
  let card: TextNode
  documentStore.transact(() => {
    card = createTextCard({ x: image.x + 100, y: image.y + image.height + 54 })
    documentStore.updateNode(card.id, { text, width: Math.max(80, image.width) })
    documentStore.updateNode(image.id, { text: undefined })
    updateMembership([card.id])
  })
  return documentStore.getNode(card!.id) as TextNode
}

export function updateMembership(ids: Iterable<string>, drop?: DrawPoint) {
  const nodes = documentStore.getSnapshot().nodes ?? []
  const movedIds = new Set(ids)
  const groups = nodes.filter((n): n is GroupNode => n.type === 'group')
  const patches = new Map<string, Partial<CanvasNode>>()
  const memberships = new Map(groups.map((g) => [g.id, [...(g.memberIds ?? nodes.filter((n) => n.id !== g.id && contains(g, n)).map((n) => n.id))]]))
  for (const id of movedIds) {
    const n = documentStore.getNode(id)
    if (!n) continue
    const descendants = expandSelection(new Set([id]))
    // Moving a container keeps its descendants attached.
    if (groups.some((g) => movedIds.has(g.id) && g.memberIds?.includes(id))) continue
    const parent = groups.filter((g) => {
      if (descendants.has(g.id)) return false
      if (g.layout !== 'list') return contains(g, n)
      if (n.type !== 'text' && n.type !== 'image') return false
      const point = drop ?? { x: n.x + n.width / 2, y: n.y + n.height / 2 }
      return point.x >= g.x && point.x <= g.x + g.width && point.y >= g.y && point.y <= g.y + g.height
    }).sort((a, b) =>
      a.width * a.height - b.width * b.height || Number(!!b.memberIds?.includes(id)) - Number(!!a.memberIds?.includes(id)))[0]
    for (const g of groups) {
      const members = memberships.get(g.id)!.filter((member) => member !== id)
      if (parent?.id === g.id) members.push(id)
      memberships.set(g.id, members)
    }
  }
  for (const g of groups) {
    const memberIds = memberships.get(g.id)!
    if (g.layout === 'list') memberIds.sort((a, b) => {
      const first = documentStore.getNode(a)!, second = documentStore.getNode(b)!
      const position = (n: CanvasNode) => movedIds.has(n.id) ? (drop?.y ?? n.y + n.height / 2) : n.y + n.height / 2
      return position(first) - position(second) || first.y - second.y || first.x - second.x
    })
    if (JSON.stringify(memberIds) !== JSON.stringify(g.memberIds ?? [])) patches.set(g.id, { memberIds })
  }
  documentStore.updateNodes(patches)
}

function segmentHitsRect(from: DrawPoint, to: DrawPoint, rect: { x: number; y: number; width: number; height: number }, padding: number) {
  let start = 0, end = 1
  for (const axis of ['x', 'y'] as const) {
    const min = rect[axis] - padding, max = rect[axis] + (axis === 'x' ? rect.width : rect.height) + padding
    const delta = to[axis] - from[axis]
    if (!delta) {
      if (from[axis] < min || from[axis] > max) return false
    } else {
      const a = (min - from[axis]) / delta, b = (max - from[axis]) / delta
      start = Math.max(start, Math.min(a, b)); end = Math.min(end, Math.max(a, b))
      if (start > end) return false
    }
  }
  return true
}

function updateSelectionDrag(info: PointerInfo, env: ToolEnv, state: ToolState) {
  const d = state.dragging
  if (d?.type !== 'marquee') return
  const nodes = documentStore.getSnapshot().nodes ?? []
  const previous = d.selectionMode === 'paint' ? d.currentWorld ?? d.startWorld : info.world
  d.currentWorld = info.world
  env.setSelectionOutline(info.shiftKey)
  if (info.shiftKey) {
    d.selectionMode = 'box'
    d.rect = { x: Math.min(d.startWorld.x, info.world.x), y: Math.min(d.startWorld.y, info.world.y), width: Math.abs(info.world.x - d.startWorld.x), height: Math.abs(info.world.y - d.startWorld.y) }
    const selected = new Set(d.initialSelection)
    for (const n of nodes) if (contains(d.rect, n)) selected.add(n.id)
    env.setSelection(selected)
    env.setMarquee(d.rect); env.setPaintTrail(null)
  } else {
    const zoom = cameraStore.getSnapshot().zoom, radius = 10 / zoom
    const steps = Math.max(1, Math.ceil(Math.hypot(info.world.x - previous.x, info.world.y - previous.y) * zoom / 5))
    d.selectionMode = 'paint'
    const selected = d.paintedSelection ??= new Set<string>()
    for (const n of nodes) {
      if (n.type === 'group' || selected.has(n.id) || !segmentHitsRect(previous, info.world, n, radius + (n.type === 'draw' ? (n.strokeWidth ?? 3) / 2 : 0))) continue
      if (n.type !== 'draw' && n.type !== 'rectangle') { selected.add(n.id); continue }
      for (let i = 0; i <= steps; i++) {
        const t = i / steps
        if (hitTest({ nodes: [n] }, previous.x + (info.world.x - previous.x) * t, previous.y + (info.world.y - previous.y) * t, radius)) { selected.add(n.id); break }
      }
    }
    const trail = d.paintTrail ??= []
    if (previous === info.world) trail.length = 0
    for (let i = Math.max(1, steps - 31); i <= steps; i++) {
      const t = i / steps
      const point = { x: previous.x + (info.world.x - previous.x) * t, y: previous.y + (info.world.y - previous.y) * t }
      const last = trail[trail.length - 1]
      if (!last || last.x !== point.x || last.y !== point.y) trail.push(point)
    }
    d.paintTrail = trail.slice(-32)
    env.setSelection(new Set(selected))
    env.setMarquee(null); env.setPaintTrail(d.paintTrail)
  }
}

export const tools: Record<ToolId, Tool> = {
  laser: {
    id: 'laser',
    onPointerDown(info, env, state) {
      state.dragging = { type: 'laser', startWorld: info.world, startScreen: info.screen }
      env.addLaserPoint(info.world, true)
    },
    onPointerMove(info, env, state) {
      if (state.dragging?.type === 'laser') env.addLaserPoint(info.world, false)
    },
    onPointerUp(info, env, state) {
      if (state.dragging?.type === 'laser') env.addLaserPoint(info.world, false)
      state.dragging = null
    },
  },
  hand: {
    id: 'hand',
    onPointerDown(info, _env, state) {
      const cam = cameraStore.getSnapshot()
      state.dragging = { type: 'pan', startWorld: info.world, startScreen: info.screen, originCamera: { x: cam.x, y: cam.y } }
    },
    onPointerMove(info, _env, state) {
      const d = state.dragging
      if (d?.type === 'pan' && d.originCamera) cameraStore.set({ x: d.originCamera.x + info.screen.x - d.startScreen.x, y: d.originCamera.y + info.screen.y - d.startScreen.y })
    },
    onPointerUp(_info, _env, state) { state.dragging = null },
  },
  select: {
    id: 'select',
    onPointerDown(info, env, state) {
      const hit = (info.nodeId ? documentStore.getNode(info.nodeId) : null) ?? topHitAt(info.world)
      if (hit) {
        if (info.shiftKey) env.setSelectionOutline(true)
        else if (!env.selection.has(hit.id)) env.setSelectionOutline(false)
        const sel = info.shiftKey ? new Set(env.selection) : env.selection.has(hit.id) ? new Set(env.selection) : new Set<string>()
        if (info.shiftKey && sel.has(hit.id)) { sel.delete(hit.id); env.setSelection(sel); return }
        sel.add(hit.id)
        env.setSelection(sel)
        const origins = new Map<string, { x: number; y: number }>()
        for (const id of expandSelection(sel)) {
          const n = documentStore.getNode(id)
          if (n) origins.set(id, { x: n.x, y: n.y })
        }
        state.dragging = { type: 'move', startWorld: info.world, startScreen: info.screen, origins, moved: false, duplicateSelection: info.altKey ? sel : undefined }
      } else {
        const initialSelection = new Set(env.selection)
        if (!info.shiftKey) env.setSelection(new Set())
        state.dragging = { type: 'marquee', startWorld: info.world, startScreen: info.screen, currentWorld: info.world, initialSelection, initialSelectionOutline: env.selectionOutline, selectionMode: info.shiftKey ? 'box' : 'paint', paintedSelection: new Set(), paintTrail: [info.world] }
        env.setSelectionOutline(info.shiftKey)
        if (info.shiftKey) env.setMarquee({ ...info.world, width: 0, height: 0 })
        else env.setPaintTrail([info.world])
      }
    },
    onPointerMove(info, env, state) {
      const d = state.dragging
      if (d?.type === 'move' && d.origins) {
        let dx = info.world.x - d.startWorld.x, dy = info.world.y - d.startWorld.y
        if (Math.hypot(info.screen.x - d.startScreen.x, info.screen.y - d.startScreen.y) > 3) d.moved = true
        if (d.moved && d.duplicateSelection) {
          d.initialSelection = d.duplicateSelection
          const copies = duplicateNodes(d.duplicateSelection, 0)
          d.duplicateSelection = undefined
          env.setSelection(copies)
          d.origins = new Map([...expandSelection(copies)].map((id) => {
            const node = documentStore.getNode(id)!
            return [id, { x: node.x, y: node.y }]
          }))
        }
        if (info.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0 }
        if (d.moved) documentStore.updateNodes(new Map([...d.origins].map(([id, origin]) => [id, { x: Math.round(origin.x + dx), y: Math.round(origin.y + dy) }])))
      } else if (d?.type === 'marquee') {
        updateSelectionDrag(info, env, state)
      }
    },
    onPointerUp(info, env, state) {
      const d = state.dragging
      if (d?.type === 'move') tools.select.onPointerMove?.(info, env, state)
      if (d?.type === 'marquee') {
        updateSelectionDrag(info, env, state)
        env.setMarquee(null); env.setPaintTrail(null)
      }
      if (d?.type === 'move' && d.moved && d.origins) updateMembership(d.origins.keys(), info.world)
      state.dragging = null
    },
    onDoubleClick(info, env) {
      const hit = (info.nodeId ? documentStore.getNode(info.nodeId) : null) ?? topHitAt(info.world)
      if (hit && (hit.type === 'text' || hit.type === 'group')) env.setEditingId(hit.id)
    },
  },
  box: {
    id: 'box',
    onPointerDown(info, _env, state) { state.dragging = { type: 'box', startWorld: info.world, startScreen: info.screen, rect: { ...info.world, width: 0, height: 0 } } },
    onPointerMove(info, env, state) {
      const d = state.dragging
      if (d?.type !== 'box') return
      d.rect = { x: Math.min(d.startWorld.x, info.world.x), y: Math.min(d.startWorld.y, info.world.y), width: Math.abs(info.world.x - d.startWorld.x), height: Math.abs(info.world.y - d.startWorld.y) }
      env.setMarquee(d.rect)
    },
    onPointerUp(_info, env, state) {
      const d = state.dragging
      env.setMarquee(null)
      if (d?.type === 'box' && d.rect && d.rect.width > 20 && d.rect.height > 20) {
        const g: GroupNode = { id: uid(), type: 'group', ...d.rect, label: '分组', memberIds: [] }
        g.memberIds = (documentStore.getSnapshot().nodes ?? []).filter((n) => contains(g, n)).map((n) => n.id)
        documentStore.addNode(g)
        updateMembership([g.id])
        env.setSelection(new Set([g.id]))
        env.setTool('select')
      }
      state.dragging = null
    },
  },
  list: {
    id: 'list',
    onPointerDown(info, env, state) { tools.box.onPointerDown?.(info, env, state) },
    onPointerMove(info, env, state) { tools.box.onPointerMove?.(info, env, state) },
    onPointerUp(_info, env, state) {
      const rect = state.dragging?.rect
      env.setMarquee(null)
      if (rect && rect.width > 20 && rect.height > 20) {
        const ids = new Set((documentStore.getSnapshot().nodes ?? []).filter((n) => contains(rect, n)).map((n) => n.id))
        const list = createList(rect, ids)
        env.setSelection(new Set([list.id])); env.setTool('select')
      }
      state.dragging = null
    },
  },
  rectangle: {
    id: 'rectangle',
    onPointerDown(info, _env, state) {
      state.dragging = { type: 'rectangle', startWorld: info.world, startScreen: info.screen, moved: false }
    },
    onPointerMove(info, env, state) {
      const d = state.dragging
      if (d?.type !== 'rectangle') return
      if (!d.moved && Math.hypot(info.screen.x - d.startScreen.x, info.screen.y - d.startScreen.y) <= 3) return
      d.moved = true
      const rect = {
        x: Math.min(d.startWorld.x, info.world.x), y: Math.min(d.startWorld.y, info.world.y),
        width: Math.max(8, Math.abs(info.world.x - d.startWorld.x)), height: Math.max(8, Math.abs(info.world.y - d.startWorld.y)),
      }
      if (d.fromId) documentStore.updateNode(d.fromId, rect)
      else {
        d.fromId = uid()
        documentStore.addNode({ id: d.fromId, type: 'rectangle', ...rect })
        env.setSelection(new Set([d.fromId]))
      }
    },
    onPointerUp(info, env, state) {
      tools.rectangle.onPointerMove?.(info, env, state)
      const d = state.dragging
      if (d?.type !== 'rectangle') return
      if (!d.fromId) {
        d.fromId = uid()
        documentStore.addNode({ id: d.fromId, type: 'rectangle', ...d.startWorld, width: 160, height: 100 })
        env.setSelection(new Set([d.fromId]))
      }
      updateMembership([d.fromId])
      state.dragging = null
      env.setTool('select')
    },
  },
  draw: {
    id: 'draw',
    onPointerDown(info, _env, state) { state.dragging = { type: 'draw', startWorld: info.world, startScreen: info.screen, points: [{ ...info.world }] } },
    onPointerMove(info, _env, state) {
      const d = state.dragging
      if (d?.type === 'draw' && d.points) {
        const last = d.points[d.points.length - 1]
        if (Math.hypot(info.world.x - last.x, info.world.y - last.y) * cameraStore.getSnapshot().zoom > 1) d.points.push({ ...info.world })
      }
    },
    onPointerUp(info, env, state) {
      const d = state.dragging
      if (d?.type === 'draw' && d.points) {
        d.points.push({ ...info.world })
        const xs = d.points.map((p) => p.x), ys = d.points.map((p) => p.y)
        const x = Math.min(...xs), y = Math.min(...ys)
        const node: DrawNode = { id: uid(), type: 'draw', x, y, width: Math.max(1, Math.max(...xs) - x), height: Math.max(1, Math.max(...ys) - y), points: d.points.map((p) => ({ x: p.x - x, y: p.y - y })), ...env.drawStyle }
        documentStore.addNode(node)
        updateMembership([node.id])
      }
      state.dragging = null
    },
  },
}
