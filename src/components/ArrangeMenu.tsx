import { forwardRef, useState } from 'react'
import type { Icon, IconProps } from '@phosphor-icons/react'
import { IconButton } from './IconButton'
import { List } from './icons'
import { arrangeNodes, listFromSelection } from '../tools/tools'
import type { ArrangeMode } from '../tools/layout'

const HorizontalArrange = forwardRef<SVGSVGElement, IconProps>(function HorizontalArrange({ size = 20, weight: _weight, mirrored: _mirrored, ...props }, ref) {
  return <svg ref={ref} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M3 3h18" strokeDasharray="2 3" /><rect x="3" y="7" width="6" height="13" rx="1.5" /><rect x="15" y="7" width="6" height="9" rx="1.5" /><path d="M12 10v7" strokeDasharray="1 3" /></svg>
})
const VerticalArrange = forwardRef<SVGSVGElement, IconProps>(function VerticalArrange({ size = 20, weight: _weight, mirrored: _mirrored, ...props }, ref) {
  return <svg ref={ref} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M3 3v18" strokeDasharray="2 3" /><rect x="7" y="3" width="13" height="6" rx="1.5" /><rect x="7" y="15" width="9" height="6" rx="1.5" /><path d="M10 12h7" strokeDasharray="1 3" /></svg>
})
const OPTIONS: { id: ArrangeMode; label: string; icon: Icon }[] = [
  { id: 'horizontal', label: '水平等间距 · 顶部对齐', icon: HorizontalArrange },
  { id: 'vertical', label: '垂直等间距 · 左侧对齐', icon: VerticalArrange },
]
export function ArrangeMenu({ selection, setSelection }: { selection: Set<string>; setSelection: (selection: Set<string>) => void }) {
  const [open, setOpen] = useState(false)
  return <div className="arrange-control">
    <IconButton icon={HorizontalArrange} label="快速排列与对齐" active={open} aria-expanded={open} onClick={() => setOpen(!open)} />
    <IconButton icon={List} label="转换为列表" onClick={() => { const list = listFromSelection(selection); if (list) setSelection(new Set([list.id])) }} />
    {open && <div className="arrange-pop floating-panel" role="toolbar" aria-label="快速排列与对齐">
      {OPTIONS.map((option) => <IconButton key={option.id} icon={option.icon} label={option.label} onClick={() => { arrangeNodes(selection, option.id); setOpen(false) }} />)}
    </div>}
  </div>
}
