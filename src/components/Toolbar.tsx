import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Cursor, Hand, ImageSquare, PencilSimple, Plus, UploadSimple, X, List, SidebarSimple, DotsThree, SquaresFour, Rectangle, Sparkle } from './icons'
import { exportCanvasFile, importCanvasFile, requestPersistentStorage, saveLocal } from '../persistence'
import { documentStore } from '../store/document'
import { createImageCard, viewportCenterWorld, type ToolId } from '../tools/tools'
import { runBoardCommand, shortcut, type BoardCommand } from '../shortcuts'
import { MenuItems, PopupMenu, type MenuItem } from './Menu'
import { IconButton } from './IconButton'
import { FilesSidebar } from './FilesSidebar'
import { libraryStore } from '../store/library'
import { SaveStatus } from './SaveStatus'
import { CloudDialog } from './CloudDialog'

const TOOLS = [
  { id: 'select' as const, label: '选择', icon: Cursor },
  { id: 'hand' as const, label: '平移', icon: Hand },
  { id: 'draw' as const, label: '自由手绘', icon: PencilSimple },
  { id: 'laser' as const, label: '激光笔', icon: Sparkle },
  { id: 'box' as const, label: '分组框', icon: SquaresFour },
  { id: 'list' as const, label: '绘制列表', icon: List },
]
export function Toolbar(props: { tool: ToolId; setTool: (t: ToolId) => void; onSelectNode: (id: string) => void }) {
  const doc = useSyncExternalStore(documentStore.subscribe, documentStore.getSnapshot)
  const [expanded, setExpanded] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState('')
  const [imageOpen, setImageOpen] = useState(false)
  const [imageUrl, setImageUrl] = useState('')
  const [error, setError] = useState('')
  const [cloudOpen, setCloudOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null), importRef = useRef<HTMLInputElement>(null), popRef = useRef<HTMLDivElement>(null), nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => { document.title = `see•${doc.meta?.name || '未命名画布'}` }, [doc.meta?.name])
  useEffect(() => { if (renaming) { nameRef.current?.focus(); nameRef.current?.select() } }, [renaming])
  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || !(e.metaKey || e.ctrlKey)) return
      if (e.key.toLowerCase() === 's') { e.preventDefault(); void requestPersistentStorage(); void saveLocal().catch(() => {}) }
      if (e.key.toLowerCase() === 'o') { e.preventDefault(); importRef.current?.click() }
      if (e.key.toLowerCase() === 'k' && e.shiftKey) { e.preventDefault(); fileRef.current?.click() }
    }
    window.addEventListener('keydown', keys)
    return () => window.removeEventListener('keydown', keys)
  }, [])
  useEffect(() => {
    if (!imageOpen) return
    const close = (e: PointerEvent) => { if (!popRef.current?.contains(e.target as Node)) setImageOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setImageOpen(false) }
    window.addEventListener('pointerdown', close); window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', esc) }
  }, [imageOpen])
  const rename = () => { setName(doc.meta?.name || '未命名画布'); setRenaming(true) }
  const finishRename = () => { documentStore.rename(name); setRenaming(false) }
  const addImage = (url: string) => {
    const node = createImageCard(viewportCenterWorld(), url)
    props.onSelectNode(node.id); props.setTool('select'); setImageOpen(false); setImageUrl(''); setError('')
  }
  const submitUrl = () => {
    try {
      const url = new URL(imageUrl.trim())
      if (!['http:', 'https:', 'data:', 'blob:'].includes(url.protocol)) throw new Error()
      addImage(url.href)
    } catch { setError('请输入有效的图片链接') }
  }
  const pickFile = (file: File) => {
    if (!file.type.startsWith('image/')) { setError('请选择图片文件'); return }
    const reader = new FileReader()
    reader.onload = () => { if (typeof reader.result === 'string') addImage(reader.result) }
    reader.onerror = () => setError('图片读取失败，请重试')
    reader.readAsDataURL(file)
  }
  const command = (label: string, id: BoardCommand, disabled = false): MenuItem => ({ label, shortcut: shortcut(id), action: () => runBoardCommand(id), disabled })
  const download = () => { void exportCanvasFile().catch((error: Error) => setError(error.message)) }
  const menus: Record<string, (MenuItem | null)[]> = {
    文件: [
      { label: '新建白板', action: () => { void libraryStore.createFile().catch((error: Error) => setError(error.message)) } },
      { label: '重命名', action: rename },
      { label: '保存到本地', shortcut: shortcut('save'), action: () => { void requestPersistentStorage(); void saveLocal().catch(() => {}) } },
      { label: '打开白板…', shortcut: shortcut('open'), action: () => importRef.current?.click() },
      { label: '下载 .canvas', action: download },
    ],
    编辑: [command('撤销', 'undo', !documentStore.canUndo), command('重做', 'redo', !documentStore.canRedo), null, command('剪切', 'cut'), command('复制', 'copy'), command('粘贴', 'paste'), command('创建副本', 'duplicate'), null, command('全选', 'select-all'), command('组合', 'group'), command('取消组合 / 解散列表', 'ungroup'), command('删除', 'delete')],
    视图: [command('缩放至全部内容', 'fit'), command('缩放至 100%', 'reset-zoom'), command('显示 / 隐藏界面', 'toggle-ui')],
    导出: [{ label: '下载 .canvas', action: download }, command('导出为 SVG', 'export-svg'), command('导出为 PNG', 'export-png'), null, command('复制为 SVG', 'copy-svg'), command('复制为 PNG', 'copy-png')],
  }
  return <aside className={`toolbar ${expanded ? 'sidebar-open' : ''}`} aria-label="白板功能栏">
    {cloudOpen && <CloudDialog onClose={() => setCloudOpen(false)} />}
    <div className="board-header floating-panel">
      <IconButton icon={SidebarSimple} label={expanded ? '收起左侧功能栏' : '展开左侧功能栏'} active={expanded} aria-expanded={expanded} aria-controls="files-sidebar" onClick={() => setExpanded(!expanded)} />
      <span className="document-title">
        <span className="document-name-sizer" aria-hidden="true">{(renaming ? name : doc.meta?.name || '未命名画布') || '\u00a0'}</span>
        {renaming ? <input ref={nameRef} className="document-name-input" aria-label="白板名称" value={name} size={1} maxLength={120} onChange={(e) => setName(e.target.value)} onBlur={finishRename} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setRenaming(false) }} />
          : <button className="document-name" title="点击重命名" onClick={rename}>{doc.meta?.name || '未命名画布'}</button>}
      </span>
      <SaveStatus />
      <IconButton icon={DotsThree} label="文件菜单" active={menuOpen} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => { setImageOpen(false); setMenuOpen(!menuOpen) }} />
      {menuOpen && <PopupMenu label="文件菜单" className="file-menu" onClose={() => setMenuOpen(false)}>
        <MenuItems items={[...Object.entries(menus).map(([label, items]) => ({ label, items })), null, { label: '插入媒体文件…', shortcut: shortcut('media'), action: () => fileRef.current?.click() }, command('键盘快捷方式', 'shortcuts')]} onChoose={() => setMenuOpen(false)} />
      </PopupMenu>}
    </div>
    {expanded && <FilesSidebar onError={setError} onLogin={() => setCloudOpen(true)} />}
    <div id="left-tools" className="primary-tools floating-panel" role="toolbar" aria-label="画布工具" aria-orientation="vertical">
      {TOOLS.map((t) => <IconButton key={t.id} icon={t.icon} label={`${t.label} · ${shortcut(t.id)}`} active={props.tool === t.id} onClick={() => props.setTool(t.id)} />)}
      <div className="toolbar-image" ref={popRef}>
        <IconButton icon={ImageSquare} label="添加图片" active={imageOpen} aria-expanded={imageOpen} onClick={() => { setMenuOpen(false); setImageOpen(!imageOpen) }} />
        {imageOpen && <div className="image-pop" role="dialog" aria-label="添加图片">
          <div className="popover-heading"><span>添加图片</span><IconButton icon={X} label="关闭图片面板" onClick={() => setImageOpen(false)} /></div>
          <button className="upload-zone" onClick={() => fileRef.current?.click()}><UploadSimple size={26} /><span>上传图片</span></button>
          <div className="input-row"><input autoFocus type="url" aria-label="图片链接" value={imageUrl} placeholder="粘贴图片链接…" onChange={(e) => setImageUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submitUrl() }} /><IconButton icon={Plus} label="添加链接图片" onClick={submitUrl} /></div>
          {error && <p className="error-message" role="alert">{error}</p>}
        </div>}
      </div>
      <IconButton icon={Rectangle} label="矩形" active={props.tool === 'rectangle'} onClick={() => { setImageOpen(false); props.setTool('rectangle') }} />
    </div>
    <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { Array.from(e.target.files ?? []).forEach(pickFile); e.target.value = '' }} />
    <input ref={importRef} type="file" accept=".canvas,.tldr,.json,application/json,application/vnd.tldraw+json" hidden onChange={(e) => {
      const file = e.target.files?.[0]
      if (file) void importCanvasFile(file).then((doc) => {
        const name = typeof doc.meta?.name === 'string' && doc.meta.name.trim() ? doc.meta.name : file.name.replace(/\.(canvas|tldr|json)$/i, '')
        return libraryStore.createFile(name, doc).then(() => {
          const warnings = doc.meta?.tldraw?.warnings
          setError(warnings?.length ? `已导入。${warnings.join('；')}。` : '')
        })
      }).catch((error: Error) => setError(`导入失败：${error.message}`))
      e.target.value = ''
    }} />
    {error && !imageOpen && <div className="toast" role="alert">{error}<IconButton icon={X} label="关闭提示" onClick={() => setError('')} /></div>}
  </aside>
}
