import { forwardRef, type ButtonHTMLAttributes } from 'react'
import type { Icon } from '@phosphor-icons/react'
import { Tooltip } from './Tooltip'

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { icon: Icon; label: string; active?: boolean }>(function IconButton({ icon: Icon, label, active, className = '', ...props }, ref) {
  return <Tooltip label={label}><button ref={ref} type="button" className={`icon-button ${active ? 'active' : ''} ${className}`} aria-label={label} aria-pressed={active === undefined ? undefined : active} {...props}><Icon size={20} weight={active ? 'fill' : 'regular'} aria-hidden="true" /></button></Tooltip>
})
