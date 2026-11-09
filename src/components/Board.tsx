import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { cameraStore } from '../store/camera'
import { documentStore } from '../store/document'
import { renderInteractiveScene, renderStaticScene } from '../render/renderer'
import { tools, ToolState, type PointerInfo, type ToolId, type ToolEnv } from '../tools/tools'
import { saveLocal } from '../persistence'
import { CardLayer } from './CardLayer'

export function Board(props: { tool: ToolId; setTool: (t: ToolId) => void }) {
  const doc = useSyncExternalStore(documentStore.subscribe, documentStore.getSnapshot)
  const camera = useSyncExternalStore(cameraStore.subscribe, cameraStore.getSnapshot)
  const staticRef = useRef<HTMLCanvasElement>(null)
  const interactiveRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const toolStateRef = useRef(new ToolState())

  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [dragPreview, setDragPreview] = useState<{ fromId: string; to: { x: number; y: number } } | null>(null)
  const [marquee, setMarquee] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [activeStroke, setActiveStroke] = useState<{ x: number; y: number }[] | null>(null)

  const env: ToolEnv = { selection, setSelection, setDragPreview, setMarquee, setEditingId }

  useEffect(() => {
    let saveTimer = 0
    const unsub = documentStore.subscribe(() => {
      window.clearTimeout(saveTimer)
      saveTimer = window.setTimeout(() => void saveLocal(), 300)
    })
    return () => {
      unsub()
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
      if (!documentStore.getSnapshot().nodes?.some((n) => n.type === 'text' && n.x < info.world.x && n.x + n.width > info.world.x && n.y < info.world.y && n.y + n.height > info.world.y)) {
        tools.card.onPointerDown?.(info, env, state)
      }
    }
  }
  const onWheel = (e: React.WheelEvent) => {
    const rect = containerRef.current!.getBoundingClientRect()
    const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    const cam = cameraStore.getSnapshot()
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
    const zoom = Math.min(4, Math.max(0.1, cam.zoom * factor))
    const world = cameraStore.screenToWorld(screen.x, screen.y)
    cameraStore.set({
      zoom,
      x: screen.x - world.x * zoom,
      y: screen.y - world.y * zoom,
    })
  }

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (editingId) return
      const map: Record<string, ToolId> = { v: 'select', h: 'hand', c: 'card', l: 'connect', b: 'box', d: 'draw' }
      const t = map[e.key.toLowerCase()]
      if (t) props.setTool(t)
      if (e.key === 'Delete' || e.key === 'Backspace') {
        for (const id of selection) {
          if (documentStore.getNode(id)) documentStore.deleteNode(id)
        }
        setSelection(new Set())
      }
    },
    [editingId, selection, props],
  )

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onKeyDown])

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
      <CardLayer doc={doc} camera={camera} selection={selection} editingId={editingId} setEditingId={setEditingId} />
    </div>
  )
}
