import type { Camera } from '../store/camera'
import type { Rect } from './minimap'

export function editingCamera(camera: Camera, card: Rect, size: { width: number; height: number }, caret = card): Camera {
  const left = Math.min(24, size.width * 0.1), right = size.width - left
  const top = Math.min(80, size.height * 0.2), bottom = size.height - Math.min(96, size.height * 0.25)
  const horizontal = card.width <= right - left ? card : caret
  const vertical = card.height <= bottom - top ? card : caret
  const dx = Math.max(left - horizontal.x, Math.min(0, right - horizontal.x - Math.min(horizontal.width, right - left)))
  const dy = Math.max(top - vertical.y, Math.min(0, bottom - vertical.y - Math.min(vertical.height, bottom - top)))
  return dx || dy ? { ...camera, x: camera.x + dx, y: camera.y + dy } : camera
}
