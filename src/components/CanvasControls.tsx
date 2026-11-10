import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type RefObject } from 'react'
import { cameraStore, MIN_ZOOM, MAX_ZOOM, type Camera } from '../store/camera'
import { DEFAULT_CONNECTION_COLOR, preferencesStore } from '../store/preferences'
import { minimapCamera, minimapBounds, viewportRect, zoomAtCenter, type Rect } from '../render/minimap'
import { edgeGeometry, resolveColor, strokePath } from '../render/renderer'
import type { CanvasFile } from '../types'
import { CornersOut, LineSegment, MapTrifold, Palette, Presentation, TextT, X } from './icons'
import { IconButton } from './IconButton'
import { StylePalette } from './StylePalette'

export function CanvasControls({ boardRef, doc, camera, uiVisible, onToggleUI, onFit }: {
  boardRef: RefObject<HTMLDivElement>; doc: CanvasFile; camera: Camera
  uiVisible: boolean; onToggleUI: () => void; onFit: () => void
}) {
  const colors = useSyncExternalStore(preferencesStore.subscribe, preferencesStore.getSnapshot)
  const [themeOpen, setThemeOpen] = useState(false)
  const [mapOpen, setMapOpen] = useState(false)
  const [size, setSize] = useState({ width: 1, height: 1 })
  const themeRef = useRef<HTMLDivElement>(null)
  const themeButtonRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const board = boardRef.current!
    const update = () => setSize({ width: board.clientWidth, height: board.clientHeight })
    const observer = new ResizeObserver(update)
    observer.observe(board); update()
    return () => observer.disconnect()
  }, [boardRef])
  useEffect(() => {
    if (!themeOpen) return
    const close = (event: PointerEvent) => { if (!themeRef.current?.contains(event.target as Node)) setThemeOpen(false) }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [themeOpen])
  useEffect(() => { if (!uiVisible) setThemeOpen(false) }, [uiVisible])
  const zoomTo = (zoom: number) => cameraStore.set(zoomAtCenter(cameraStore.getSnapshot(), size, zoom))
  return <div className="canvas-controls board-chrome" style={{ '--theme-color': resolveColor(colors.connectionColor, '#609fbb') } as CSSProperties}
    onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onKeyDown={(e) => {
      e.stopPropagation()
      if (e.key === 'Escape') {
        if (themeOpen) { setThemeOpen(false); themeButtonRef.current?.focus() }
        else setMapOpen(false)
      }
    }}>
    {uiVisible && <div className="theme-controls" ref={themeRef}>
      {themeOpen && <div className="theme-pop floating-panel" role="dialog" aria-label="新卡片与连线的默认颜色">
        <div className="theme-color-row theme-text-colors" role="group" aria-label="文本块默认颜色"><TextT size={18} aria-hidden="true" /><StylePalette color={colors.textColor} defaultLabel="白色" onChange={preferencesStore.setTextColor} /></div>
        <div className="theme-color-row" role="group" aria-label="连线默认颜色"><LineSegment size={18} aria-hidden="true" /><StylePalette color={colors.connectionColor} showDefault={false} onChange={(next) => preferencesStore.setConnectionColor(next ?? DEFAULT_CONNECTION_COLOR)} /></div>
      </div>}
      <IconButton ref={themeButtonRef} className="corner-button theme-button" icon={Palette} label="新卡片与连线的默认颜色" aria-expanded={themeOpen} active={themeOpen} onClick={() => setThemeOpen(!themeOpen)} />
    </div>}
    <div className="navigation-controls">
      {uiVisible && mapOpen && <div className="minimap-pop floating-panel">
        <Minimap doc={doc} camera={camera} size={size} />
        <IconButton className="minimap-fit" icon={CornersOut} label="缩放至全部内容" onClick={onFit} />
      </div>}
      {uiVisible && <div className="zoom-control">
        <button className="zoom-label" title="重置为 100%" aria-label="重置画布缩放" onClick={() => zoomTo(1)}>
          {Math.round(camera.zoom * 100)}%{Math.abs(camera.zoom - 1) > 0.005 && <X size={14} aria-hidden="true" />}
        </button>
        <input type="range" min={MIN_ZOOM * 100} max={MAX_ZOOM * 100} step={1} value={camera.zoom * 100} aria-label="画布缩放" aria-valuetext={`${Math.round(camera.zoom * 100)}%`} onChange={(e) => zoomTo(Number(e.target.value) / 100)} />
      </div>}
      <IconButton className="corner-button" icon={Presentation} label={uiVisible ? '隐藏界面' : '显示界面'} active={!uiVisible} onClick={onToggleUI} />
      <IconButton className="corner-button" icon={MapTrifold} label={mapOpen && uiVisible ? '隐藏画布预览' : '显示画布预览'} active={mapOpen && uiVisible} aria-expanded={mapOpen && uiVisible} onClick={() => { if (!uiVisible) onToggleUI(); setMapOpen(!mapOpen || !uiVisible) }} />
    </div>
  </div>
}

function Minimap({ doc, camera, size }: { doc: CanvasFile; camera: Camera; size: { width: number; height: number } }) {
  const dragRef = useRef<{ bounds: Rect; pointerId: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const viewport = viewportRect(camera, size)
  const bounds = dragRef.current?.bounds ?? minimapBounds(doc.nodes ?? [], viewport, 240 / 152)
  const byId = new Map((doc.nodes ?? []).map((node) => [node.id, node]))
  const navigate = (event: React.PointerEvent<SVGSVGElement>, map: Rect) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
    cameraStore.set(minimapCamera({ x: map.x + x * map.width, y: map.y + y * map.height }, size, cameraStore.getSnapshot().zoom, map, map.width / rect.width))
  }
  const endDrag = () => { dragRef.current = null; setDragging(false) }
  return <svg className={`minimap ${dragging ? 'dragging' : ''}`} viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`} role="application" aria-label="画布预览，点击或拖动导航，方向键平移" tabIndex={0}
    onPointerDown={(e) => {
      if (e.button !== 0) return
      e.preventDefault(); e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId)
      dragRef.current = { bounds, pointerId: e.pointerId }; setDragging(true); navigate(e, bounds)
    }}
    onPointerMove={(e) => { if (dragRef.current?.pointerId === e.pointerId) navigate(e, dragRef.current.bounds) }}
    onPointerUp={(e) => { if (dragRef.current?.pointerId === e.pointerId) { navigate(e, dragRef.current.bounds); endDrag(); e.currentTarget.releasePointerCapture(e.pointerId) } }}
    onPointerCancel={endDrag} onLostPointerCapture={endDrag}
    onKeyDown={(e) => {
      const direction: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
      const delta = direction[e.key]
      if (!delta) return
      e.preventDefault()
      const cam = cameraStore.getSnapshot(), step = e.shiftKey ? 160 : 40
      const viewport = viewportRect(cam, size)
      cameraStore.set(minimapCamera({ x: viewport.x + viewport.width / 2 + delta[0] * step / cam.zoom, y: viewport.y + viewport.height / 2 + delta[1] * step / cam.zoom }, size, cam.zoom, bounds, bounds.width / 240))
    }}>
    {(doc.nodes ?? []).filter((node) => node.type === 'group').map((node) => <rect key={node.id} x={node.x} y={node.y} width={node.width} height={node.height} rx={12} fill={resolveColor(node.color, '#d0dee5')} fillOpacity={0.15} stroke={resolveColor(node.color, '#b9cbd5')} vectorEffect="non-scaling-stroke" />)}
    {(doc.edges ?? []).map((edge) => {
      const geometry = edgeGeometry(edge, byId)
      return geometry && <path key={edge.id} d={geometry.path} stroke={resolveColor(edge.color, '#609fbb')} fill="none" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    })}
    {(doc.nodes ?? []).filter((node) => node.type !== 'group').map((node) => node.type === 'draw'
      ? <path key={node.id} transform={`translate(${node.x}, ${node.y})`} d={strokePath(node.points)} fill="none" stroke={resolveColor(node.color, '#71697a')} strokeWidth={node.strokeWidth ?? 3} strokeLinecap="round" />
      : node.type === 'rectangle' ? <rect key={node.id} x={node.x} y={node.y} width={node.width} height={node.height} fill="none" stroke={resolveColor(node.color, '#76717f')} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      : <rect key={node.id} x={node.x} y={node.y} width={node.width} height={node.height} rx={8} fill={resolveColor(node.color, '#b3c4cd')} />)}
    <rect className="minimap-viewport" x={viewport.x} y={viewport.y} width={viewport.width} height={viewport.height} rx={bounds.width * 0.025} vectorEffect="non-scaling-stroke" />
  </svg>
}
