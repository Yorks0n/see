import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { X } from './icons'
import { cameraStore, clampZoom } from '../store/camera'
import { documentStore } from '../store/document'
import { hitTest, renderInteractiveScene, renderStaticScene } from '../render/renderer'
import { createImageCard, createTextCard, deleteNodes, duplicateNodes, expandSelection, finishConnection, groupNodes, moveConnection, startConnection, tools, ToolState, updateMembership, viewportCenterWorld, type DrawStyle, type PointerInfo, type ToolId, type ToolEnv } from '../tools/tools'
import { saveLocal, saveRecovery } from '../persistence'
import type { DrawPoint, ImageNode } from '../types'
import { CardLayer, StrokeWidths } from './CardLayer'
import { ConnectionLayer, type ConnectionPreview } from './ConnectionLayer'
import { ImageCrop } from './ImageCrop'
import { IconButton } from './IconButton'
import { StylePalette } from './StylePalette'
import { CanvasControls } from './CanvasControls'
import { preferencesStore } from '../store/preferences'

const IMAGE_URL_RE = /^https?:\/\/\S+\.(png|jpe?g|gif|webp|avif|svg|bmp)(\?\S*)?$/i
const isTypingTarget = (e: Event) => { const t = e.target as HTMLElement | null; return !!t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) }
export function Board(props: { tool: ToolId; setTool: (t: ToolId) => void; newNodeId: string | null; uiVisible: boolean; onToggleUI: () => void }) {
  const doc = useSyncExternalStore(documentStore.subscribe, documentStore.getSnapshot)
  const camera = useSyncExternalStore(cameraStore.subscribe, cameraStore.getSnapshot)
  const defaultColors = useSyncExternalStore(preferencesStore.subscribe, preferencesStore.getSnapshot)
  const staticRef = useRef<HTMLCanvasElement>(null), interactiveRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const boardTopRef = useRef<number | null>(null)
  const toolStateRef = useRef(new ToolState())
  const dragToolRef = useRef<ToolId>('select')
  const toolRef = useRef(props.tool)
  const spaceRestoreRef = useRef<ToolId | null>(null)
  const lastWorldRef = useRef<{ x: number; y: number } | null>(null)
  const draftCardRef = useRef<string | null>(null)
  const redraw = useRef<() => void>(() => {})
  toolRef.current = props.tool
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [edgeId, setEdgeId] = useState<string | null>(null)
  const [dragPreview, setDragPreview] = useState<ConnectionPreview | null>(null)
  const [marquee, setMarquee] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
  const [paintTrail, setPaintTrail] = useState<DrawPoint[] | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [activeStroke, setActiveStroke] = useState<{ x: number; y: number }[] | null>(null)
  const [drawStyle, setDrawStyle] = useState<DrawStyle>({ strokeWidth: 4 })
  const [interacting, setInteracting] = useState(false)
  const [cropId, setCropId] = useState<string | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const sceneRef = useRef({ doc, camera, selection, marquee, paintTrail, activeStroke, drawStyle })
  sceneRef.current = { doc, camera, selection, marquee, paintTrail, activeStroke, drawStyle }
  const env: ToolEnv = { selection, setSelection, setDragPreview, setMarquee, setPaintTrail, setEditingId, setTool: props.setTool, drawStyle }
  const state = toolStateRef.current
  const cropNode = cropId ? doc.nodes?.find((n): n is ImageNode => n.id === cropId && n.type === 'image') : null
  useEffect(() => { if (cropId && (!selection.has(cropId) || selection.size !== 1 || props.tool !== 'select' || !cropNode)) setCropId(null) }, [selection, cropId, cropNode, props.tool])

  useLayoutEffect(() => {
    const top = containerRef.current!.getBoundingClientRect().top
    if (boardTopRef.current !== null) cameraStore.set({ y: cameraStore.getSnapshot().y + boardTopRef.current - top })
    boardTopRef.current = top
  }, [props.uiVisible])
  useEffect(() => { if (props.newNodeId) { setSelection(new Set([props.newNodeId])); setEdgeId(null) } }, [props.newNodeId])
  useEffect(() => {
    let saveTimer = 0
    const scheduleSave = () => { clearTimeout(saveTimer); saveTimer = window.setTimeout(() => void saveLocal(), 300) }
    const unsubDoc = documentStore.subscribe(scheduleSave), unsubCam = cameraStore.subscribe(scheduleSave)
    const flush = () => { saveRecovery(); void saveLocal() }
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => { unsubDoc(); unsubCam(); clearTimeout(saveTimer); window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', onVisibility) }
  }, [])
  useEffect(() => {
    const container = containerRef.current!, staticCanvas = staticRef.current!, interactiveCanvas = interactiveRef.current!
    let raf = 0
    const render = () => {
      raf = 0
      const dpr = window.devicePixelRatio || 1, w = container.clientWidth, h = container.clientHeight
      for (const c of [staticCanvas, interactiveCanvas]) if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr) }
      const sctx = staticCanvas.getContext('2d'), ictx = interactiveCanvas.getContext('2d')
      if (sctx) renderStaticScene(sctx, sceneRef.current, dpr, w, h)
      if (ictx) renderInteractiveScene(ictx, sceneRef.current, dpr, w, h)
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(render) }
    redraw.current = schedule
    const ro = new ResizeObserver(() => { boardTopRef.current = container.getBoundingClientRect().top; schedule() })
    ro.observe(container); schedule()
    return () => { ro.disconnect(); cancelAnimationFrame(raf) }
  }, [])
  useEffect(() => { redraw.current() }, [doc, camera, selection, marquee, paintTrail, activeStroke, drawStyle])
  const toPointerInfo = useCallback((e: { clientX: number; clientY: number; shiftKey: boolean; target?: EventTarget | null }): PointerInfo => {
    const r = containerRef.current!.getBoundingClientRect()
    const screen = { x: e.clientX - r.left, y: e.clientY - r.top }
    const nodeId = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId : undefined
    return { screen, world: cameraStore.screenToWorld(screen.x, screen.y), shiftKey: e.shiftKey, nodeId }
  }, [])
  const cancel = useCallback(() => {
    const drag = toolStateRef.current.dragging
    if (drag?.type === 'marquee') setSelection(new Set(drag.initialSelection))
    toolStateRef.current.dragging = null
    documentStore.cancelInteraction()
    if (draftCardRef.current) {
      const id = draftCardRef.current
      draftCardRef.current = null
      setEditingId(null)
      setSelection((selected) => new Set([...selected].filter((nodeId) => nodeId !== id)))
    }
    setDragPreview(null); setMarquee(null); setPaintTrail(null); setActiveStroke(null); setInteracting(false)
  }, [])
  const onTextEditDone = (id: string, text: string) => {
    if (draftCardRef.current === id) {
      draftCardRef.current = null
      if (!text.trim()) {
        documentStore.cancelInteraction()
        setSelection((selected) => new Set([...selected].filter((nodeId) => nodeId !== id)))
        setEditingId(null)
        return
      }
    }
    documentStore.updateNode(id, { text })
    setEditingId(null)
  }
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return
    if ((e.target as HTMLElement).isContentEditable) return
    if (cropId) setCropId(null)
    const focused = document.activeElement as HTMLElement | null
    if (focused?.isContentEditable) focused.blur()
    const info = toPointerInfo(e)
    containerRef.current?.setPointerCapture(e.pointerId)
    setEdgeId(null)
    if (e.button === 1 || props.tool === 'hand') { dragToolRef.current = 'hand'; tools.hand.onPointerDown?.(info, env, state); setInteracting(true); return }
    documentStore.beginInteraction()
    const connectId = (e.target as Element).closest<HTMLElement>('[data-connect-id]')?.dataset.connectId
    if (connectId && props.tool === 'select') { startConnection(connectId, info, env, state); setInteracting(true); return }
    dragToolRef.current = props.tool
    tools[props.tool].onPointerDown?.(info, env, state)
    setInteracting(!!state.dragging)
    if (state.dragging?.type === 'draw') setActiveStroke([...(state.dragging.points ?? [])])
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const info = toPointerInfo(e)
    lastWorldRef.current = info.world
    if (state.dragging?.type === 'connect') moveConnection(info, env, state)
    else if (state.dragging?.type === 'draw' || state.dragging?.type === 'marquee') {
      const tool = state.dragging.type === 'draw' ? tools.draw : tools.select
      const points = e.nativeEvent.getCoalescedEvents?.() ?? []
      for (const p of points) tool.onPointerMove?.(toPointerInfo(p), env, state)
      tool.onPointerMove?.(info, env, state)
      if (state.dragging?.type === 'draw') setActiveStroke([...(state.dragging.points ?? [])])
    } else tools[dragToolRef.current].onPointerMove?.(info, env, state)
  }
  const onPointerUp = (e: React.PointerEvent) => {
    if (!state.dragging) return
    const info = toPointerInfo(e)
    const panning = state.dragging.type === 'pan'
    if (state.dragging.type === 'connect') finishConnection(info, env, state)
    else tools[dragToolRef.current].onPointerUp?.(info, env, state)
    if (!panning) documentStore.endInteraction()
    if (containerRef.current?.hasPointerCapture(e.pointerId)) containerRef.current.releasePointerCapture(e.pointerId)
    setActiveStroke(null); setInteracting(false)
  }
  const onDoubleClick = (e: React.MouseEvent) => {
    if (props.tool !== 'select') return
    const info = toPointerInfo(e), hit = hitTest(documentStore.getSnapshot(), info.world.x, info.world.y)
    if (!hit || (hit.type === 'group' && !info.nodeId)) {
      documentStore.beginInteraction()
      const node = createTextCard(info.world)
      draftCardRef.current = node.id
      setSelection(new Set([node.id])); setEditingId(node.id)
    } else tools.select.onDoubleClick?.(info, env)
  }
  useEffect(() => {
    const board = containerRef.current!
    const onWheel = (e: WheelEvent) => {
      if ((e.target as Element).closest('.floating-panel, .board-chrome')) return
      e.preventDefault()
      const cam = cameraStore.getSnapshot(), unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? board.clientHeight : 1
      if (e.ctrlKey || e.metaKey) {
        const info = toPointerInfo(e), zoom = clampZoom(cam.zoom * Math.exp(-e.deltaY * 0.008))
        cameraStore.set({ zoom, x: info.screen.x - info.world.x * zoom, y: info.screen.y - info.world.y * zoom })
      } else cameraStore.set({ x: cam.x - (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * unit, y: cam.y - (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * unit })
    }
    board.addEventListener('wheel', onWheel, { passive: false })
    return () => board.removeEventListener('wheel', onWheel)
  }, [toPointerInfo])
  useEffect(() => {
    const updateSelectionModifier = (shiftKey: boolean) => {
      const drag = state.dragging
      if (drag?.type !== 'marquee') return
      const world = drag.currentWorld ?? drag.startWorld
      tools.select.onPointerMove?.({ world, screen: cameraStore.worldToScreen(world.x, world.y), shiftKey }, env, state)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e) || cropId) return
      if (e.key === 'Shift' && state.dragging?.type === 'marquee') { e.preventDefault(); updateSelectionModifier(true); return }
      if (e.key === 'Enter' && e.target instanceof HTMLButtonElement) return
      if (e.key === 'Escape') { cancel(); setSelection(new Set()); setEdgeId(null); setHelpOpen(false); props.setTool('select'); return }
      if (e.code === 'Space') {
        if (!e.repeat) { e.preventDefault(); if (spaceRestoreRef.current === null) { spaceRestoreRef.current = toolRef.current; props.setTool('hand') } }
        return
      }
      const mod = e.metaKey || e.ctrlKey, key = e.key.toLowerCase()
      if (mod && key === 'z') { e.preventDefault(); cancel(); if (e.shiftKey) documentStore.redo(); else documentStore.undo(); return }
      if (mod && key === 'y') { e.preventDefault(); documentStore.redo(); return }
      if (mod && key === 'd') { e.preventDefault(); if (selection.size) setSelection(duplicateNodes(selection)); return }
      if (mod && key === 'a') { e.preventDefault(); setSelection(new Set((documentStore.getSnapshot().nodes ?? []).map((n) => n.id))); setEdgeId(null); return }
      if (mod && key === 'g') {
        e.preventDefault()
        if (e.shiftKey) {
          documentStore.transact(() => { const next = new Set<string>(); for (const id of selection) { const g = documentStore.getNode(id); if (g?.type === 'group') { g.memberIds?.forEach((member) => next.add(member)); documentStore.deleteNode(id) } else next.add(id) } setSelection(next) })
        } else { const group = groupNodes(selection); if (group) setSelection(new Set([group.id])) }
        return
      }
      if (mod) return
      if (state.dragging) return
      const map: Record<string, ToolId> = { v: 'select', '1': 'select', h: 'hand', '2': 'hand', b: 'box', '3': 'box', d: 'draw', '4': 'draw' }
      if (map[key]) { props.setTool(map[key]); return }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); if (edgeId) { documentStore.deleteEdge(edgeId); setEdgeId(null) } else { deleteNodes(selection); setSelection(new Set()) } return }
      if (e.key === 'Enter' && selection.size === 1) {
        const node = documentStore.getNode([...selection][0])
        if (node?.type === 'image') setCropId(node.id)
        else if (node?.type === 'text' || node?.type === 'group') setEditingId(node.id)
        return
      }
      if (e.key.startsWith('Arrow') && selection.size) {
        e.preventDefault()
        const step = e.shiftKey ? 10 : 1, dx = key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0, dy = key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0
        documentStore.transact(() => {
          const ids = expandSelection(selection)
          documentStore.updateNodes(new Map([...ids].flatMap((id) => { const n = documentStore.getNode(id); return n ? [[id, { x: n.x + dx, y: n.y + dy }] as const] : [] })))
          updateMembership(ids)
        })
      }
      if (e.key === '?') setHelpOpen((v) => !v)
    }
    const restoreHand = () => { if (spaceRestoreRef.current !== null) { props.setTool(spaceRestoreRef.current); spaceRestoreRef.current = null } }
    const onKeyUp = (e: KeyboardEvent) => { if (e.code === 'Space') restoreHand(); if (e.key === 'Shift') updateSelectionModifier(e.shiftKey) }
    const onBlur = () => { restoreHand(); if (state.dragging) cancel() }
    window.addEventListener('keydown', onKeyDown); window.addEventListener('keyup', onKeyUp); window.addEventListener('blur', onBlur)
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); window.removeEventListener('blur', onBlur) }
  }, [selection, edgeId, cropId, props.setTool, cancel, state])
  const addFiles = useCallback((files: File[], origin: { x: number; y: number }) => {
    files.forEach((file, i) => {
      const reader = new FileReader()
      reader.onload = () => { if (typeof reader.result === 'string') { const n = createImageCard({ x: origin.x + i * 28, y: origin.y + i * 28 }, reader.result); setSelection((s) => new Set([...s, n.id])); props.setTool('select') } }
      reader.readAsDataURL(file)
    })
  }, [props.setTool])
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isTypingTarget(e) || cropId) return
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'))
      const origin = lastWorldRef.current ?? viewportCenterWorld()
      if (files.length) { e.preventDefault(); setSelection(new Set()); addFiles(files, origin); return }
      const text = e.clipboardData?.getData('text/plain')?.trim() ?? ''
      if (text) {
        e.preventDefault()
        if (IMAGE_URL_RE.test(text)) { const n = createImageCard(origin, text); setSelection(new Set([n.id])) }
        else documentStore.transact(() => { const n = createTextCard(origin); documentStore.updateNode(n.id, { text }); setSelection(new Set([n.id])) })
        props.setTool('select')
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [addFiles, cropId, props.setTool])
  const fit = () => {
    const nodes = documentStore.getSnapshot().nodes ?? []
    if (!nodes.length) { cameraStore.set({ x: 0, y: 0, zoom: 1 }); return }
    const x = Math.min(...nodes.map((n) => n.x)), y = Math.min(...nodes.map((n) => n.y))
    const w = Math.max(...nodes.map((n) => n.x + n.width)) - x, h = Math.max(...nodes.map((n) => n.y + n.height)) - y
    const b = containerRef.current!, zoom = clampZoom(Math.min(1.5, (b.clientWidth - 160) / Math.max(1, w), (b.clientHeight - 180) / Math.max(1, h)))
    cameraStore.set({ zoom, x: (b.clientWidth - w * zoom) / 2 - x * zoom, y: (b.clientHeight - h * zoom) / 2 - y * zoom })
  }
  return <div ref={containerRef} className={`board tool-${props.tool} ${interacting ? 'interacting' : ''} ${paintTrail ? 'paint-selecting' : ''} ${marquee ? 'box-selecting' : ''}`} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={cancel} onLostPointerCapture={() => { if (state.dragging) cancel() }} onDoubleClick={onDoubleClick}
    onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragOver(true) } }} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false) }}
    onDrop={(e) => { e.preventDefault(); setDragOver(false); setSelection(new Set()); addFiles(Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/')), toPointerInfo(e).world) }}>
    <canvas ref={staticRef} className="canvas static" /><canvas ref={interactiveRef} className="canvas interactive" />
    <ConnectionLayer doc={doc} camera={camera} preview={dragPreview} previewColor={defaultColors.connectionColor} selectedId={edgeId} onSelect={(id) => { setEdgeId(id); setSelection(new Set()) }} interactive={props.tool === 'select' && !interacting} />
    <CardLayer doc={doc} camera={camera} selection={selection} setSelection={setSelection} editingId={editingId} setEditingId={setEditingId} onTextEditDone={onTextEditDone} tool={props.tool} targetId={dragPreview?.targetId} cropId={cropId} onImageCrop={(node) => setCropId((id) => id === node.id ? null : node.id)} interacting={interacting} />
    {props.tool === 'draw' && <div className="draw-settings floating-panel board-chrome" onPointerDown={(e) => e.stopPropagation()}><StylePalette color={drawStyle.color} onChange={(color) => setDrawStyle((s) => ({ ...s, color }))} /><StrokeWidths value={drawStyle.strokeWidth} onChange={(strokeWidth) => setDrawStyle((s) => ({ ...s, strokeWidth }))} /></div>}
    <CanvasControls boardRef={containerRef} doc={doc} camera={camera} uiVisible={props.uiVisible} onToggleUI={props.onToggleUI} onFit={fit} />
    {helpOpen && <div className="help-pop floating-panel board-chrome" onPointerDown={(e) => e.stopPropagation()}><div className="popover-heading"><span>操作帮助</span><IconButton icon={X} label="关闭帮助" onClick={() => setHelpOpen(false)} /></div><dl><dt>新建想法</dt><dd>双击空白 / 粘贴文字</dd><dt>连接 block</dt><dd>从右上圆点拖到另一个 block</dd><dt>延伸想法</dt><dd>从圆点拖到空白处</dd><dt>图片编辑</dt><dd>单击选择，双击裁剪</dd><dt>等比缩放</dt><dd>拖动右下角手柄，Shift 自由缩放</dd><dt>多选 / 分组</dt><dd>Shift 点选 / ⌘ Ctrl G</dd><dt>撤销 / 重做</dt><dd>⌘ Ctrl Z / ⇧ ⌘ Ctrl Z</dd><dt>平移 / 缩放</dt><dd>空格拖动 / ⌘ Ctrl 滚轮</dd></dl></div>}
    {dragOver && <div className="drop-overlay">松开以添加图片</div>}
    {cropNode && <ImageCrop key={cropNode.id} node={cropNode} camera={camera} onClose={() => setCropId(null)} />}
  </div>
}
