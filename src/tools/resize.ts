import type { CanvasNode } from '../types'

export interface SelectionBounds { x: number; y: number; width: number; height: number }

export function selectionBounds(nodes: CanvasNode[]): SelectionBounds {
  const x = Math.min(...nodes.map((node) => node.x)), y = Math.min(...nodes.map((node) => node.y))
  return { x, y, width: Math.max(...nodes.map((node) => node.x + node.width)) - x, height: Math.max(...nodes.map((node) => node.y + node.height)) - y }
}

export function resizeSelection(nodes: CanvasNode[], bounds: SelectionBounds, dx: number, dy: number, corner: string, proportional: boolean) {
  const west = corner.includes('w'), north = corner.includes('n')
  // Thin strokes must not impose their card-sized minimum on the whole selection.
  const minX = Math.max(...nodes.map((node) => node.type === 'draw' ? 1 / bounds.width : Math.min(node.width, node.type === 'group' && node.layout === 'list' ? 160 : 32) / node.width))
  const minY = Math.max(...nodes.map((node) => node.type === 'draw' ? 1 / bounds.height : Math.min(node.height, node.type === 'group' && node.layout === 'list' ? 140 : 24) / node.height))
  let sx = Math.max(minX, 1 + dx / bounds.width * (west ? -1 : 1))
  let sy = Math.max(minY, 1 + dy / bounds.height * (north ? -1 : 1))
  if (proportional) sx = sy = Math.max(minX, minY, Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy)
  const x = west ? bounds.x + bounds.width * (1 - sx) : bounds.x
  const y = north ? bounds.y + bounds.height * (1 - sy) : bounds.y
  return new Map<string, Partial<CanvasNode>>(nodes.map((node) => {
    const patch: Partial<CanvasNode> = { x: x + (node.x - bounds.x) * sx, y: y + (node.y - bounds.y) * sy, width: node.width * sx, height: node.height * sy }
    if (node.type === 'draw') Object.assign(patch, { width: Math.max(1, patch.width!), height: Math.max(1, patch.height!), points: node.points.map((point) => ({ x: point.x * sx, y: point.y * sy })) })
    if (node.type === 'group' && node.layout === 'list') Object.assign(patch, { minHeight: patch.height })
    return [node.id, patch]
  }))
}
