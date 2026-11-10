import type { ImageNode } from '../types'

export type CropHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw' | 'move'
export const FULL_CROP = { x: 0, y: 0, width: 1, height: 1 }
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export function uncroppedBounds(node: ImageNode) {
  const crop = node.crop ?? FULL_CROP
  const width = node.width / crop.width, height = node.height / crop.height
  return { x: node.x - crop.x * width, y: node.y - crop.y * height, width, height }
}

export function cropImage(node: ImageNode, handle: CropHandle, dx: number, dy: number): Partial<ImageNode> {
  const full = uncroppedBounds(node), initial = node.crop ?? FULL_CROP
  let left = initial.x, top = initial.y, right = left + initial.width, bottom = top + initial.height
  const minWidth = Math.min(initial.width, 24 / full.width), minHeight = Math.min(initial.height, 24 / full.height)
  if (handle === 'move') {
    left = clamp(left + dx / full.width, 0, 1 - initial.width)
    top = clamp(top + dy / full.height, 0, 1 - initial.height)
    right = left + initial.width; bottom = top + initial.height
  } else {
    if (handle.includes('w')) left = clamp(left + dx / full.width, 0, right - minWidth)
    if (handle.includes('e')) right = clamp(right + dx / full.width, left + minWidth, 1)
    if (handle.includes('n')) top = clamp(top + dy / full.height, 0, bottom - minHeight)
    if (handle.includes('s')) bottom = clamp(bottom + dy / full.height, top + minHeight, 1)
  }
  const crop = { x: left, y: top, width: right - left, height: bottom - top }
  const isFull = left < 1e-8 && top < 1e-8 && right > 1 - 1e-8 && bottom > 1 - 1e-8
  return { x: full.x + left * full.width, y: full.y + top * full.height, width: crop.width * full.width, height: crop.height * full.height, crop: isFull ? undefined : crop }
}
