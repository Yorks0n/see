import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  const anchor = useRef<HTMLSpanElement>(null), timer = useRef(0)
  const [position, setPosition] = useState<{ x: number; y: number; side: boolean; left: boolean } | null>(null)
  const hide = () => { clearTimeout(timer.current); setPosition(null) }
  useEffect(() => () => clearTimeout(timer.current), [])
  const show = () => {
    clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const el = anchor.current
      if (!el) return
      const rect = el.getBoundingClientRect(), side = !!el.closest('.primary-tools')
      const left = side && rect.right + 180 > window.innerWidth
      setPosition({ x: side ? left ? rect.left - 12 : rect.right + 12 : Math.max(80, Math.min(window.innerWidth - 80, rect.left + rect.width / 2)), y: side ? rect.top + rect.height / 2 : rect.top > 48 ? rect.top - 8 : rect.bottom + 40, side, left })
    }, 550)
  }
  const parts = label.split(' · ')
  return <span ref={anchor} className="button-tooltip" onPointerEnter={show} onPointerLeave={hide} onPointerDown={hide} onFocus={show} onBlur={hide}>
    {children}
    {position && createPortal(<span className={`tool-tooltip ${position.side ? 'side' : ''} ${position.left ? 'left' : ''}`} role="tooltip" style={{ left: position.x, top: position.y }}><span>{parts[0]}</span>{parts.length > 1 && <kbd>{parts.slice(1).join(' · ')}</kbd>}</span>, document.body)}
  </span>
}
