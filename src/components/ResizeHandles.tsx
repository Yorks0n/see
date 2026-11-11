import { useEffect, useRef } from 'react'
import { documentStore } from '../store/document'
import type { Camera } from '../store/camera'
import type { CanvasNode } from '../types'
import { expandSelection, updateMembership } from '../tools/tools'
import { resizeSelection, selectionBounds, type SelectionBounds } from '../tools/resize'

const corners = ['nw', 'ne', 'se', 'sw'] as const
export function ResizeHandles({ nodes, camera }: { nodes: CanvasNode[]; camera: Camera }) {
  const multiple = nodes.length > 1, node = nodes[0]
  const ids = expandSelection(new Set(nodes.map((n) => n.id)))
  const targets = multiple ? (documentStore.getSnapshot().nodes ?? []).filter((n) => ids.has(n.id)) : nodes
  const bounds = selectionBounds(targets)
  const drag = useRef<{ node: CanvasNode; nodes: CanvasNode[]; bounds: SelectionBounds; zoom: number; x: number; y: number; corner: string; moved: boolean } | null>(null)
  const list = node.type === 'group' && node.layout === 'list'
  const compact = !multiple && (node.type === 'image' || node.type === 'text' || node.type === 'rectangle' || list)
  const handles = compact ? ['se'] as const : corners
  useEffect(() => {
    const cancel = () => { if (drag.current) { drag.current = null; documentStore.cancelInteraction() } }
    const onKey = (e: KeyboardEvent) => {
      if (drag.current && (e.key === 'Escape' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z'))) {
        e.preventDefault(); e.stopImmediatePropagation(); cancel()
      }
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', cancel)
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('blur', cancel); cancel() }
  }, [])
  const resize = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    e.stopPropagation()
    if (!d.moved && e.clientX === d.x && e.clientY === d.y) return
    d.moved = true
    if (multiple) {
      const patches = resizeSelection(d.nodes, d.bounds, (e.clientX - d.x) / d.zoom, (e.clientY - d.y) / d.zoom, d.corner, !e.shiftKey)
      documentStore.updateNodes(patches)
      for (const n of d.nodes) if (n.type === 'group' && n.layout === 'list') {
        const patch = patches.get(n.id)!
        documentStore.resizeList(n.id, patch.width!, patch.height!)
      }
      return
    }
    const west = d.corner.includes('w'), north = d.corner.includes('n')
    let width = Math.max(32, d.node.width + (e.clientX - d.x) / camera.zoom * (west ? -1 : 1))
    let height = Math.max(24, d.node.height + (e.clientY - d.y) / camera.zoom * (north ? -1 : 1))
    if ((node.type === 'image' && !e.shiftKey) || (node.type !== 'image' && e.shiftKey)) {
      const sx = width / d.node.width, sy = height / d.node.height
      const scale = Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy
      width = Math.max(32, d.node.width * scale)
      height = width * d.node.height / d.node.width
    }
    const patch: Partial<CanvasNode> = { x: west ? d.node.x + d.node.width - width : d.node.x, y: north ? d.node.y + d.node.height - height : d.node.y, width, height }
    if (d.node.type === 'draw') Object.assign(patch, { points: d.node.points.map((p) => ({ x: p.x * width / d.node.width, y: p.y * height / d.node.height })) })
    if (list) documentStore.resizeList(node.id, width, height)
    else documentStore.updateNode(node.id, patch)
  }
  return <div className={`resize-bounds${multiple ? ' multi-resize-bounds' : ''}`} style={{ left: bounds.x * camera.zoom + camera.x, top: bounds.y * camera.zoom + camera.y, width: bounds.width * camera.zoom, height: bounds.height * camera.zoom }}>
    {handles.map((corner) => <button key={corner} className={`resize-handle ${corner}${compact ? ' corner-resize-handle' : ''}`} aria-label={multiple ? `整体缩放 ${corner}` : list ? '调整列表大小' : node.type === 'rectangle' ? '调整矩形大小' : node.type === 'image' ? '调整图片大小' : node.type === 'text' ? '调整文本块大小' : `缩放 ${corner}`} title={multiple || node.type === 'image' ? '拖动等比缩放 · Shift 自由缩放' : '拖动调整大小 · Shift 等比缩放'}
      onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); documentStore.beginInteraction(); drag.current = { node, nodes: targets, bounds, zoom: camera.zoom, x: e.clientX, y: e.clientY, corner, moved: false } }}
      onPointerMove={resize}
      onPointerUp={(e) => { e.stopPropagation(); if (!drag.current) return; resize(e); const d = drag.current; drag.current = null; if (d.moved) updateMembership(d.nodes.map((n) => n.id)); documentStore.endInteraction(); e.currentTarget.releasePointerCapture(e.pointerId) }}
      onPointerCancel={(e) => { e.stopPropagation(); drag.current = null; documentStore.cancelInteraction() }}
      onLostPointerCapture={() => { if (drag.current) { drag.current = null; documentStore.cancelInteraction() } }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); drag.current = null; documentStore.cancelInteraction() } }}
    />)}
  </div>
}
