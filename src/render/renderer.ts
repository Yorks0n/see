import type { Camera } from '../store/camera'
import type { CanvasColor, CanvasEdge, CanvasFile, CanvasNode, DrawPoint, NodeSide } from '../types'
import type { DrawStyle } from '../tools/tools'
import type { Rect } from '../hit/grid'

export const PRESET_COLORS: Record<string, string> = { '1': '#e76d77', '2': '#df9451', '3': '#d5b43c', '4': '#69a780', '5': '#609fbb', '6': '#8b78cb' }
export const COLOR_NAMES: Record<string, string> = { '1': '珊瑚红', '2': '杏橙', '3': '暖黄', '4': '苔绿', '5': '湖蓝', '6': '鸢尾紫' }
export function resolveColor(color: string | undefined, fallback: string): string { return color ? PRESET_COLORS[color] ?? color : fallback }
export function nodeRect(n: CanvasNode): Rect { return { id: n.id, x: n.x, y: n.y, width: n.width, height: n.height } }
export function sideAnchor(n: CanvasNode, side?: NodeSide) {
  switch (side) {
    case 'top': return { x: n.x + n.width / 2, y: n.y }
    case 'bottom': return { x: n.x + n.width / 2, y: n.y + n.height }
    case 'left': return { x: n.x, y: n.y + n.height / 2 }
    case 'right': return { x: n.x + n.width, y: n.y + n.height / 2 }
    default: return { x: n.x + n.width, y: n.y + Math.min(20, n.height / 2) }
  }
}
export function connectionPath(from: { x: number; y: number }, to: { x: number; y: number }, loose = false, style: CanvasEdge['lineStyle'] = 'curve') {
  if (style === 'straight') return `M ${from.x} ${from.y} L ${to.x} ${to.y}`
  const reach = Math.max(48, Math.min(180, Math.abs(to.x - from.x) * 0.45 + Math.abs(to.y - from.y) * 0.15))
  return `M ${from.x} ${from.y} C ${from.x + reach} ${from.y}, ${to.x + (loose ? -reach : reach)} ${to.y}, ${to.x} ${to.y}`
}
export function edgeGeometry(e: CanvasEdge, byId: Map<string, CanvasNode>) {
  const from = byId.get(e.fromNode), to = byId.get(e.toNode)
  if (!from || !to) return null
  const p0 = sideAnchor(from, e.fromSide), p1 = sideAnchor(to, e.toSide)
  const path = connectionPath(p0, p1, e.toSide === 'left', e.lineStyle)
  const reach = Math.max(48, Math.min(180, Math.abs(p1.x - p0.x) * 0.45 + Math.abs(p1.y - p0.y) * 0.15))
  const center = { x: (p0.x + p1.x) / 2 + (e.lineStyle !== 'straight' && e.toSide !== 'left' ? reach * 0.75 : 0), y: (p0.y + p1.y) / 2 }
  return { from: p0, to: p1, center, path }
}
export function traceStroke(ctx: CanvasRenderingContext2D, points: DrawPoint[], offsetX = 0, offsetY = 0) {
  if (!points.length) return
  ctx.beginPath()
  ctx.moveTo(points[0].x + offsetX, points[0].y + offsetY)
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i], next = points[i + 1]
    ctx.quadraticCurveTo(p.x + offsetX, p.y + offsetY, (p.x + next.x) / 2 + offsetX, (p.y + next.y) / 2 + offsetY)
  }
  const last = points[points.length - 1]
  ctx.lineTo(last.x + offsetX + (points.length === 2 ? 0.01 : 0), last.y + offsetY)
  ctx.stroke()
}
export function strokePath(points: DrawPoint[]) {
  if (!points.length) return ''
  let path = `M ${points[0].x} ${points[0].y}`
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i], next = points[i + 1]
    path += ` Q ${p.x} ${p.y} ${(p.x + next.x) / 2} ${(p.y + next.y) / 2}`
  }
  const last = points[points.length - 1]
  return `${path} L ${last.x + (points.length <= 2 ? 0.01 : 0)} ${last.y}`
}
function fillPaintTrail(ctx: CanvasRenderingContext2D, points: DrawPoint[], zoom: number) {
  const first = points[0], last = points[points.length - 1], radius = 15 / zoom
  ctx.fillStyle = 'rgba(96,159,187,0.28)'
  ctx.beginPath()
  if (points.length === 1) {
    ctx.arc(last.x, last.y, radius, 0, Math.PI * 2)
  } else {
    const distances = [0]
    for (let i = 1; i < points.length; i++) distances.push(distances[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y))
    const length = distances[distances.length - 1] || 1
    const left: DrawPoint[] = [], right: DrawPoint[] = []
    for (let i = 0; i < points.length; i++) {
      const point = points[i], before = points[Math.max(0, i - 1)], after = points[Math.min(points.length - 1, i + 1)]
      let dx = after.x - before.x, dy = after.y - before.y
      if (!dx && !dy) { dx = point.x - before.x; dy = point.y - before.y }
      const size = Math.hypot(dx, dy) || 1
      const width = radius * (distances[i] / length) ** 1.15
      const nx = -dy / size * width, ny = dx / size * width
      left.push({ x: point.x + nx, y: point.y + ny })
      right.push({ x: point.x - nx, y: point.y - ny })
    }
    ctx.moveTo(left[0].x, left[0].y)
    for (let i = 1; i < left.length - 1; i++) ctx.quadraticCurveTo(left[i].x, left[i].y, (left[i].x + left[i + 1].x) / 2, (left[i].y + left[i + 1].y) / 2)
    ctx.lineTo(left[left.length - 1].x, left[left.length - 1].y)
    const before = points[points.length - 2]
    const angle = Math.atan2(last.y - before.y, last.x - before.x) + Math.PI / 2
    ctx.arc(last.x, last.y, radius, angle, angle - Math.PI, true)
    for (let i = right.length - 2; i > 0; i--) ctx.quadraticCurveTo(right[i].x, right[i].y, (right[i].x + right[i - 1].x) / 2, (right[i].y + right[i - 1].y) / 2)
    ctx.lineTo(right[0].x, right[0].y)
    ctx.closePath()
    if (first.x !== last.x || first.y !== last.y) {
      const gradient = ctx.createLinearGradient(first.x, first.y, last.x, last.y)
      gradient.addColorStop(0, 'rgba(96,159,187,0)')
      gradient.addColorStop(1, 'rgba(96,159,187,0.28)')
      ctx.fillStyle = gradient
    }
  }
  ctx.fill()
}
export interface RenderEnv {
  doc: CanvasFile
  camera: Camera
  selection: Set<string>
  marquee?: { x: number; y: number; width: number; height: number } | null
  paintTrail?: DrawPoint[] | null
  activeStroke?: DrawPoint[] | null
  drawStyle?: DrawStyle
}
export function renderStaticScene(ctx: CanvasRenderingContext2D, env: RenderEnv, dpr: number, width: number, height: number) {
  const { doc, camera } = env
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.setTransform(dpr * camera.zoom, 0, 0, dpr * camera.zoom, dpr * camera.x, dpr * camera.y)
  for (const n of doc.nodes ?? []) {
    if (n.type !== 'group') continue
    const color = resolveColor(n.color, '#9b95ab')
    ctx.globalAlpha = 0.07
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.roundRect(n.x, n.y, n.width, n.height, 10)
    ctx.fill()
    ctx.globalAlpha = 0.6
    ctx.strokeStyle = color
    ctx.lineWidth = 1 / camera.zoom
    ctx.stroke()
    ctx.globalAlpha = 1
  }
}
export function renderInteractiveScene(ctx: CanvasRenderingContext2D, env: RenderEnv, dpr: number, width: number, height: number) {
  const { camera, selection, marquee, paintTrail, doc, activeStroke, drawStyle } = env
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.setTransform(dpr * camera.zoom, 0, 0, dpr * camera.zoom, dpr * camera.x, dpr * camera.y)
  for (const n of doc.nodes ?? []) {
    if (!selection.has(n.id) || n.type !== 'group') continue
    ctx.fillStyle = 'rgba(49,153,199,0.14)'
    ctx.fillRect(n.x, n.y, n.width, n.height)
    ctx.strokeStyle = '#3199c7'
    ctx.lineWidth = 1 / camera.zoom
    ctx.strokeRect(n.x, n.y, n.width, n.height)
  }
  if (marquee) {
    ctx.strokeStyle = '#609fbb'
    ctx.fillStyle = 'rgba(96,159,187,0.09)'
    ctx.lineWidth = 1 / camera.zoom
    ctx.fillRect(marquee.x, marquee.y, marquee.width, marquee.height)
    ctx.strokeRect(marquee.x, marquee.y, marquee.width, marquee.height)
  }
  if (paintTrail?.length) {
    fillPaintTrail(ctx, paintTrail, camera.zoom)
  }
  if (activeStroke?.length) {
    ctx.strokeStyle = resolveColor(drawStyle?.color, '#44434d')
    ctx.lineWidth = drawStyle?.strokeWidth ?? 3
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    traceStroke(ctx, activeStroke)
  }
}
function segmentDistance(p: DrawPoint, a: DrawPoint, b: DrawPoint) {
  const dx = b.x - a.x, dy = b.y - a.y
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
}
export function hitTest(doc: CanvasFile, wx: number, wy: number, tolerance = 7): CanvasNode | null {
  const nodes = doc.nodes ?? []
  const test = (n: CanvasNode) => {
    if (n.type === 'draw') {
      const p = { x: wx - n.x, y: wy - n.y }
      const radius = tolerance + (n.strokeWidth ?? 3) / 2
      if (p.x < -radius || p.y < -radius || p.x > n.width + radius || p.y > n.height + radius || !n.points.length) return false
      let previous = n.points[0]
      for (let i = 1; i < n.points.length - 1; i++) {
        const start = previous, control = n.points[i], next = n.points[i + 1]
        const end = { x: (control.x + next.x) / 2, y: (control.y + next.y) / 2 }
        const steps = Math.max(2, Math.min(32, Math.ceil((Math.hypot(control.x - start.x, control.y - start.y) + Math.hypot(end.x - control.x, end.y - control.y)) / Math.max(1, radius))))
        for (let step = 1; step <= steps; step++) {
          const t = step / steps, u = 1 - t
          const point = { x: u * u * start.x + 2 * u * t * control.x + t * t * end.x, y: u * u * start.y + 2 * u * t * control.y + t * t * end.y }
          if (segmentDistance(p, previous, point) <= radius) return true
          previous = point
        }
      }
      return segmentDistance(p, previous, n.points[n.points.length - 1]) <= radius
    }
    return wx >= n.x && wx <= n.x + n.width && wy >= n.y && wy <= n.y + n.height
  }
  // Frames always sit behind their contents, regardless of creation order.
  return [...nodes].reverse().find((n) => n.type !== 'group' && test(n))
    ?? [...nodes].reverse().find((n) => n.type === 'group' && test(n)) ?? null
}
export const colorKeys: CanvasColor[] = ['1', '2', '3', '4', '5', '6']
