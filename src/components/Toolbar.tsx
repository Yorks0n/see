import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ArrowCounterClockwise, ArrowClockwise, ArrowDown, ArrowUp, Cursor, Hand, ImageSquare, PencilSimple, Plus, UploadSimple, X } from './icons'
import { exportCanvasFile, importCanvasFile, saveLocal } from '../persistence'
import { documentStore } from '../store/document'
import { cameraStore } from '../store/camera'
import { createImageCard, viewportCenterWorld, type ToolId } from '../tools/tools'
import { IconButton } from './IconButton'

const TOOLS = [
  { id: 'select' as const, label: '选择 · V', icon: Cursor },
  { id: 'hand' as const, label: '平移 · H / 按住空格', icon: Hand },
  { id: 'draw' as const, label: '自由手绘 · D', icon: PencilSimple },
]
export function Toolbar(props: { tool: ToolId; setTool: (t: ToolId) => void; onSelectNode: (id: string) => void }) {
  const doc = useSyncExternalStore(documentStore.subscribe, documentStore.getSnapshot)
  const [imageOpen, setImageOpen] = useState(false)
  const [imageUrl, setImageUrl] = useState('')
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const importRef = useRef<HTMLInputElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  useEffect(() => { document.title = `see•${doc.meta?.name || '未命名画布'}` }, [doc.meta?.name])
  useEffect(() => {
    if (!imageOpen) return
    const close = (e: PointerEvent) => { if (!popRef.current?.contains(e.target as Node)) setImageOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setImageOpen(false) }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', esc) }
  }, [imageOpen])
  const addImage = (url: string) => {
    const node = createImageCard(viewportCenterWorld(), url)
    props.onSelectNode(node.id)
    props.setTool('select')
    setImageOpen(false)
    setImageUrl('')
    setError('')
  }
  const submitUrl = () => {
    try {
      const url = new URL(imageUrl.trim())
      if (!['http:', 'https:', 'data:', 'blob:'].includes(url.protocol)) throw new Error()
      addImage(url.href)
    } catch { setError('请输入有效的图片链接') }
  }
  const pickFile = (f?: File) => {
    if (!f) return
    if (!f.type.startsWith('image/')) { setError('请选择图片文件'); return }
    const reader = new FileReader()
    reader.onload = () => { if (typeof reader.result === 'string') addImage(reader.result) }
    reader.onerror = () => setError('图片读取失败，请重试')
    reader.readAsDataURL(f)
  }
  return <header className="toolbar">
    <div className="brand"><span className="brand-mark">s</span><span>see<span className="brand-dot">.</span></span></div>
    <span className="document-name">{doc.meta?.name ?? '未命名画布'}</span>
    <div className="primary-tools" role="toolbar" aria-label="画布工具">
      {TOOLS.map((t) => <IconButton key={t.id} icon={t.icon} label={t.label} active={props.tool === t.id} onClick={() => props.setTool(t.id)} />)}
      <span className="toolbar-sep" />
      <div className="toolbar-image" ref={popRef}>
        <IconButton icon={ImageSquare} label="添加图片" active={imageOpen} onClick={() => setImageOpen(!imageOpen)} aria-expanded={imageOpen} />
        {imageOpen && <div className="image-pop" role="dialog" aria-label="添加图片">
          <div className="popover-heading"><span>添加图片</span><IconButton icon={X} label="关闭图片面板" onClick={() => setImageOpen(false)} /></div>
          <button className="upload-zone" onClick={() => fileRef.current?.click()}><UploadSimple size={26} /><span>上传图片</span></button>
          <div className="input-row"><input autoFocus type="url" aria-label="图片链接" value={imageUrl} placeholder="粘贴图片链接…" onChange={(e) => setImageUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submitUrl() }} /><IconButton icon={Plus} label="添加链接图片" onClick={submitUrl} /></div>
          {error && <p className="error-message" role="alert">{error}</p>}
        </div>}
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = '' }} />
      </div>
    </div>
    <div className="document-tools" role="toolbar" aria-label="文件与历史">
      <IconButton icon={ArrowCounterClockwise} label="撤销 · ⌘/Ctrl Z" disabled={!documentStore.canUndo} onClick={() => documentStore.undo()} />
      <IconButton icon={ArrowClockwise} label="重做 · ⌘/Ctrl ⇧ Z" disabled={!documentStore.canRedo} onClick={() => documentStore.redo()} />
      <span className="toolbar-sep" />
      <IconButton icon={ArrowDown} label="导出 .canvas" onClick={() => { void saveLocal(); exportCanvasFile() }} />
      <IconButton icon={ArrowUp} label="导入 .canvas" onClick={() => importRef.current?.click()} />
      <input ref={importRef} type="file" accept=".canvas,application/json" hidden onChange={(e) => {
        const file = e.target.files?.[0]
        if (file) void importCanvasFile(file).then((file) => { documentStore.load(file); if (file.meta?.camera) cameraStore.set(file.meta.camera) }).catch(() => setError('导入失败：请选择有效的 .canvas 文件'))
        e.target.value = ''
      }} />
    </div>
    {error && !imageOpen && <div className="toast" role="alert">{error}<IconButton icon={X} label="关闭提示" onClick={() => setError('')} /></div>}
  </header>
}
