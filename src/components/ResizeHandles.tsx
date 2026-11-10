import { useEffect, useRef } from 'react'
import { documentStore } from '../store/document'
import type { Camera } from '../store/camera'
import type { CanvasNode } from '../types'
import { updateMembership } from '../tools/tools'

const corners = ['nw', 'ne', 'se', 'sw'] as const
export function ResizeHandles({ node, camera }: { node: CanvasNode; camera: Camera }) {
  const drag = useRef<{ node: CanvasNode; x: number; y: number; corner: string } | null>(null)
  const compact = node.type === 'image' || node.type === 'text'
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
  return <div className="resize-bounds" style={{ left: node.x * camera.zoom + camera.x, top: node.y * camera.zoom + camera.y, width: node.width * camera.zoom, height: node.height * camera.zoom }}>
    {handles.map((corner) => <button key={corner} className={`resize-handle ${corner}${compact ? ' corner-resize-handle' : ''}`} aria-label={node.type === 'image' ? '调整图片大小' : node.type === 'text' ? '调整文本块大小' : `缩放 ${corner}`} title={node.type === 'image' ? '拖动等比缩放 · Shift 自由缩放' : '拖动调整大小 · Shift 等比缩放'}
      onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); documentStore.beginInteraction(); drag.current = { node, x: e.clientX, y: e.clientY, corner } }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        e.stopPropagation()
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
        documentStore.updateNode(node.id, patch)
      }}
      onPointerUp={(e) => { e.stopPropagation(); if (!drag.current) return; drag.current = null; updateMembership([node.id]); documentStore.endInteraction(); e.currentTarget.releasePointerCapture(e.pointerId) }}
      onPointerCancel={(e) => { e.stopPropagation(); drag.current = null; documentStore.cancelInteraction() }}
      onLostPointerCapture={() => { if (drag.current) { drag.current = null; documentStore.cancelInteraction() } }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); drag.current = null; documentStore.cancelInteraction() } }}
    />)}
  </div>
}
