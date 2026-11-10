import { useEffect, useRef, useState } from 'react'
import { ArrowRight, ArrowsLeftRight, BezierCurve, LineSegment, TextT, Trash, X } from './icons'
import type { Camera } from '../store/camera'
import { documentStore } from '../store/document'
import type { CanvasColor, CanvasEdge, CanvasFile } from '../types'
import { connectionPath, edgeGeometry, resolveColor, sideAnchor } from '../render/renderer'
import { IconButton } from './IconButton'
import { StylePalette } from './StylePalette'

const LINE_WIDTH = 4
function labelTextColor(color: string) {
  const hex = color.slice(1)
  const expanded = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex
  const channels = [0, 2, 4].map((offset) => {
    const value = parseInt(expanded.slice(offset, offset + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722 < 0.179 ? '#fff' : '#17121d'
}

export interface ConnectionPreview { fromId: string; to: { x: number; y: number }; targetId?: string }
export function ConnectionLayer({ doc, camera, preview, previewColor, selectedId, onSelect, interactive }: { doc: CanvasFile; camera: Camera; preview: ConnectionPreview | null; previewColor: CanvasColor; selectedId: string | null; onSelect: (id: string | null) => void; interactive: boolean }) {
  const [colorPickerOpen, setColorPickerOpen] = useState(false)
  const layerRef = useRef<SVGSVGElement>(null)
  const panelAnchor = useRef<{ id: string; left: number; top: number } | null>(null)
  useEffect(() => setColorPickerOpen(false), [selectedId])
  const byId = new Map((doc.nodes ?? []).map((n) => [n.id, n]))
  const selected = doc.edges?.find((e) => e.id === selectedId)
  const geo = selected ? edgeGeometry(selected, byId) : null
  if (!selected) panelAnchor.current = null
  else if (geo && panelAnchor.current?.id !== selected.id) {
    const rect = layerRef.current?.getBoundingClientRect()
    panelAnchor.current = {
      id: selected.id,
      left: Math.max(152, Math.min((rect?.width ?? window.innerWidth) - 152, geo.center.x * camera.zoom + camera.x)),
      top: Math.max(12, Math.min((rect?.height ?? window.innerHeight) - 176, geo.center.y * camera.zoom + camera.y + 18)),
    }
  }
  const source = preview ? byId.get(preview.fromId) : null
  const target = preview?.targetId ? byId.get(preview.targetId) : null
  const selectedColor = resolveColor(selected?.color, '#609fbb')
  return <>
    <svg ref={layerRef} className="connections-layer" aria-label="Block 连接">
      <defs><marker id="connection-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" /></marker></defs>
      <g transform={`translate(${camera.x}, ${camera.y}) scale(${camera.zoom})`}>
        {(doc.edges ?? []).map((edge) => {
          const path = edgeGeometry(edge, byId)
          if (!path) return null
          const color = resolveColor(edge.color, '#609fbb')
          return <g key={edge.id} className={selectedId === edge.id ? 'connection selected' : 'connection'}>
            <path className="connection-glow" d={path.path} stroke={color} strokeWidth={LINE_WIDTH + 8 / camera.zoom} />
            <path className="connection-line" d={path.path} stroke={color} strokeWidth={LINE_WIDTH} markerEnd={edge.toEnd === 'arrow' ? 'url(#connection-arrow)' : undefined} markerStart={edge.fromEnd === 'arrow' ? 'url(#connection-arrow)' : undefined} />
            {edge.toEnd === 'arrow' && <circle className="connection-direction" r={4.5} fill={color} pointerEvents="none"><animateMotion dur="3s" repeatCount="indefinite" path={path.path} /></circle>}
            <path className="connection-hit" data-edge-id={edge.id} d={path.path} strokeWidth={18 / camera.zoom} style={{ pointerEvents: interactive ? 'stroke' : 'none' }} onPointerDown={(e) => { e.stopPropagation(); onSelect(edge.id) }} onClick={(e) => e.stopPropagation()}><title>{edge.label || '连接 · 点击编辑'}</title></path>
          </g>
        })}
        {source && preview && <path className="connection-preview" d={connectionPath(sideAnchor(source), target ? sideAnchor(target) : preview.to, !target)} style={{ stroke: resolveColor(previewColor, '#609fbb') }} strokeWidth={LINE_WIDTH} />}
      </g>
    </svg>
    {(doc.edges ?? []).map((edge) => {
      if (!edge.label || edge.labelIsVisible === false) return null
      const geometry = edgeGeometry(edge, byId)
      if (!geometry) return null
      return <ConnectionLabel key={edge.id} edge={edge} center={geometry.center} camera={camera} selected={selectedId === edge.id} interactive={interactive} onSelect={() => onSelect(edge.id)} />
    })}
    {selected && geo && interactive && panelAnchor.current && <div className="edge-bar floating-panel" role="dialog" aria-label="连接样式" style={{ left: panelAnchor.current.left, top: panelAnchor.current.top }} onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); e.currentTarget.querySelector('input')?.blur(); onSelect(null) } }}>
      <div className="edge-heading" style={{ backgroundColor: `color-mix(in srgb, ${selectedColor} 16%, white)` }}>
        <button className={`edge-color-button ${colorPickerOpen ? 'active' : ''}`} style={{ backgroundColor: selectedColor }} aria-label="连接颜色" title="连接颜色" aria-expanded={colorPickerOpen} onClick={() => setColorPickerOpen(!colorPickerOpen)} />
        <input aria-label="连接名称" placeholder="连接名称" value={selected.label ?? ''} onChange={(e) => documentStore.updateEdge(selected.id, { label: e.target.value })} onFocus={() => documentStore.beginInteraction()} onBlur={() => documentStore.endInteraction()} onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); onSelect(null) } }} />
        <IconButton icon={X} label="关闭连接设置" onClick={() => onSelect(null)} />
      </div>
      {colorPickerOpen && <StylePalette color={selected.color} onChange={(color) => documentStore.updateEdge(selected.id, { color })} />}
      <div className="edge-controls" role="toolbar" aria-label="连接外观">
        <IconButton icon={TextT} label="显示连接标签" active={selected.labelIsVisible !== false} onClick={() => documentStore.updateEdge(selected.id, { labelIsVisible: selected.labelIsVisible === false })} />
        <IconButton icon={ArrowRight} label="显示连接方向" active={selected.toEnd === 'arrow'} onClick={() => documentStore.updateEdge(selected.id, { toEnd: selected.toEnd === 'arrow' ? 'none' : 'arrow' })} />
        <IconButton icon={ArrowsLeftRight} label="反转连接方向" onClick={() => documentStore.updateEdge(selected.id, { fromNode: selected.toNode, fromSide: selected.toSide, toNode: selected.fromNode, toSide: selected.fromSide })} />
        <div className="edge-path-options" role="group" aria-label="线条形状">
          <IconButton icon={BezierCurve} label="曲线连接" active={selected.lineStyle !== 'straight'} onClick={() => documentStore.updateEdge(selected.id, { lineStyle: 'curve' })} />
          <IconButton icon={LineSegment} label="直线连接" active={selected.lineStyle === 'straight'} onClick={() => documentStore.updateEdge(selected.id, { lineStyle: 'straight' })} />
        </div>
        <IconButton icon={Trash} label="删除连接" className="danger" onClick={() => { documentStore.deleteEdge(selected.id); onSelect(null) }} />
      </div>
    </div>}
  </>
}

function ConnectionLabel({ edge, center, camera, selected, interactive, onSelect }: { edge: CanvasEdge; center: { x: number; y: number }; camera: Camera; selected: boolean; interactive: boolean; onSelect: () => void }) {
  const drag = useRef<{ x: number; y: number; zoom: number; offset: { x: number; y: number }; moved: boolean } | null>(null)
  const color = resolveColor(edge.color, '#609fbb')
  const cancel = () => { if (drag.current?.moved) documentStore.cancelInteraction(); drag.current = null }
  useEffect(() => {
    const onEscape = (e: KeyboardEvent) => { if (e.key === 'Escape' && drag.current) { e.preventDefault(); e.stopImmediatePropagation(); cancel() } }
    window.addEventListener('blur', cancel); window.addEventListener('keydown', onEscape, true)
    return () => { cancel(); window.removeEventListener('blur', cancel); window.removeEventListener('keydown', onEscape, true) }
  }, [])
  return <button type="button" className={`connection-label ${selected ? 'active' : ''}`} data-edge-label-id={edge.id} aria-pressed={selected} tabIndex={interactive ? 0 : -1}
    style={{ left: (center.x + (edge.labelOffset?.x ?? 0)) * camera.zoom + camera.x, top: (center.y + (edge.labelOffset?.y ?? 0)) * camera.zoom + camera.y, backgroundColor: color, color: labelTextColor(color), transform: `translate(-50%, -50%) scale(${camera.zoom})`, pointerEvents: interactive ? 'auto' : 'none' }}
    onPointerDown={(e) => {
      e.stopPropagation()
      if (e.button !== 0) return
      e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); onSelect()
      drag.current = { x: e.clientX, y: e.clientY, zoom: camera.zoom, offset: edge.labelOffset ?? { x: 0, y: 0 }, moved: false }
    }}
    onPointerMove={(e) => {
      e.stopPropagation()
      const d = drag.current
      if (!d) return
      const dx = e.clientX - d.x, dy = e.clientY - d.y
      if (!d.moved && Math.hypot(dx, dy) < 3) return
      if (!d.moved) { documentStore.beginInteraction(); d.moved = true }
      documentStore.updateEdge(edge.id, { labelOffset: { x: d.offset.x + dx / d.zoom, y: d.offset.y + dy / d.zoom } })
    }}
    onPointerUp={(e) => { e.stopPropagation(); const d = drag.current; drag.current = null; if (d?.moved) documentStore.endInteraction(); if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId) }}
    onPointerCancel={(e) => { e.stopPropagation(); cancel() }} onLostPointerCapture={cancel}
    onClick={(e) => { e.stopPropagation(); onSelect() }} onDoubleClick={(e) => e.stopPropagation()}
    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation() }}
  >{edge.label}</button>
}
