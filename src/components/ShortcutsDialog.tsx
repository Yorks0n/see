import { useEffect, useRef } from 'react'
import { SHORTCUTS } from '../shortcuts'
import { IconButton } from './IconButton'
import { X } from './icons'

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { ref.current?.showModal() }, [])
  return <dialog ref={ref} className="shortcuts-dialog board-chrome" aria-label="键盘快捷方式" onCancel={onClose} onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onClick={(e) => { if (e.target === e.currentTarget) onClose() }} onKeyDown={(e) => e.stopPropagation()}>
    <div className="shortcuts-content">
      <div className="popover-heading"><span>键盘快捷方式</span><IconButton icon={X} label="关闭快捷方式" onClick={onClose} /></div>
      <div className="shortcuts-groups">{[...new Set(SHORTCUTS.map((s) => s.group))].map((group) => <section key={group}><h3>{group}</h3><dl>{SHORTCUTS.filter((s) => s.group === group).map((s) => <div key={s.id}><dt>{s.label}</dt><dd><kbd>{s.keys.replace(/Mod/g, /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl')}</kbd></dd></div>)}</dl></section>)}</div>
    </div>
  </dialog>
}
