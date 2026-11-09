import { cameraStore } from '../store/camera'
import { documentStore, uid } from '../store/document'
import { hitTest } from '../render/renderer'
import type { CanvasNode, DrawNode, GroupNode, TextNode } from '../types'

export type ToolId = 'select' | 'card' | 'connect' | 'box' | 'draw' | 'hand'

export interface ToolEnv {
  selection: Set<string>
  setSelection: (s: Set<string>) => void
  setDragPreview: (p: { fromId: string; to: { x: number; y: number } } | null) => void
  setMarquee: (m: { x: number; y: number; width: number; height: number } | null) => void
  setEditingId: (id: string | null) => void
}

export interface PointerInfo {
  screen: { x: number; y: number }
  world: { x: number; y: number }
  shiftKey: boolean
}

interface DragState {
  type: 'pan' | 'move' | 'marquee' | 'connect' | 'box' | 'draw'
  startWorld: { x: number; y: number }
  startScreen: { x: number; y: number }
  originCamera?: { x: number; y: number }
  origins?: Map<string, { x: number; y: number }>
  fromId?: string
  rect?: { x: number; y: number; width: number; height: number }
  points?: { x: number; y: number }[]
  moved?: boolean
}

export class ToolState {
  dragging: DragState | null = null
}

export interface Tool {
  id: ToolId
  onPointerDown?(info: PointerInfo, env: ToolEnv, state: ToolState): void
  onPointerMove?(info: PointerInfo, env: ToolEnv, state: ToolState): void
  onPointerUp?(info: PointerInfo, env: ToolEnv, state: ToolState): void
  onDoubleClick?(info: PointerInfo, env: ToolEnv): void
}

function topHitAt(world: { x: number; y: number }): CanvasNode | null {
  return hitTest(documentStore.getSnapshot(), world.x, world.y)
}

export function createTextCard(world: { x: number; y: number }): TextNode {
  const node: TextNode = {
    id: uid(),
    type: 'text',
    x: Math.round(world.x - 100),
    y: Math.round(world.y - 30),
    width: 200,
    height: 60,
    text: '',
  }
  documentStore.addNode(node)
  return node
}

export const tools: Record<ToolId, Tool> = {
  hand: {
    id: 'hand',
    onPointerDown(info, _env, state) {
      const cam = cameraStore.getSnapshot()
      state.dragging = {
        type: 'pan',
        startWorld: info.world,
        startScreen: info.screen,
        originCamera: { x: cam.x, y: cam.y },
      }
    },
    onPointerMove(info, _env, state) {
      const d = state.dragging
      if (d?.type !== 'pan' || !d.originCamera) return
      cameraStore.set({
        x: d.originCamera.x + (info.screen.x - d.startScreen.x),
        y: d.originCamera.y + (info.screen.y - d.startScreen.y),
      })
    },
    onPointerUp(_info, _env, state) {
      state.dragging = null
    },
  },

  select: {
    id: 'select',
    onPointerDown(info, env, state) {
      const hit = topHitAt(info.world)
      if (hit) {
        const sel = env.selection.has(hit.id) ? new Set(env.selection) : new Set([hit.id])
        env.setSelection(sel)
        documentStore.bringToFront(hit.id)
        documentStore.checkpoint()
        const origins = new Map<string, { x: number; y: number }>()
        for (const id of sel) {
          const n = documentStore.getNode(id)
          if (n) origins.set(id, { x: n.x, y: n.y })
        }
        state.dragging = {
          type: 'move',
          startWorld: info.world,
          startScreen: info.screen,
          origins,
          moved: false,
        }
      } else {
        env.setSelection(new Set())
        state.dragging = {
          type: 'marquee',
          startWorld: info.world,
          startScreen: info.screen,
          rect: { x: info.world.x, y: info.world.y, width: 0, height: 0 },
        }
      }
    },
    onPointerMove(info, env, state) {
      const d = state.dragging
      if (!d) return
      if (d.type === 'move' && d.origins) {
        const dx = info.world.x - d.startWorld.x
        const dy = info.world.y - d.startWorld.y
        if (Math.abs(dx) + Math.abs(dy) > 0.5) d.moved = true
        if (d.moved) {
          for (const [id, origin] of d.origins) {
            documentStore.updateNode(id, { x: Math.round(origin.x + dx), y: Math.round(origin.y + dy) }, { transient: true })
          }
        }
      } else if (d.type === 'marquee' && d.rect) {
        d.rect = {
          x: Math.min(d.startWorld.x, info.world.x),
          y: Math.min(d.startWorld.y, info.world.y),
          width: Math.abs(info.world.x - d.startWorld.x),
          height: Math.abs(info.world.y - d.startWorld.y),
        }
        env.setMarquee(d.rect)
      }
    },
    onPointerUp(info, env, state) {
      const d = state.dragging
      if (d?.type === 'marquee' && d.rect) {
        env.setMarquee(null)
        const doc = documentStore.getSnapshot()
        const rects = (doc.nodes ?? []).map((n) => ({ id: n.id, x: n.x, y: n.y, width: n.width, height: n.height }))
        const selected = new Set<string>()
        for (const n of doc.nodes ?? []) {
          const r = d.rect
          if (n.x >= r.x && n.x + n.width <= r.x + r.width && n.y >= r.y && n.y + n.height <= r.y + r.height) {
            selected.add(n.id)
          }
        }
        void rects
        if (selected.size > 0) env.setSelection(selected)
      }
      void info
      state.dragging = null
    },
    onDoubleClick(info, env) {
      const hit = topHitAt(info.world)
      if (hit && hit.type === 'text') env.setEditingId(hit.id)
    },
  },

  card: {
    id: 'card',
    onPointerDown(info, env) {
      const node = createTextCard(info.world)
      env.setSelection(new Set([node.id]))
      env.setEditingId(node.id)
    },
  },

  connect: {
    id: 'connect',
    onPointerDown(info, env, state) {
      const hit = topHitAt(info.world)
      if (hit) {
        state.dragging = { type: 'connect', startWorld: info.world, startScreen: info.screen, fromId: hit.id }
        env.setDragPreview({ fromId: hit.id, to: info.world })
      }
    },
    onPointerMove(info, env, state) {
      const d = state.dragging
      if (d?.type === 'connect' && d.fromId) {
        env.setDragPreview({ fromId: d.fromId, to: info.world })
      }
    },
    onPointerUp(info, env, state) {
      const d = state.dragging
      env.setDragPreview(null)
      if (d?.type === 'connect' && d.fromId) {
        const hit = topHitAt(info.world)
        if (hit && hit.id !== d.fromId) {
          documentStore.addEdge({
            id: uid(),
            fromNode: d.fromId,
            fromSide: 'right',
            fromEnd: 'none',
            toNode: hit.id,
            toSide: 'left',
            toEnd: 'arrow',
          })
        }
      }
      state.dragging = null
    },
  },

  box: {
    id: 'box',
    onPointerDown(info, _env, state) {
      state.dragging = {
        type: 'box',
        startWorld: info.world,
        startScreen: info.screen,
        rect: { x: info.world.x, y: info.world.y, width: 0, height: 0 },
      }
    },
    onPointerMove(info, env, state) {
      const d = state.dragging
      if (d?.type !== 'box' || !d.rect) return
      d.rect = {
        x: Math.min(d.startWorld.x, info.world.x),
        y: Math.min(d.startWorld.y, info.world.y),
        width: Math.abs(info.world.x - d.startWorld.x),
        height: Math.abs(info.world.y - d.startWorld.y),
      }
      env.setMarquee(d.rect)
    },
    onPointerUp(_info, env, state) {
      const d = state.dragging
      env.setMarquee(null)
      if (d?.type === 'box' && d.rect && d.rect.width > 10 && d.rect.height > 10) {
        const g: GroupNode = {
          id: uid(),
          type: 'group',
          x: Math.round(d.rect.x),
          y: Math.round(d.rect.y),
          width: Math.round(d.rect.width),
          height: Math.round(d.rect.height),
          label: '分组',
        }
        documentStore.addNode(g)
      }
      state.dragging = null
    },
  },

  draw: {
    id: 'draw',
    onPointerDown(info, _env, state) {
      state.dragging = {
        type: 'draw',
        startWorld: info.world,
        startScreen: info.screen,
        points: [{ x: info.world.x, y: info.world.y }],
      }
    },
    onPointerMove(info, _env, state) {
      const d = state.dragging
      if (d?.type === 'draw' && d.points) {
        const last = d.points[d.points.length - 1]
        if (Math.hypot(info.world.x - last.x, info.world.y - last.y) > 2) {
          d.points.push({ x: info.world.x, y: info.world.y })
        }
      }
    },
    onPointerUp(_info, _env, state) {
      const d = state.dragging
      if (d?.type === 'draw' && d.points && d.points.length > 1) {
        const xs = d.points.map((p) => p.x)
        const ys = d.points.map((p) => p.y)
        const minX = Math.min(...xs)
        const minY = Math.min(...ys)
        const node: DrawNode = {
          id: uid(),
          type: 'draw',
          x: minX,
          y: minY,
          width: Math.max(...xs) - minX,
          height: Math.max(...ys) - minY,
          points: d.points.map((p) => ({ x: p.x - minX, y: p.y - minY })),
        }
        documentStore.addNode(node)
      }
      state.dragging = null
    },
  },
}
