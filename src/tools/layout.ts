import type { CanvasFile, CanvasNode } from '../types'

export const LIST_PADDING = 16
export const LIST_HEADER = 44
export const LIST_GAP = 12

// Membership order is persisted; geometry is derived again when content changes.
export function layoutLists(doc: CanvasFile): CanvasFile {
  const nodes = doc.nodes ?? [], patches = new Map<string, Partial<CanvasNode>>()
  const byId = new Map(nodes.map((n) => [n.id, n]))
  for (const list of nodes) {
    if (list.type !== 'group' || list.layout !== 'list') continue
    const members = [...new Set(list.memberIds ?? [])].flatMap((id) => {
      const node = byId.get(id)
      return node && (node.type === 'text' || node.type === 'image') ? [node] : []
    })
    const width = Math.max(160, list.width), inner = width - LIST_PADDING * 2
    let y = list.y + LIST_HEADER
    for (const node of members) {
      const height = node.type === 'image' ? node.height * inner / node.width : node.height
      patches.set(node.id, { x: list.x + LIST_PADDING, y, width: inner, height })
      y += height + LIST_GAP
    }
    patches.set(list.id, { width, height: Math.max(140, list.minHeight ?? 0, y - list.y - (members.length ? LIST_GAP : 0) + LIST_PADDING), memberIds: members.map((n) => n.id) })
  }
  if (!patches.size) return doc
  return { ...doc, nodes: nodes.map((node) => patches.has(node.id) ? { ...node, ...patches.get(node.id) } as CanvasNode : node) }
}

export const ARRANGE_GAP = 12
export type ArrangeMode = 'horizontal' | 'vertical'
export function arrangement(nodes: CanvasNode[], mode: ArrangeMode): Map<string, Partial<CanvasNode>> {
  const patches = new Map<string, Partial<CanvasNode>>()
  if (nodes.length < 2) return patches
  const left = Math.min(...nodes.map((n) => n.x)), top = Math.min(...nodes.map((n) => n.y))
  const horizontal = mode === 'horizontal'
  const sorted = [...nodes].sort((a, b) => horizontal ? a.x - b.x || a.y - b.y : a.y - b.y || a.x - b.x)
  let cursor = horizontal ? left : top
  sorted.forEach((node) => {
    patches.set(node.id, { x: horizontal ? cursor : left, y: horizontal ? top : cursor })
    cursor += (horizontal ? node.width : node.height) + ARRANGE_GAP
  })
  return patches
}
