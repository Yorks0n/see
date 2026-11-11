import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { libraryStore } from '../store/library'
import { DotsThree, File, PushPin, Plus, User } from './icons'
import { IconButton } from './IconButton'
import { MenuItems, PopupMenu, type MenuItem } from './Menu'
import { cloudStore } from '../sync/cloud'

export function FilesSidebar({ onError, onLogin }: { onError: (message: string) => void; onLogin: () => void }) {
  const library = useSyncExternalStore(libraryStore.subscribe, libraryStore.getSnapshot)
  const cloud = useSyncExternalStore(cloudStore.subscribe, cloudStore.getSnapshot)
  const [search, setSearch] = useState('')
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (renaming) { nameRef.current?.focus(); nameRef.current?.select() } }, [renaming?.id])
  const fail = (error: unknown) => onError(error instanceof Error ? error.message : '白板操作失败')
  const files = library.files.filter((file) => file.name.toLowerCase().includes(search.toLowerCase()))
  const menuFile = library.files.find((file) => file.id === menu?.id)
  const finishRename = () => {
    if (!renaming) return
    setRenaming(null)
    void libraryStore.renameFile(renaming.id, renaming.name).catch(fail)
  }
  const items: (MenuItem | null)[] = menuFile ? [
    { label: '重命名', action: () => { setSearch(''); setRenaming({ id: menuFile.id, name: menuFile.name }) } },
    { label: '复制', action: () => { setSearch(''); void libraryStore.duplicateFile(menuFile.id).catch(fail) } },
    { label: '下载', action: () => { void libraryStore.downloadFile(menuFile.id).catch(fail) } },
    { label: menuFile.pinned ? '取消置顶' : '置顶', action: () => libraryStore.togglePin(menuFile.id) },
    null, { label: '删除', danger: true, action: () => { void libraryStore.deleteFile(menuFile.id).catch(fail) } },
  ] : []
  return <nav id="files-sidebar" className="files-sidebar floating-panel" aria-label="白板管理">
    <input className="file-search" type="search" aria-label="搜索白板文件" placeholder="搜索文件…" value={search} onChange={(e) => setSearch(e.target.value)} />
    <button className="new-board-button" disabled={library.busy} onClick={() => { setSearch(''); void libraryStore.createFile().catch(fail) }}><Plus size={17} />新建白板</button>
    <div className="board-file-list" aria-label="白板文件" aria-busy={library.busy}>
      {files.map((file) => <div key={file.id} data-file-id={file.id} className={`board-file-row ${file.id === library.activeFileId ? 'active' : ''} ${file.id === menu?.id ? 'menu-open' : ''}`} onContextMenu={(e) => { if ((e.target as HTMLElement).closest('input')) return; e.preventDefault(); if (!library.busy) setMenu({ id: file.id, x: e.clientX, y: e.clientY }) }}>
        {renaming?.id === file.id ? <input ref={nameRef} className="board-file-name-input" aria-label="重命名白板" value={renaming.name} maxLength={120} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} onBlur={finishRename} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setRenaming(null) }} />
          : <button className="board-file" aria-current={file.id === library.activeFileId ? 'page' : undefined} disabled={library.busy} title={file.name} onClick={() => { void libraryStore.switchFile(file.id).catch(fail) }}><File size={17} aria-hidden="true" /><span>{file.name}</span>{file.pinned && <PushPin className="board-file-pin" size={13} weight="fill" aria-label="已置顶" />}</button>}
        <IconButton icon={DotsThree} className="board-file-menu" label={`白板菜单：${file.name}`} aria-haspopup="menu" aria-expanded={menu?.id === file.id} disabled={library.busy} onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          setMenu(menu?.id === file.id ? null : { id: file.id, x: rect.right + 8, y: rect.top })
        }} />
      </div>)}
    </div>
    <div className="sidebar-account">
      <button className="sidebar-account-button" aria-haspopup="dialog" title={cloud.enabled ? `账号：${cloud.username}` : undefined} onClick={onLogin}>
        <span className="sidebar-account-avatar" aria-hidden="true">{cloud.enabled ? cloud.username.slice(0, 1).toUpperCase() : <User size={17} />}</span>
        <span>{cloud.enabled ? cloud.username : '登录'}</span>
      </button>
    </div>
    {menu && menuFile && <PopupMenu key={menu.id} label="白板菜单" position={menu} onClose={() => setMenu(null)}><MenuItems items={items} onChoose={() => setMenu(null)} /></PopupMenu>}
  </nav>
}
