import type { Camera } from '../store/camera'
import type { CanvasEdge, CanvasFile, CanvasNode, DrawNode, GroupNode, NodeSide } from '../types'
import { buildGrid, type Rect } from '../hit/grid'

export const PRESET_COLORS: Record<string, string> = {
  '1': '#e03131',
  '2': '#f08c00',
  '3': '#f7d154',
  '4': '#37b24d',
  '5': '#22b8cf',
  '6': '#845ef7',
}

export function resolveColor(color: string | undefined, fallback: string): string {
  if (!color) return fallback
  return PRESET_COLORS[color] ?? color
}

export function nodeRect(n: CanvasNode): Rect {
  return { id: n.id, x: n.x, y: n.y, width: n.width, height: n.height }
}

export function sideAnchor(n: CanvasNode, side: NodeSide | undefined): { x: number; y: number } {
  const s = side ?? 'right'
  switch (s) {
    case 'top':
      return { x: n.x + n.width / 2, y: n.y }
    case 'bottom':
      return { x: n.x + n.width / 2, y: n.y + n.height }
    case 'left':
      return { x: n.x, y: n.y + n.height / 2 }
    default:
      return { x: n.x + n.width, y: n.y + n.height / 2 }
  }
}

function edgePath(ctx: CanvasRenderingContext2D, from: { x: number; y: number }, to: { x: number; y: number }) {
  const dx = Math.max(40, Math.abs(to.x - from.x) / 2)
  ctx.moveTo(from.x, from.y)
  ctx.bezierCurveTo(from.x + dx, from.y, to.x - dx, to.y, to.x, to.y)
}

function drawArrowHead(ctx: CanvasRenderingContext2D, from: { x: number; y: number }, to: { x: number; y: number }) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  const size = 10
  ctx.beginPath()
  ctx.moveTo(to.x, to.y)
  ctx.lineTo(to.x - size * Math.cos(angle - Math.PI / 6), to.y - size * Math.sin(angle - Math.PI / 6))
  ctx.lineTo(to.x - size * Math.cos(angle + Math.PI / 6), to.y - size * Math.sin(angle + Math.PI / 6))
  ctx.closePath()
  ctx.fill()
}

export interface RenderEnv {
  doc: CanvasFile
  camera: Camera
  selection: Set<string>
  dragPreview?: { fromId: string; to: { x: number; y: number } } | null
  marquee?: { x: number; y: number; width: number; height: number } | null
  activeStroke?: { x: number; y: number }[] | null
}

export function renderStaticScene(ctx: CanvasRenderingContext2D, env: RenderEnv, dpr: number, width: number, height: number) {
  const { doc, camera } = env
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#fafafa'
  ctx.fillRect(0, 0, width, height)
  drawDotGrid(ctx, camera, width, height)

  ctx.setTransform(dpr * camera.zoom, 0, 0, dpr * camera.zoom, dpr * camera.x, dpr * camera.y)

  const nodes = doc.nodes ?? []
  const groups = nodes.filter((n): n is GroupNode => n.type === 'group')
  const others = nodes.filter((n) => n.type !== 'group')

  for (const g of groups) {
    ctx.fillStyle = resolveColor(g.color, 'rgba(120,144,156,0.12)')
    ctx.strokeStyle = 'rgba(120,144,156,0.5)'
    ctx.lineWidth = 1.5 / camera.zoom
    roundRect(ctx, g.x, g.y, g.width, g.height, 12)
    ctx.fill()
    ctx.stroke()
    if (g.label) {
      ctx.fillStyle = '#5f6b76'
      ctx.font = `${14 / camera.zoom}px sans-serif`
      ctx.fillText(g.label, g.x + 12 / camera.zoom, g.y + 20 / camera.zoom)
    }
  }

  for (const n of others) {
    if (n.type === 'draw') {
      drawStroke(ctx, n, camera.zoom)
    } else if (n.type !== 'text' && n.type !== 'image') {
      ctx.fillStyle = resolveColor(n.color, '#ffffff')
      ctx.strokeStyle = '#adb5bd'
      ctx.lineWidth = 1.5 / camera.zoom
      roundRect(ctx, n.x, n.y, n.width, n.height, 8)
      ctx.fill()
      ctx.stroke()
    }
  }

  const byId = new Map(nodes.map((n) => [n.id, n]))
  for (const e of doc.edges ?? []) {
    const from = byId.get(e.fromNode)
    const to = byId.get(e.toNode)
    if (!from || !to) continue
    const p0 = sideAnchor(from, e.fromSide)
    const p1 = sideAnchor(to, e.toSide)
    ctx.strokeStyle = resolveColor(e.color, '#495057')
    ctx.fillStyle = ctx.strokeStyle
    ctx.lineWidth = 2 / camera.zoom
    ctx.beginPath()
    edgePath(ctx, p0, p1)
    ctx.stroke()
    if ((e.toEnd ?? 'arrow') === 'arrow') drawArrowHead(ctx, p0, p1)
    if (e.label) {
      ctx.font = `${13 / camera.zoom}px sans-serif`
      ctx.fillText(e.label, (p0.x + p1.x) / 2, (p0.y + p1.y) / 2 - 6 / camera.zoom)
    }
  }
}

export function renderInteractiveScene(ctx: CanvasRenderingContext2D, env: RenderEnv, dpr: number, width: number, height: number) {
  const { camera, selection, dragPreview, marquee, doc, activeStroke } = env
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.setTransform(dpr * camera.zoom, 0, 0, dpr * camera.zoom, dpr * camera.x, dpr * camera.y)
  const lw = 1.5 / camera.zoom

  const byId = new Map((doc.nodes ?? []).map((n) => [n.id, n]))
  for (const id of selection) {
    const n = byId.get(id)
    if (!n) continue
    if (n.type === 'text' || n.type === 'image') continue
    ctx.strokeStyle = '#4dabf7'
    ctx.lineWidth = lw
    roundRect(ctx, n.x - 3 / camera.zoom, n.y - 3 / camera.zoom, n.width + 6 / camera.zoom, n.height + 6 / camera.zoom, 8)
    ctx.stroke()
  }

  if (dragPreview) {
    const from = byId.get(dragPreview.fromId)
    if (from) {
      const p0 = sideAnchor(from, 'right')
      ctx.strokeStyle = '#4dabf7'
      ctx.lineWidth = 2 / camera.zoom
      ctx.setLineDash([6 / camera.zoom, 4 / camera.zoom])
      ctx.beginPath()
      edgePath(ctx, p0, dragPreview.to)
      ctx.stroke()
      ctx.setLineDash([])
    }
  }

  if (marquee) {
    ctx.strokeStyle = '#4dabf7'
    ctx.fillStyle = 'rgba(77,171,247,0.1)'
    ctx.lineWidth = lw
    ctx.fillRect(marquee.x, marquee.y, marquee.width, marquee.height)
    ctx.strokeRect(marquee.x, marquee.y, marquee.width, marquee.height)
  }

  if (activeStroke && activeStroke.length > 1) {
    ctx.strokeStyle = '#343a40'
    ctx.lineWidth = 3 / camera.zoom
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(activeStroke[0].x, activeStroke[0].y)
    for (let i = 1; i < activeStroke.length; i++) ctx.lineTo(activeStroke[i].x, activeStroke[i].y)
    ctx.stroke()
  }
}

function drawStroke(ctx: CanvasRenderingContext2D, n: DrawNode, zoom: number) {
  if (n.points.length < 2) return
  ctx.strokeStyle = resolveColor(n.color, '#343a40')
  ctx.lineWidth = (n.strokeWidth ?? 3) / zoom
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(n.x + n.points[0].x, n.y + n.points[0].y)
  for (let i = 1; i < n.points.length; i++) ctx.lineTo(n.x + n.points[i].x, n.y + n.points[i].y)
  ctx.stroke()
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function drawDotGrid(ctx: CanvasRenderingContext2D, camera: Camera, width: number, height: number) {
  const step = 32 * camera.zoom
  if (step < 8) return
  ctx.fillStyle = '#dee2e6'
  const offsetX = camera.x % step
  const offsetY = camera.y % step
  for (let x = offsetX; x < width; x += step) {
    for (let y = offsetY; y < height; y += step) {
      ctx.beginPath()
      ctx.arc(x, y, 1.2, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}

export function hitTest(doc: CanvasFile, wx: number, wy: number): CanvasNode | null {
  const nodes = doc.nodes ?? []
  const rects = nodes.map(nodeRect)
  const { grid, rectsById } = buildGrid(rects)
  const hits = grid.queryPoint(wx, wy, rectsById)
  if (hits.length === 0) return null
  const topId = hits[hits.length - 1].id
  return nodes.find((n) => n.id === topId) ?? null
}
