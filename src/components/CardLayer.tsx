import { useEffect, useRef } from 'react'
import type { Camera } from '../store/camera'
import { documentStore } from '../store/document'
import { PRESET_COLORS } from '../render/renderer'
import { duplicateNodes } from '../tools/tools'
import type { CanvasColor, CanvasFile, ImageNode, TextNode } from '../types'

const COLOR_KEYS = ['1', '2', '3', '4', '5', '6'] as const

export function CardLayer(props: {
  doc: CanvasFile
  camera: Camera
  selection: Set<string>
  setSelection: (s: Set<string>) => void
  editingId: string | null
  setEditingId: (id: string | null) => void
}) {
  const { doc, camera, selection } = props
  const layerRef = useRef<HTMLDivElement>(null)
  const cards = (doc.nodes ?? []).filter((n) => n.type === 'text' || n.type === 'image')

  return (
    <div className="card-layer" ref={layerRef}>
      {cards.map((n) =>
        n.type === 'image' ? (
          <ImageCard
            key={n.id}
            node={n}
            camera={camera}
            selected={selection.has(n.id)}
            editing={props.editingId === n.id}
            onEditDone={(text) => {
              documentStore.updateNode(n.id, { text })
              props.setEditingId(null)
            }}
            onStartEdit={() => props.setEditingId(n.id)}
          />
        ) : (
          <Card
            key={n.id}
            node={n as TextNode}
            camera={camera}
            selected={selection.has(n.id)}
            editing={props.editingId === n.id}
            onEditDone={(text) => {
              documentStore.updateNode(n.id, { text })
              props.setEditingId(null)
            }}
            onStartEdit={() => props.setEditingId(n.id)}
          />
        ),
      )}
      {selection.size > 0 && props.editingId === null && (
        <SelectionBar
          doc={doc}
          camera={camera}
          selection={selection}
          setSelection={props.setSelection}
          layerWidth={layerRef.current?.clientWidth ?? 0}
          layerHeight={layerRef.current?.clientHeight ?? 0}
        />
      )}
    </div>
  )
}

function SelectionBar(props: {
  doc: CanvasFile
  camera: Camera
  selection: Set<string>
  setSelection: (s: Set<string>) => void
  layerWidth: number
  layerHeight: number
}) {
  const { doc, camera, selection } = props
  const nodes = (doc.nodes ?? []).filter((n) => selection.has(n.id))
  if (nodes.length === 0) return null

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    minX = Math.min(minX, n.x)
    minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x + n.width)
    maxY = Math.max(maxY, n.y + n.height)
  }
  const centerX = ((minX + maxX) / 2) * camera.zoom + camera.x
  const topScreen = minY * camera.zoom + camera.y
  const bottomScreen = maxY * camera.zoom + camera.y
  const BAR_HEIGHT = 40
  let top = topScreen - BAR_HEIGHT - 8
  if (top < 4) top = bottomScreen + 8
  const maxLeft = (props.layerWidth || window.innerWidth) - 100
  const left = Math.min(Math.max(centerX, 100), Math.max(100, maxLeft))

  const remove = () => {
    for (const id of selection) {
      if (documentStore.getNode(id)) documentStore.deleteNode(id)
    }
    props.setSelection(new Set())
  }

  const duplicate = () => {
    props.setSelection(duplicateNodes(selection))
  }

  const showColors = nodes.some((n) => n.type !== 'image')

  const recolor = (color?: CanvasColor) => {
    for (const id of selection) documentStore.updateNode(id, { color })
  }

  return (
    <div className="selection-bar" style={{ left, top }} onPointerDown={(e) => e.stopPropagation()}>
      <button className="sel-btn" title="复制 (Ctrl/⌘+D)" onClick={duplicate}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="12" height="12" rx="2" />
          <path d="M5 15V5a2 2 0 0 1 2-2h10" />
        </svg>
      </button>
      {showColors && (
        <>
          <span className="sel-sep" />
          {COLOR_KEYS.map((c) => (
            <button
              key={c}
              className="sel-dot"
              style={{ background: PRESET_COLORS[c] }}
              title={`颜色 ${c}`}
              onClick={() => recolor(c)}
            />
          ))}
          <button className="sel-dot clear" title="默认颜色" onClick={() => recolor(undefined)} />
          <span className="sel-sep" />
        </>
      )}
      <button className="sel-btn danger" title="删除 (Delete)" onClick={remove}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 6h18" />
          <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
          <path d="M10 11v6M14 11v6" />
        </svg>
      </button>
    </div>
  )
}

function Card(props: {
  node: TextNode
  camera: Camera
  selected: boolean
  editing: boolean
  onEditDone: (text: string) => void
  onStartEdit: () => void
}) {
  const { node, camera } = props
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (props.editing && ref.current) {
      ref.current.focus()
      const range = document.createRange()
      range.selectNodeContents(ref.current)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
  }, [props.editing])

  const left = node.x * camera.zoom + camera.x
  const top = node.y * camera.zoom + camera.y

  return (
    <div
      className={props.selected ? 'card selected' : 'card'}
      data-color={node.color}
      style={{
        left,
        top,
        width: node.width * camera.zoom,
        minHeight: node.height * camera.zoom,
        fontSize: 14 * camera.zoom,
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        props.onStartEdit()
      }}
    >
      <div
        ref={ref}
        className="card-text"
        contentEditable={props.editing}
        suppressContentEditableWarning
        onBlur={(e) => props.onEditDone(e.currentTarget.textContent ?? '')}
        onKeyDown={(e) => {
          if (e.key === 'Escape') (e.target as HTMLElement).blur()
          e.stopPropagation()
        }}
      >
        {node.text || (props.editing ? '' : '双击编辑')}
      </div>
    </div>
  )
}

function ImageCard(props: {
  node: ImageNode
  camera: Camera
  selected: boolean
  editing: boolean
  onEditDone: (text: string) => void
  onStartEdit: () => void
}) {
  const { node, camera } = props
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (props.editing && ref.current) {
      ref.current.focus()
      const range = document.createRange()
      range.selectNodeContents(ref.current)
      range.collapse(false)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
  }, [props.editing])

  const left = node.x * camera.zoom + camera.x
  const top = node.y * camera.zoom + camera.y
  const hasText = !!node.text
  const className = 'card image' + (hasText || props.editing ? ' has-text' : '') + (props.selected ? ' selected' : '')

  return (
    <div
      className={className}
      style={{ left, top, width: node.width * camera.zoom }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        props.onStartEdit()
      }}
    >
      <img
        src={node.url}
        alt=""
        draggable={false}
        onLoad={(e) => {
          const img = e.currentTarget
          if (img.naturalWidth > 0) {
            const h = Math.round((img.naturalHeight / img.naturalWidth) * node.width)
            if (Math.abs(h - node.height) > 1) documentStore.updateNode(node.id, { height: h })
          }
        }}
      />
      {(hasText || props.editing) && (
        <div
          ref={ref}
          className={props.editing ? 'image-caption editing' : 'image-caption'}
          contentEditable={props.editing}
          suppressContentEditableWarning
          style={{ fontSize: 13 * camera.zoom }}
          onBlur={(e) => props.onEditDone(e.currentTarget.textContent ?? '')}
          onKeyDown={(e) => {
            if (e.key === 'Escape') (e.target as HTMLElement).blur()
            e.stopPropagation()
          }}
        >
          {node.text}
        </div>
      )}
    </div>
  )
}
