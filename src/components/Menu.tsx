import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { CaretRight } from './icons'

export interface MenuItem {
  label: string
  shortcut?: string
  action?: () => void
  items?: (MenuItem | null)[]
  disabled?: boolean
  danger?: boolean
}
export function MenuItems({ items, onChoose }: { items: (MenuItem | null)[]; onChoose: () => void }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  const [focusSubmenu, setFocusSubmenu] = useState(false)
  const [position, setPosition] = useState<{ x: number; y: number; fallbackX: number } | null>(null)
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const open = (index: number, focus: boolean) => {
    const rect = buttons.current[index]?.getBoundingClientRect()
    if (rect) setPosition({ x: rect.right + 8, y: rect.top - 5, fallbackX: rect.left - 8 })
    setFocusSubmenu(focus); setOpenIndex(index)
  }
  useEffect(() => {
    if (openIndex === null) return
    const reposition = () => {
      const rect = buttons.current[openIndex]?.getBoundingClientRect()
      if (rect) setPosition({ x: rect.right + 8, y: rect.top - 5, fallbackX: rect.left - 8 })
    }
    window.addEventListener('resize', reposition)
    return () => window.removeEventListener('resize', reposition)
  }, [openIndex])
  return <>{items.map((item, i) => item ? <div key={i} className="menu-branch">
    <button ref={(el) => { buttons.current[i] = el }} role="menuitem" disabled={item.disabled} className={`menu-item ${item.danger ? 'danger' : ''} ${openIndex === i ? 'active' : ''}`}
      aria-haspopup={item.items ? 'menu' : undefined} aria-expanded={item.items ? openIndex === i : undefined}
      onPointerEnter={() => { if (item.items) open(i, false); else setOpenIndex(null) }}
      onKeyDown={(e) => { if (item.items && e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); open(i, true) } }}
      onClick={() => { if (item.items) open(i, true); else { onChoose(); item.action?.() } }}>
      <span>{item.label}</span>{item.items ? <CaretRight size={14} /> : item.shortcut && <kbd>{item.shortcut}</kbd>}
    </button>
    {item.items && openIndex === i && position && <PopupMenu label={`${item.label}子菜单`} className="submenu" position={position} autoFocus={focusSubmenu} onClose={() => setOpenIndex(null)} onBack={() => { setOpenIndex(null); buttons.current[i]?.focus() }}><MenuItems items={item.items} onChoose={onChoose} /></PopupMenu>}
  </div> : <div key={i} className="menu-separator" role="separator" />)}</>
}
export function PopupMenu({ children, onClose, position, label, className = '', autoFocus = true, onBack }: { children: ReactNode; onClose: () => void; position?: { x: number; y: number; fallbackX?: number }; label: string; className?: string; autoFocus?: boolean; onBack?: () => void }) {
  const ref = useRef<HTMLDivElement>(null), closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const close = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) closeRef.current() }
    window.addEventListener('pointerdown', close)
    if (autoFocus) ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    return () => window.removeEventListener('pointerdown', close)
  }, [autoFocus])
  useLayoutEffect(() => {
    if (!position || !ref.current) return
    const place = () => {
      const el = ref.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const x = position.x + rect.width > window.innerWidth - 8 && position.fallbackX !== undefined ? position.fallbackX - rect.width : position.x
      el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`
      el.style.top = `${Math.max(8, Math.min(position.y, window.innerHeight - rect.height - 8))}px`
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [position])
  return <div ref={ref} className={`popup-menu floating-panel board-chrome ${position ? 'context-menu' : ''} ${className}`} role="menu" aria-label={label} style={position ? { left: position.x, top: position.y } : undefined}
    onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation() }}
    onKeyDown={(e) => {
      e.stopPropagation()
      if (e.key === 'ArrowLeft' && onBack) { e.preventDefault(); onBack(); return }
      if (e.key === 'Escape') { e.preventDefault(); if (onBack) onBack(); else closeRef.current(); return }
      const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')].filter((button) => button.closest('[role="menu"]') === e.currentTarget)
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); buttons[(current + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus() }
      if (e.key === 'Home') { e.preventDefault(); buttons[0]?.focus() }
      if (e.key === 'End') { e.preventDefault(); buttons[buttons.length - 1]?.focus() }
      if (e.key === 'Tab') closeRef.current()
    }}>{children}</div>
}
