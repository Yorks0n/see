import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { X } from './icons'
import { cameraStore, clampZoom } from '../store/camera'
import { documentStore } from '../store/document'
import { hitTest, renderInteractiveScene, renderStaticScene } from '../render/renderer'
import { createImageCard, createTextCard, deleteNodes, duplicateNodes, expandSelection, finishConnection, groupNodes, ungroupNodes, moveConnection, startConnection, tools, ToolState, updateMembership, viewportCenterWorld, type DrawStyle, type PointerInfo, type ToolId, type ToolEnv } from '../tools/tools'
import { markDirty, persistenceStore, saveLocal, saveRecovery } from '../persistence'
import type { DrawPoint, ImageNode } from '../types'
import { CardLayer, StrokeWidths } from './CardLayer'
import { ConnectionLayer, type ConnectionPreview } from './ConnectionLayer'
import { ImageCrop } from './ImageCrop'
import { IconButton } from './IconButton'
import { StylePalette } from './StylePalette'
import { CanvasControls } from './CanvasControls'
import { preferencesStore } from '../store/preferences'
import { copySelection, copyToSystemClipboard, pasteSelection, readClipboard, readSystemClipboard, writeClipboard } from '../tools/clipboard'
import { runBoardCommand, type BoardCommand } from '../shortcuts'
import { selectionSVG, svgPNG, downloadBlob } from '../tools/export'
import { ShortcutsDialog } from './ShortcutsDialog'
import { CanvasContextMenu, type ContextTarget } from './CanvasContextMenu'

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
  const lastScreenRef = useRef<{ x: number; y: number } | null>(null)
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
  const [contextMenu, setContextMenu] = useState<ContextTarget | null>(null)
  const [error, setError] = useState('')
  const [listDrop, setListDrop] = useState<{ id: string; y: number } | null>(null)
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
    const save = () => {
      saveTimer = 0
      if (persistenceStore.getSnapshot().state !== 'conflict') void saveLocal().catch(() => {})
    }
    const scheduleSave = () => {
      markDirty()
      // Do not postpone indefinitely while typing or dragging.
      if (!saveTimer) saveTimer = window.setTimeout(save, 250)
    }
    const unsubDoc = documentStore.subscribe(scheduleSave), unsubCam = cameraStore.subscribe(scheduleSave)
    const flush = () => { clearTimeout(saveTimer); saveRecovery(); save() }
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush() }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (persistenceStore.getSnapshot().state === 'saved') return
      flush()
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', beforeUnload)
    document.addEventListener('visibilitychange', onVisibility)
    return () => { unsubDoc(); unsubCam(); clearTimeout(saveTimer); window.removeEventListener('pagehide', flush); window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('visibilitychange', onVisibility) }
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
    setListDrop(null)
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
    setContextMenu(null)
    if (cropId) setCropId(null)
    const focused = document.activeElement as HTMLElement | null
    if (focused?.isContentEditable) focused.blur()
    const info = toPointerInfo(e)
    lastScreenRef.current = info.screen
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
    if (state.dragging?.type === 'move' && state.dragging.origins) {
      const moved = state.dragging.origins
      const canDrop = [...moved.keys()].every((id) => ['text', 'image'].includes(documentStore.getNode(id)?.type ?? ''))
      const list = canDrop ? (doc.nodes ?? []).find((n) => n.type === 'group' && n.layout === 'list' && info.world.x >= n.x && info.world.x <= n.x + n.width && info.world.y >= n.y && info.world.y <= n.y + n.height) : undefined
      if (list?.type === 'group') {
        const members = (list.memberIds ?? []).flatMap((id) => { const n = documentStore.getNode(id); return n && !moved.has(id) ? [n] : [] })
        const next = members.find((n) => info.world.y < n.y + n.height / 2)
        const last = members[members.length - 1]
        setListDrop({ id: list.id, y: next ? next.y - 6 : last ? last.y + last.height + 6 : list.y + 44 })
      } else setListDrop(null)
    }
    lastScreenRef.current = (e.target as Element).closest('.floating-panel, .board-chrome') ? null : info.screen
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
    setListDrop(null)
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
      if (isTypingTarget(e) || cropId || helpOpen || contextMenu) return
      if (e.key === 'Shift' && state.dragging?.type === 'marquee') { e.preventDefault(); updateSelectionModifier(true); return }
      if (e.key === 'Enter' && e.target instanceof HTMLButtonElement) return
      if (e.key === 'Escape') { cancel(); setSelection(new Set()); setEdgeId(null); setHelpOpen(false); props.setTool('select'); return }
      if (e.code === 'Space') {
        if (!e.repeat) { e.preventDefault(); if (spaceRestoreRef.current === null) { spaceRestoreRef.current = toolRef.current; props.setTool('hand') } }
        return
      }
      const mod = e.metaKey || e.ctrlKey, key = e.key.toLowerCase()
      if (mod && e.shiftKey && key === 'c') { e.preventDefault(); runBoardCommand('copy-svg'); return }
      if (mod && key === '\\') { e.preventDefault(); props.onToggleUI(); return }
      if (!mod && e.shiftKey && e.code === 'Digit1') { e.preventDefault(); runBoardCommand('fit'); return }
      if (!mod && e.shiftKey && e.code === 'Digit0') { e.preventDefault(); runBoardCommand('reset-zoom'); return }
      if (mod && key === 'z') { e.preventDefault(); cancel(); if (e.shiftKey) documentStore.redo(); else documentStore.undo(); return }
      if (mod && key === 'y') { e.preventDefault(); documentStore.redo(); return }
      if (mod && key === 'd') { e.preventDefault(); if (selection.size) setSelection(duplicateNodes(selection)); return }
      if (mod && key === 'a') { e.preventDefault(); setSelection(new Set((documentStore.getSnapshot().nodes ?? []).map((n) => n.id))); setEdgeId(null); return }
      if (mod && key === 'g') {
        e.preventDefault()
        if (e.shiftKey) {
          setSelection(ungroupNodes(selection))
        } else { const group = groupNodes(selection); if (group) setSelection(new Set([group.id])) }
        return
      }
      if (mod) return
      if (state.dragging) return
      if (key === 't') { e.preventDefault(); runBoardCommand('text'); return }
      const map: Record<string, ToolId> = { v: 'select', '1': 'select', h: 'hand', '2': 'hand', b: 'box', '3': 'box', d: 'draw', '4': 'draw', l: 'list' }
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
  }, [selection, edgeId, cropId, props.setTool, props.onToggleUI, helpOpen, contextMenu, cancel, state])
  const addFiles = useCallback((files: File[], origin: { x: number; y: number }) => {
    files.forEach((file, i) => {
      const reader = new FileReader()
      reader.onload = () => { if (typeof reader.result === 'string') { const n = createImageCard({ x: origin.x + i * 28, y: origin.y + i * 28 }, reader.result); setSelection((s) => new Set([...s, n.id])); props.setTool('select') } }
      reader.readAsDataURL(file)
    })
  }, [props.setTool])
  useEffect(() => {
    const onCopy = (e: ClipboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e) || cropId || state.dragging || !e.clipboardData) return
      const content = copySelection(selection)
      if (!content) return
      writeClipboard(e.clipboardData, content)
      e.preventDefault()
      if (e.type === 'cut') { deleteNodes(selection); setSelection(new Set()) }
    }
    const onPaste = (e: ClipboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e) || cropId || state.dragging) return
      const pointer = lastScreenRef.current, board = containerRef.current!
      const origin = pointer && pointer.x >= 0 && pointer.y >= 0 && pointer.x < board.clientWidth && pointer.y < board.clientHeight
        ? cameraStore.screenToWorld(pointer.x, pointer.y) : viewportCenterWorld()
      const content = e.clipboardData ? readClipboard(e.clipboardData) : null
      if (content) {
        e.preventDefault()
        setSelection(pasteSelection(content, origin)); setEdgeId(null); props.setTool('select')
        return
      }
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'))
      if (files.length) { e.preventDefault(); setSelection(new Set()); addFiles(files, origin); return }
      const text = e.clipboardData?.getData('text/plain')?.trim() ?? ''
      if (text) {
        e.preventDefault()
        if (IMAGE_URL_RE.test(text)) { const n = createImageCard(origin, text); setSelection(new Set([n.id])) }
        else documentStore.transact(() => { const n = createTextCard(origin); documentStore.updateNode(n.id, { text }); setSelection(new Set([n.id])) })
        props.setTool('select')
      }
    }
    window.addEventListener('copy', onCopy); window.addEventListener('cut', onCopy); window.addEventListener('paste', onPaste)
    return () => { window.removeEventListener('copy', onCopy); window.removeEventListener('cut', onCopy); window.removeEventListener('paste', onPaste) }
  }, [addFiles, selection, cropId, props.setTool, state])
  const fit = () => {
    const nodes = documentStore.getSnapshot().nodes ?? []
    if (!nodes.length) { cameraStore.set({ x: 0, y: 0, zoom: 1 }); return }
    const x = Math.min(...nodes.map((n) => n.x)), y = Math.min(...nodes.map((n) => n.y))
    const w = Math.max(...nodes.map((n) => n.x + n.width)) - x, h = Math.max(...nodes.map((n) => n.y + n.height)) - y
    const b = containerRef.current!, zoom = clampZoom(Math.min(1.5, (b.clientWidth - 160) / Math.max(1, w), (b.clientHeight - 180) / Math.max(1, h)))
    cameraStore.set({ zoom, x: (b.clientWidth - w * zoom) / 2 - x * zoom, y: (b.clientHeight - h * zoom) / 2 - y * zoom })
  }
  const executeCommand = (command: BoardCommand, origin = viewportCenterWorld()) => {
    const fail = (error: unknown) => setError(error instanceof Error ? error.message : '操作失败，请重试')
    if (state.dragging) cancel()
    if (command === 'undo') documentStore.undo()
    if (command === 'redo') documentStore.redo()
    if (command === 'select-all') { setSelection(new Set((documentStore.getSnapshot().nodes ?? []).map((n) => n.id))); setEdgeId(null) }
    if (command === 'delete') {
      if (edgeId) { documentStore.deleteEdge(edgeId); setEdgeId(null) }
      else { deleteNodes(selection); setSelection(new Set()) }
    }
    if (command === 'duplicate') setSelection(duplicateNodes(selection))
    if (command === 'group') { const group = groupNodes(selection); if (group) setSelection(new Set([group.id])) }
    if (command === 'ungroup') setSelection(ungroupNodes(selection))
    if (command === 'fit') fit()
    if (command === 'reset-zoom') {
      const b = containerRef.current!, center = cameraStore.screenToWorld(b.clientWidth / 2, b.clientHeight / 2)
      cameraStore.set({ zoom: 1, x: b.clientWidth / 2 - center.x, y: b.clientHeight / 2 - center.y })
    }
    if (command === 'toggle-ui') props.onToggleUI()
    if (command === 'shortcuts') setHelpOpen(true)
    if (command === 'text') {
      documentStore.beginInteraction()
      const node = createTextCard(origin)
      draftCardRef.current = node.id
      setSelection(new Set([node.id])); setEdgeId(null); setEditingId(node.id); props.setTool('select')
    }
    if (command === 'copy' || command === 'cut') {
      const copied = new Set(selection)
      void copyToSystemClipboard(copied).then((success) => {
        if (success && command === 'cut') { deleteNodes(copied); setSelection(new Set()) }
      }).catch(fail)
    }
    if (command === 'paste') {
      void readSystemClipboard().then((data) => {
        const content = readClipboard(data)
        if (content) { setSelection(pasteSelection(content, origin)); setEdgeId(null); props.setTool('select'); return }
        const files = Array.from(data.files).filter((file) => file.type.startsWith('image/'))
        if (files.length) { setSelection(new Set()); addFiles(files, origin); return }
        const text = data.getData('text/plain')
        if (text.trim()) {
          documentStore.transact(() => {
            const node = IMAGE_URL_RE.test(text) ? createImageCard(origin, text) : createTextCard(origin)
            if (node.type === 'text') documentStore.updateNode(node.id, { text })
            setSelection(new Set([node.id]))
          })
          setEdgeId(null); props.setTool('select')
        }
      }).catch(fail)
    }
    if (['copy-svg', 'copy-png', 'export-svg', 'export-png'].includes(command)) {
      const svg = selectionSVG(documentStore.getSnapshot(), selection)
      if (command === 'copy-svg') void navigator.clipboard.write([new ClipboardItem({ 'text/plain': svg.then((value) => new Blob([value], { type: 'text/plain' })) })]).catch(fail)
      else if (command === 'copy-png') void navigator.clipboard.write([new ClipboardItem({ 'image/png': svg.then(svgPNG) })]).catch(fail)
      else void svg.then(async (value) => {
        const png = command === 'export-png'
        downloadBlob(png ? await svgPNG(value) : new Blob([value], { type: 'image/svg+xml' }), `${documentStore.getSnapshot().meta?.name || '白板'}.${png ? 'png' : 'svg'}`)
      }).catch(fail)
    }
  }
  useEffect(() => {
    const handle = (event: Event) => executeCommand((event as CustomEvent<BoardCommand>).detail)
    window.addEventListener('see-command', handle)
    return () => window.removeEventListener('see-command', handle)
  })
  const onContextMenu = (e: React.MouseEvent) => {
    if (isTypingTarget(e.nativeEvent) || (e.target as Element).closest('.floating-panel, .board-chrome')) return
    e.preventDefault()
    if (state.dragging) cancel()
    const info = toPointerInfo(e), target = e.target as Element
    const connectionId = target.closest<HTMLElement>('[data-edge-id], [data-edge-label-id]')?.dataset
    const clickedEdge = connectionId?.edgeId ?? connectionId?.edgeLabelId
    const node = clickedEdge ? null : (info.nodeId ? documentStore.getNode(info.nodeId) : hitTest(doc, info.world.x, info.world.y))
    if (clickedEdge) { setEdgeId(clickedEdge); setSelection(new Set()) }
    else { setEdgeId(null); if (node) { if (!selection.has(node.id)) setSelection(new Set([node.id])) } else setSelection(new Set()) }
    setCropId(null); props.setTool('select')
    setContextMenu({ x: e.clientX, y: e.clientY, world: info.world, nodeId: node?.id, edgeId: clickedEdge })
  }
  return <div ref={containerRef} className={`board tool-${props.tool} ${interacting ? 'interacting' : ''} ${paintTrail ? 'paint-selecting' : ''} ${marquee ? 'box-selecting' : ''}`} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerLeave={() => { lastScreenRef.current = null }} onPointerUp={onPointerUp} onPointerCancel={cancel} onLostPointerCapture={() => { if (state.dragging) cancel() }} onDoubleClick={onDoubleClick} onContextMenu={onContextMenu}
    onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragOver(true) } }} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false) }}
    onDrop={(e) => { e.preventDefault(); setDragOver(false); setSelection(new Set()); addFiles(Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/')), toPointerInfo(e).world) }}>
    <canvas ref={staticRef} className="canvas static" /><canvas ref={interactiveRef} className="canvas interactive" />
    {listDrop && (() => { const list = doc.nodes?.find((n) => n.id === listDrop.id); return list && <><div className="list-drop-outline" style={{ left: list.x * camera.zoom + camera.x, top: list.y * camera.zoom + camera.y, width: list.width * camera.zoom, height: list.height * camera.zoom }} /><div className="list-insertion" style={{ left: (list.x + 12) * camera.zoom + camera.x, top: listDrop.y * camera.zoom + camera.y, width: (list.width - 24) * camera.zoom }} /></> })()}
    <ConnectionLayer doc={doc} camera={camera} preview={dragPreview} previewColor={defaultColors.connectionColor} selectedId={edgeId} onSelect={(id) => { setEdgeId(id); setSelection(new Set()) }} interactive={props.tool === 'select' && !interacting} />
    <CardLayer doc={doc} camera={camera} selection={selection} setSelection={setSelection} editingId={editingId} setEditingId={setEditingId} onTextEditDone={onTextEditDone} tool={props.tool} targetId={dragPreview?.targetId} cropId={cropId} onImageCrop={(node) => setCropId((id) => id === node.id ? null : node.id)} interacting={interacting} />
    {props.tool === 'draw' && <div className="draw-settings floating-panel board-chrome" onPointerDown={(e) => e.stopPropagation()}><StylePalette color={drawStyle.color} onChange={(color) => setDrawStyle((s) => ({ ...s, color }))} /><StrokeWidths value={drawStyle.strokeWidth} onChange={(strokeWidth) => setDrawStyle((s) => ({ ...s, strokeWidth }))} /></div>}
    <CanvasControls boardRef={containerRef} doc={doc} camera={camera} uiVisible={props.uiVisible} onToggleUI={props.onToggleUI} onFit={fit} />
    {helpOpen && <ShortcutsDialog onClose={() => setHelpOpen(false)} />}
    {contextMenu && <CanvasContextMenu target={contextMenu} selection={selection} setSelection={setSelection} onClose={() => setContextMenu(null)} onCommand={executeCommand} onEdit={setEditingId} onCrop={setCropId} onError={setError} />}
    {error && <div className="board-toast floating-panel board-chrome" role="alert" onPointerDown={(e) => e.stopPropagation()}>{error}<IconButton icon={X} label="关闭提示" onClick={() => setError('')} /></div>}
    {dragOver && <div className="drop-overlay">松开以添加图片</div>}
    {cropNode && <ImageCrop key={cropNode.id} node={cropNode} camera={camera} onClose={() => setCropId(null)} />}
  </div>
}
