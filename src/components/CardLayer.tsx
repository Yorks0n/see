import { useEffect, useRef } from 'react'
import type { Camera } from '../store/camera'
import { documentStore } from '../store/document'
import type { CanvasFile, TextNode } from '../types'

export function CardLayer(props: {
  doc: CanvasFile
  camera: Camera
  selection: Set<string>
  editingId: string | null
  setEditingId: (id: string | null) => void
}) {
  const { doc, camera } = props
  const cards = (doc.nodes ?? []).filter((n) => n.type === 'text')

  return (
    <div className="card-layer">
      {cards.map((n) => (
        <Card
          key={n.id}
          node={n as TextNode}
          camera={camera}
          selected={props.selection.has(n.id)}
          editing={props.editingId === n.id}
          onEditDone={(text) => {
            documentStore.updateNode(n.id, { text })
            props.setEditingId(null)
          }}
          onStartEdit={() => props.setEditingId(n.id)}
        />
      ))}
    </div>
  )
}

function Card(props: {
  node: { id: string; x: number; y: number; width: number; height: number; text: string; color?: string }
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
      style={{
        left,
        top,
        width: node.width * camera.zoom,
        minHeight: node.height * camera.zoom,
        fontSize: 14 * camera.zoom,
        borderColor: props.selected ? '#4dabf7' : undefined,
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
