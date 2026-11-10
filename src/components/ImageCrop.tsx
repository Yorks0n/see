import { useEffect, useRef } from 'react'
import type { Camera } from '../store/camera'
import { documentStore } from '../store/document'
import type { ImageNode } from '../types'
import { cropImage, uncroppedBounds, type CropHandle } from '../tools/imageCrop'
import { updateMembership } from '../tools/tools'

const handles: { id: CropHandle; x: number; y: number; label: string }[] = [
  { id: 'nw', x: 0, y: 0, label: '左上角' }, { id: 'n', x: 50, y: 0, label: '上边' },
  { id: 'ne', x: 100, y: 0, label: '右上角' }, { id: 'e', x: 100, y: 50, label: '右边' },
  { id: 'se', x: 100, y: 100, label: '右下角' }, { id: 's', x: 50, y: 100, label: '下边' },
  { id: 'sw', x: 0, y: 100, label: '左下角' }, { id: 'w', x: 0, y: 50, label: '左边' },
]

export function ImageCrop({ node, camera, onClose }: { node: ImageNode; camera: Camera; onClose: () => void }) {
  const drag = useRef<{ node: ImageNode; handle: CropHandle; x: number; y: number; zoom: number } | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const full = uncroppedBounds(node)
  useEffect(() => {
    const cancel = () => { if (drag.current) { drag.current = null; documentStore.cancelInteraction() } }
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' && event.key !== 'Enter') return
      event.preventDefault(); event.stopImmediatePropagation()
      if (event.key === 'Escape') cancel()
      else if (drag.current) { drag.current = null; documentStore.endInteraction() }
      closeRef.current()
    }
    window.addEventListener('keydown', key, true); window.addEventListener('blur', cancel)
    return () => { cancel(); window.removeEventListener('keydown', key, true); window.removeEventListener('blur', cancel) }
  }, [])
  return <div className="image-crop-layer" onDoubleClick={(e) => { e.stopPropagation(); onClose() }}>
    <div className="crop-original" style={{ left: full.x * camera.zoom + camera.x, top: full.y * camera.zoom + camera.y, width: full.width * camera.zoom, height: full.height * camera.zoom }}><img src={node.url} alt="" draggable={false} /></div>
    <div className="image-crop-bounds" role="group" aria-label="画布内裁剪图片" style={{ left: node.x * camera.zoom + camera.x, top: node.y * camera.zoom + camera.y, width: node.width * camera.zoom, height: node.height * camera.zoom }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.stopPropagation(); e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { node, handle: (e.target as HTMLElement).dataset.cropHandle as CropHandle || 'move', x: e.clientX, y: e.clientY, zoom: camera.zoom }
        documentStore.beginInteraction()
      }}
      onPointerMove={(e) => {
        e.stopPropagation()
        const d = drag.current
        if (d) documentStore.updateNode(node.id, cropImage(d.node, d.handle, (e.clientX - d.x) / d.zoom, (e.clientY - d.y) / d.zoom))
      }}
      onPointerUp={(e) => {
        e.stopPropagation()
        if (!drag.current) return
        drag.current = null; updateMembership([node.id]); documentStore.endInteraction()
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
      }}
      onPointerCancel={(e) => { e.stopPropagation(); if (drag.current) { drag.current = null; documentStore.cancelInteraction() } }}
      onLostPointerCapture={() => { if (drag.current) { drag.current = null; documentStore.cancelInteraction() } }}>
      <div className="crop-grid"><i /><i /><i /><i /></div>
      {handles.map(({ id, x, y, label }) => <button key={id} data-crop-handle={id} className={`inline-crop-handle crop-${id}`} style={{ left: `${x}%`, top: `${y}%` }} aria-label={`裁剪${label}`} title={`裁剪${label}`} onKeyDown={(e) => {
        if (!e.key.startsWith('Arrow')) return
        e.preventDefault(); e.stopPropagation()
        const step = e.shiftKey ? 10 : 1
        documentStore.transact(() => { documentStore.updateNode(node.id, cropImage(node, id, e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0)); updateMembership([node.id]) })
      }} />)}
    </div>
  </div>
}
