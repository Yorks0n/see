import type { Camera } from '../store/camera'
import type { Rect } from './minimap'

// Screen-space overscan keeps labels, thick strokes and nearby cards mounted
// while navigating, without decoding every image in a large board.
export function inViewport(rect: Rect, camera: Camera, size: { width: number; height: number }, margin = 160): boolean {
  const left = rect.x * camera.zoom + camera.x, top = rect.y * camera.zoom + camera.y
  return left <= size.width + margin && top <= size.height + margin
    && left + rect.width * camera.zoom >= -margin && top + rect.height * camera.zoom >= -margin
}
