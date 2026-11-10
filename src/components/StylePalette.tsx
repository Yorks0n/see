import { colorKeys, COLOR_NAMES, PRESET_COLORS } from '../render/renderer'
import type { CanvasColor } from '../types'
export function StylePalette(props: { color?: CanvasColor; onChange: (color?: CanvasColor) => void; defaultLabel?: string; showDefault?: boolean }) {
  return <div className="color-palette" role="group" aria-label="颜色">
    {props.showDefault !== false && <button className={`color-dot default-dot ${!props.color ? 'chosen' : ''}`} title={props.defaultLabel ?? '默认颜色'} aria-label={props.defaultLabel ?? '默认颜色'} aria-pressed={!props.color} onClick={() => props.onChange(undefined)} />}
    {colorKeys.map((color) => <button key={color} className={`color-dot ${color === props.color ? 'chosen' : ''}`} style={{ background: PRESET_COLORS[color] }} title={COLOR_NAMES[color]} aria-label={COLOR_NAMES[color]} aria-pressed={color === props.color} onClick={() => props.onChange(color)} />)}
  </div>
}
