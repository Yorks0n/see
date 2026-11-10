import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { cameraStore } from '../store/camera'
import { documentStore } from '../store/document'
import { hitTest, renderInteractiveScene, renderStaticScene } from '../render/renderer'
import { createImageCard, duplicateNodes, tools, ToolState, viewportCenterWorld, type PointerInfo, type ToolId, type ToolEnv } from '../tools/tools'
import { saveLocal } from '../persistence'
import { CardLayer } from './CardLayer'

const IMAGE_URL_RE = /^https?:\/\/\S+\.(png|jpe?g|gif|webp|avif|svg|bmp)(\?\S*)?$/i

function isTypingTarget(e: Event): boolean {
  const t = e.target as HTMLElement | null
  return !!t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')
}

export function Board(props: { tool: ToolId; setTool: (t: ToolId) => void }) {
  const doc = useSyncExternalStore(documentStore.subscribe, documentStore.getSnapshot)
  const camera = useSyncExternalStore(cameraStore.subscribe, cameraStore.getSnapshot)
  const staticRef = useRef<HTMLCanvasElement>(null)
  const interactiveRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const toolStateRef = useRef(new ToolState())
  const toolRef = useRef(props.tool)
  const spaceRestoreRef = useRef<ToolId | null>(null)
  const lastWorldRef = useRef<{ x: number; y: number } | null>(null)
  toolRef.current = props.tool

  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [dragPreview, setDragPreview] = useState<{ fromId: string; to: { x: number; y: number } } | null>(null)
  const [marquee, setMarquee] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [activeStroke, setActiveStroke] = useState<{ x: number; y: number }[] | null>(null)

  const env: ToolEnv = { selection, setSelection, setDragPreview, setMarquee, setEditingId }

  useEffect(() => {
    let saveTimer = 0
    const scheduleSave = () => {
      window.clearTimeout(saveTimer)
      saveTimer = window.setTimeout(() => void saveLocal(), 300)
    }
    const unsubDoc = documentStore.subscribe(scheduleSave)
    const unsubCam = cameraStore.subscribe(scheduleSave)
    return () => {
      unsubDoc()
      unsubCam()
      window.clearTimeout(saveTimer)
    }
  }, [])

  useEffect(() => {
    const container = containerRef.current
    const staticCanvas = staticRef.current
    const interactiveCanvas = interactiveRef.current
    if (!container || !staticCanvas || !interactiveCanvas) return

    const dpr = window.devicePixelRatio || 1
    const resize = () => {
      const w = container.clientWidth
      const h = container.clientHeight
      for (const c of [staticCanvas, interactiveCanvas]) {
        c.width = w * dpr
        c.height = h * dpr
        c.style.width = `${w}px`
        c.style.height = `${h}px`
      }
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(container)

    let raf = 0
    const render = () => {
      raf = 0
      const w = container.clientWidth
      const h = container.clientHeight
      const sctx = staticCanvas.getContext('2d')
      const ictx = interactiveCanvas.getContext('2d')
      if (sctx) {
        renderStaticScene(sctx, { doc, camera, selection, dragPreview, marquee }, dpr, w, h)
      }
      if (ictx) {
        renderInteractiveScene(ictx, { doc, camera, selection, dragPreview, marquee, activeStroke }, dpr, w, h)
      }
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(render)
    }
    const unsubDoc = documentStore.subscribe(schedule)
    const unsubCam = cameraStore.subscribe(schedule)
    schedule()

    return () => {
      ro.disconnect()
      unsubDoc()
      unsubCam()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [doc, camera, selection, dragPreview, marquee, activeStroke])

  const toPointerInfo = useCallback((e: { clientX: number; clientY: number; shiftKey: boolean }): PointerInfo => {
    const rect = containerRef.current!.getBoundingClientRect()
    const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    return { screen, world: cameraStore.screenToWorld(screen.x, screen.y), shiftKey: e.shiftKey }
  }, [])

  const currentTool = tools[props.tool]
  const state = toolStateRef.current

  const onPointerDown = (e: React.PointerEvent) => {
    containerRef.current?.setPointerCapture(e.pointerId)
    if (e.button === 1 || props.tool === 'hand') {
      tools.hand.onPointerDown?.(toPointerInfo(e), env, state)
      return
    }
    if (e.button !== 0) return
    currentTool.onPointerDown?.(toPointerInfo(e), env, state)
    if (state.dragging?.type === 'draw') setActiveStroke(state.dragging.points ?? null)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const info = toPointerInfo(e)
    lastWorldRef.current = info.world
    if (state.dragging?.type === 'pan') {
      tools.hand.onPointerMove?.(info, env, state)
    } else {
      currentTool.onPointerMove?.(info, env, state)
    }
    if (state.dragging?.type === 'draw') setActiveStroke([...(state.dragging.points ?? [])])
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const info = toPointerInfo(e)
    if (state.dragging?.type === 'pan') {
      tools.hand.onPointerUp?.(info, env, state)
    } else {
      currentTool.onPointerUp?.(info, env, state)
    }
    setActiveStroke(null)
  }
  const onDoubleClick = (e: React.MouseEvent) => {
    if (props.tool === 'select') {
      const info = toPointerInfo(e)
      tools.select.onDoubleClick?.(info, env)
      if (!hitTest(documentStore.getSnapshot(), info.world.x, info.world.y)) {
        tools.card.onPointerDown?.(info, env, state)
      }
    }
  }
  const onWheel = (e: React.WheelEvent) => {
    const rect = containerRef.current!.getBoundingClientRect()
    const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    const unit = e.deltaMode === 1 ? 16 : 1
    if (e.ctrlKey || e.metaKey) {
      const cam = cameraStore.getSnapshot()
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
      const zoom = Math.min(4, Math.max(0.1, cam.zoom * factor))
      const world = cameraStore.screenToWorld(screen.x, screen.y)
      cameraStore.set({
        zoom,
        x: screen.x - world.x * zoom,
        y: screen.y - world.y * zoom,
      })
    } else {
      let dx = e.deltaX * unit
      let dy = e.deltaY * unit
      if (e.shiftKey && Math.abs(dx) < Math.abs(dy)) {
        dx = dy
        dy = 0
      }
      const cam = cameraStore.getSnapshot()
      cameraStore.set({ x: cam.x - dx, y: cam.y - dy })
    }
  }

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        if (!isTypingTarget(e) && !e.repeat) {
          e.preventDefault()
          if (spaceRestoreRef.current === null) {
            spaceRestoreRef.current = toolRef.current
            if (toolRef.current !== 'hand') props.setTool('hand')
          }
        }
        return
      }
      if (isTypingTarget(e)) return
      if (e.key === 'Escape') {
        setEditingId(null)
        setSelection(new Set())
        return
      }
      const mod = e.metaKey || e.ctrlKey
      if (mod && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault()
        if (selection.size > 0) setSelection(duplicateNodes(selection))
        return
      }
      if (mod && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault()
        setSelection(new Set((documentStore.getSnapshot().nodes ?? []).map((n) => n.id)))
        return
      }
      if (mod) return
      const map: Record<string, ToolId> = { v: 'select', h: 'hand', c: 'card', l: 'connect', b: 'box', d: 'draw' }
      const t = map[e.key.toLowerCase()]
      if (t) {
        props.setTool(t)
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        for (const id of selection) {
          if (documentStore.getNode(id)) documentStore.deleteNode(id)
        }
        setSelection(new Set())
        return
      }
      if (e.key.startsWith('Arrow') && selection.size > 0) {
        e.preventDefault()
        const step = e.shiftKey ? 10 : 1
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
        for (const id of selection) {
          const n = documentStore.getNode(id)
          if (n) documentStore.updateNode(id, { x: n.x + dx, y: n.y + dy })
        }
      }
    },
    [selection, props],
  )

  useEffect(() => {
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' && spaceRestoreRef.current !== null) {
        const restore = spaceRestoreRef.current
        spaceRestoreRef.current = null
        props.setTool(restore)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [onKeyDown, props])

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isTypingTarget(e)) return
      const items = e.clipboardData?.items
      if (!items) return
      const files: File[] = []
      for (const item of Array.from(items)) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const f = item.getAsFile()
          if (f) files.push(f)
        }
      }
      const origin = lastWorldRef.current ?? viewportCenterWorld()
      if (files.length > 0) {
        e.preventDefault()
        files.forEach((f, i) => {
          const reader = new FileReader()
          reader.onload = () => {
            if (typeof reader.result === 'string') {
              const offset = (i - (files.length - 1) / 2) * 24
              createImageCard({ x: origin.x + offset, y: origin.y + offset }, reader.result)
            }
          }
          reader.readAsDataURL(f)
        })
        return
      }
      const text = e.clipboardData?.getData('text/plain')?.trim() ?? ''
      if (IMAGE_URL_RE.test(text)) {
        e.preventDefault()
        createImageCard(origin, text)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [])

  return (
    <div
      ref={containerRef}
      className="board"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={onDoubleClick}
      onWheel={onWheel}
      style={{ cursor: props.tool === 'hand' ? 'grab' : props.tool === 'draw' ? 'crosshair' : 'default' }}
    >
      <canvas ref={staticRef} className="canvas static" />
      <canvas ref={interactiveRef} className="canvas interactive" />
      <CardLayer
        doc={doc}
        camera={camera}
        selection={selection}
        setSelection={setSelection}
        editingId={editingId}
        setEditingId={setEditingId}
      />
    </div>
  )
}
