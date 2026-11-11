import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLineDown, ArrowLineUp, Copy, Crop, File, Link, PencilSimple, SquaresFour, TextT, Trash, SelectionSlash, SplitVertical, List } from './icons'
import type { Camera } from '../store/camera'
import { documentStore } from '../store/document'
import { resolveColor, strokePath } from '../render/renderer'
import { deleteNodes, duplicateNodes, groupNodes, splitImageCaption, type ToolId } from '../tools/tools'
import type { CanvasFile, CanvasNode, ImageNode } from '../types'
import { IconButton } from './IconButton'
import { StylePalette } from './StylePalette'
import { ResizeHandles } from './ResizeHandles'
import { TextEditor } from './TextEditor'
import { ArrangeMenu } from './ArrangeMenu'

export function CardLayer(props: {
  doc: CanvasFile; camera: Camera; selection: Set<string>; setSelection: (s: Set<string>) => void
  selectionOutline: boolean
  editingId: string | null; setEditingId: (id: string | null) => void; tool: ToolId
  onTextEditDone: (id: string, text: string) => void
  targetId?: string; cropId: string | null; onImageCrop: (node: ImageNode) => void
  interacting: boolean
}) {
  const { doc, camera, selection } = props
  const [captionDraft, setCaptionDraft] = useState<{ id: string; text: string } | null>(null)
  const selectedNodes = (doc.nodes ?? []).filter((n) => selection.has(n.id))
  const active = props.tool === 'select'
  const connected = new Set((doc.edges ?? []).flatMap((e) => [e.fromNode, e.toNode]))
  const multiple = props.selectionOutline && selectedNodes.length > 1
  return <div className={`card-layer ${active ? '' : 'pass-through'} ${multiple ? 'multi-selection' : ''}`}>
    {(doc.nodes ?? []).map((node) => {
      const selected = selection.has(node.id), editing = props.editingId === node.id
      if (node.type === 'rectangle') return <svg key={node.id} className={`rectangle-block ${selected ? 'selected' : ''}`} data-node-id={node.id} aria-label="矩形" style={{ left: node.x * camera.zoom + camera.x, top: node.y * camera.zoom + camera.y, width: node.width * camera.zoom, height: node.height * camera.zoom }}>
        <g transform={`scale(${camera.zoom})`}>
          {selected && !multiple && <rect className="rectangle-selection" width={node.width} height={node.height} strokeWidth={2 + 6 / camera.zoom} />}
          <rect className="rectangle-line" width={node.width} height={node.height} stroke={resolveColor(node.color, '#76717f')} strokeWidth={2} />
          <rect className="rectangle-hit" width={node.width} height={node.height} strokeWidth={2 + 14 / camera.zoom} />
        </g>
      </svg>
      if (node.type === 'draw') return <svg key={node.id} className={`draw-block ${selected ? 'selected' : ''}`} data-node-id={node.id} aria-label="手绘笔迹" style={{ left: node.x * camera.zoom + camera.x, top: node.y * camera.zoom + camera.y, width: node.width * camera.zoom, height: node.height * camera.zoom }}>
        <g transform={`scale(${camera.zoom})`}>
          {selected && !multiple && <path className="draw-selection" d={strokePath(node.points)} strokeWidth={(node.strokeWidth ?? 3) + 10 / camera.zoom} />}
          <path className="draw-line" d={strokePath(node.points)} stroke={resolveColor(node.color, '#44434d')} strokeWidth={node.strokeWidth ?? 3} />
          <path className="draw-hit" d={strokePath(node.points)} strokeWidth={(node.strokeWidth ?? 3) + 14 / camera.zoom} />
        </g>
      </svg>
      if (node.type === 'group') return <div key={node.id} className={`group-label ${node.layout === 'list' ? 'list-label' : ''} ${selected ? 'selected' : ''}`} data-node-id={node.id} style={{ left: node.x * camera.zoom + camera.x + (node.layout === 'list' ? 12 * camera.zoom : 0), top: node.y * camera.zoom + camera.y + (node.layout === 'list' ? 8 * camera.zoom : -29), maxWidth: node.width * camera.zoom - (node.layout === 'list' ? 24 * camera.zoom : 0), color: resolveColor(node.color, '#8c8599') }} onDoubleClick={(e) => { e.stopPropagation(); props.setEditingId(node.id) }}>
        {node.layout === 'list' ? <List size={15} /> : <SquaresFour size={15} />}<EditableText text={node.label || (node.layout === 'list' ? '列表' : '分组')} editing={editing} className="group-name" onDone={(label) => { documentStore.updateNode(node.id, { label }); props.setEditingId(null) }} />
      </div>
      return <div key={node.id} data-node-id={node.id} className={`block-wrapper ${selected ? 'selected' : ''} ${connected.has(node.id) ? 'connected' : ''} ${props.targetId === node.id ? 'connection-target' : ''}`} style={{ left: node.x * camera.zoom + camera.x, top: node.y * camera.zoom + camera.y, width: node.width * camera.zoom, height: node.height * camera.zoom }}>
        {node.type === 'image' ? <ImageCard node={node} camera={camera} selected={selected} editing={editing} draft={editing && captionDraft?.id === node.id ? captionDraft.text : node.text ?? ''} onInput={(text) => setCaptionDraft({ id: node.id, text })} onDone={(text) => { documentStore.updateNode(node.id, { text: text.trim() ? text : undefined }); setCaptionDraft(null); props.setEditingId(null) }} onCrop={() => props.onImageCrop(node)} />
          : node.type === 'text' ? <TextCard node={node} camera={camera} editing={editing} selected={selected} onDone={(text) => props.onTextEditDone(node.id, text)} onEdit={() => props.setEditingId(node.id)} />
          : <div className={`card resource-card ${selected ? 'selected' : ''}`} style={{ fontSize: 14 * camera.zoom, padding: 12 * camera.zoom }}><span>{node.type === 'link' ? <Link size={18} /> : <File size={18} />}</span><span>{node.type === 'link' ? node.url : node.file}</span></div>}
        {!editing && <button className="block-connect" data-connect-id={node.id} style={{ top: Math.min(20, node.height / 2) * camera.zoom - 9, color: resolveColor(node.color, '#609fbb') }} aria-label="拖动圆点连接 block" title="拖动连接到其他 block；拖到空白处创建关联卡片"><span /></button>}
      </div>
    })}
    {active && !props.interacting && selectedNodes.length > 0 && (props.editingId === null || (selectedNodes.length === 1 && selectedNodes[0].type === 'image')) && <SelectionBar {...props} nodes={selectedNodes} captionDraft={captionDraft} />}
    {active && props.editingId === null && !props.cropId && !props.interacting && (selectedNodes.length === 1 || multiple) && <ResizeHandles nodes={selectedNodes} camera={camera} />}
  </div>
}
function SelectionBar(props: Parameters<typeof CardLayer>[0] & { nodes: CanvasNode[]; captionDraft: { id: string; text: string } | null }) {
  const { nodes, camera } = props
  const one = nodes.length === 1 ? nodes[0] : null
  const captionEditing = one?.type === 'image' && props.editingId === one.id
  const caption = one?.type === 'image' ? props.captionDraft?.id === one.id ? props.captionDraft.text : one.text ?? '' : ''
  const run = (action: () => void) => {
    if (captionEditing) (document.activeElement as HTMLElement | null)?.blur()
    action()
  }
  const minX = Math.min(...nodes.map((n) => n.x)), minY = Math.min(...nodes.map((n) => n.y))
  const maxX = Math.max(...nodes.map((n) => n.x + n.width)), maxY = Math.max(...nodes.map((n) => n.y + n.height))
  const topScreen = minY * camera.zoom + camera.y
  const barHeight = nodes.some((n) => n.type !== 'image') ? 82 : 46
  const gap = one?.type === 'group' ? 38 : 12
  const top = topScreen < barHeight + gap + 8 ? maxY * camera.zoom + camera.y + 16 : topScreen - barHeight - gap
  const recolor = (color?: CanvasNode['color']) => documentStore.transact(() => nodes.forEach((n) => documentStore.updateNode(n.id, { color })))
  return <div className="selection-bar floating-panel" style={{ left: `clamp(170px, ${((minX + maxX) / 2) * camera.zoom + camera.x}px, calc(100% - 170px))`, top: `clamp(12px, ${top}px, calc(100% - 105px))` }} onPointerDown={(e) => { e.stopPropagation(); if (captionEditing) e.preventDefault() }}>
    <div className="selection-actions">
      {nodes.length > 1 && nodes.every((n) => n.type === 'text' || n.type === 'image') && <ArrangeMenu selection={props.selection} setSelection={props.setSelection} />}
      {one?.type === 'image' && <>
        <IconButton icon={Crop} label="裁剪图片" active={props.cropId === one.id} onClick={() => run(() => props.onImageCrop(one))} />
        <IconButton icon={TextT} label="编辑图片说明" active={captionEditing} onClick={() => { if (!captionEditing) { if (props.cropId === one.id) props.onImageCrop(one); props.setEditingId(one.id) } }} />
        {!!caption.trim() && <IconButton icon={SplitVertical} label="Split · 拆分为文本块" onClick={() => run(() => { const card = splitImageCaption(one.id, caption); if (card) props.setSelection(new Set([card.id])) })} />}
      </>}
      {(one?.type === 'text' || one?.type === 'group') && <IconButton icon={PencilSimple} label={one.type === 'group' ? '重命名分组' : '编辑文字'} onClick={() => props.setEditingId(one.id)} />}
      {nodes.length > 1 && <IconButton icon={SquaresFour} label="组合所选内容 · ⌘/Ctrl G" onClick={() => { const group = groupNodes(props.selection); if (group) props.setSelection(new Set([group.id])) }} />}
      {one?.type === 'group' && <IconButton icon={SelectionSlash} label="解除分组 · ⌘/Ctrl ⇧ G" onClick={() => { const members = one.memberIds ?? []; documentStore.deleteNode(one.id); props.setSelection(new Set(members)) }} />}
      <IconButton icon={Copy} label="创建副本 · ⌘/Ctrl D" onClick={() => run(() => props.setSelection(duplicateNodes(props.selection)))} />
      <IconButton icon={ArrowLineUp} label="置于顶层" onClick={() => run(() => documentStore.transact(() => nodes.forEach((n) => documentStore.bringToFront(n.id))))} />
      <IconButton icon={ArrowLineDown} label="置于底层" onClick={() => run(() => documentStore.transact(() => [...nodes].reverse().forEach((n) => documentStore.sendToBack(n.id))))} />
      <IconButton icon={Trash} label="删除所选内容 · Delete" className="danger" onClick={() => run(() => { deleteNodes(props.selection); props.setSelection(new Set()) })} />
    </div>
    {nodes.some((n) => n.type !== 'image') && <div className="selection-styles"><StylePalette color={one?.color} onChange={recolor} />{one?.type === 'draw' && <StrokeWidths value={one.strokeWidth ?? 3} onChange={(strokeWidth) => documentStore.updateNode(one.id, { strokeWidth })} />}</div>}
  </div>
}
export function StrokeWidths({ value, onChange }: { value: number; onChange: (width: number) => void }) {
  return <div className="stroke-widths" role="group" aria-label="笔画粗细">{[2, 4, 8].map((width) => <button key={width} className={`stroke-option ${width === value ? 'active' : ''}`} aria-label={`笔画粗细 ${width}`} title={`笔画粗细 ${width}`} aria-pressed={width === value} onClick={() => onChange(width)}><span style={{ height: width }} /></button>)}</div>
}
function EditableText({ text, editing, className, onDone, onInput, placeholder = '', style }: { text: string; editing: boolean; className: string; onDone: (text: string) => void; onInput?: (text: string) => void; placeholder?: string; style?: React.CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null)
  const initial = useRef(text)
  useEffect(() => {
    if (!editing || !ref.current) return
    initial.current = text
    documentStore.beginInteraction()
    ref.current.textContent = text
    ref.current.focus()
    const range = document.createRange()
    range.selectNodeContents(ref.current)
    range.collapse(false)
    const selection = window.getSelection()
    selection?.removeAllRanges(); selection?.addRange(range)
  }, [editing])
  return <div ref={ref} className={`${className} ${editing ? 'editing' : ''}`} style={style} contentEditable={editing} suppressContentEditableWarning data-placeholder={placeholder}
    onPointerDown={(e) => { if (editing) e.stopPropagation() }} onPointerMove={(e) => { if (editing) e.stopPropagation() }} onPointerUp={(e) => { if (editing) e.stopPropagation() }}
    onInput={(e) => onInput?.(e.currentTarget.innerText)}
    onBlur={(e) => { if (!editing) return; onDone(e.currentTarget.innerText); documentStore.endInteraction() }}
    onKeyDown={(e) => { if (!editing) return; e.stopPropagation(); if (e.key === 'Escape') { e.currentTarget.textContent = initial.current; e.currentTarget.blur() } if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') e.currentTarget.blur() }}
  >{text}</div>
}
function TextCard({ node, camera, selected, editing, onDone, onEdit }: { node: Extract<CanvasNode, { type: 'text' }>; camera: Camera; selected: boolean; editing: boolean; onDone: (text: string) => void; onEdit: () => void }) {
  const cardRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    let active = true
    const measure = () => {
      const el = cardRef.current?.querySelector('.card-text')
      if (active && el) documentStore.updateTextLayout(node.id, Math.ceil(el.scrollHeight + 24))
    }
    measure()
    void document.fonts.ready.then(measure)
    return () => { active = false }
  }, [node.text, node.width, editing])
  const textStyle = { width: Math.max(1, node.width - 26), fontSize: 14, transform: `scale(${camera.zoom})`, transformOrigin: 'top left' }
  return <div ref={cardRef} className={`card text-card ${selected ? 'selected' : ''}`} data-color={node.color} style={{ padding: `${10 * camera.zoom}px ${12 * camera.zoom}px`, ...(node.color?.startsWith('#') ? { background: `color-mix(in srgb, ${node.color} 18%, white)` } : {}) }} onDoubleClick={(e) => { e.stopPropagation(); onEdit() }}>
    <TextEditor text={node.text} editing={editing} style={textStyle} onChange={(text) => documentStore.updateNode(node.id, { text })} onDone={onDone} />
  </div>
}
function ImageCard({ node, camera, selected, editing, draft, onInput, onDone, onCrop }: { node: ImageNode; camera: Camera; selected: boolean; editing: boolean; draft: string; onInput: (text: string) => void; onDone: (text: string) => void; onCrop: () => void }) {
  const [failed, setFailed] = useState(false)
  const crop = node.crop ?? { x: 0, y: 0, width: 1, height: 1 }
  return <div className={`card image-card ${selected ? 'selected' : ''}`} onDoubleClick={(e) => { e.stopPropagation(); onCrop() }}>
    <div className="image-viewport"><img src={node.url} alt={node.text || '白板图片'} draggable={false} style={{ width: `${100 / crop.width}%`, height: `${100 / crop.height}%`, left: `${-crop.x / crop.width * 100}%`, top: `${-crop.y / crop.height * 100}%` }} onError={() => setFailed(true)} onLoad={(e) => {
      setFailed(false)
      const img = e.currentTarget
      if (!node.naturalWidth && img.naturalWidth > 0) documentStore.initializeImage(node.id, img.naturalWidth, img.naturalHeight)
    }} />{failed && <span className="image-error">图片加载失败</span>}</div>
    {(node.text?.trim() || editing) && <EditableText text={node.text ?? ''} editing={editing} className={`image-caption ${!draft.trim() ? 'empty' : ''}`} placeholder="为图片添加说明…" style={{ fontSize: 13 * camera.zoom, padding: `${8 * camera.zoom}px ${10 * camera.zoom}px` }} onInput={onInput} onDone={onDone} />}
  </div>
}
