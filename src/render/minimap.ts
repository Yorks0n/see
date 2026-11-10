import { clampZoom, type Camera } from '../store/camera'
import type { CanvasNode } from '../types'

export interface Rect { x: number; y: number; width: number; height: number }

export function viewportRect(camera: Camera, size: { width: number; height: number }): Rect {
  return { x: -camera.x / camera.zoom, y: -camera.y / camera.zoom, width: size.width / camera.zoom, height: size.height / camera.zoom }
}

export function minimapBounds(nodes: CanvasNode[], viewport: Rect, aspect: number): Rect {
  let left = viewport.x, top = viewport.y, right = left + viewport.width, bottom = top + viewport.height
  for (const node of nodes) {
    left = Math.min(left, node.x); top = Math.min(top, node.y)
    right = Math.max(right, node.x + node.width); bottom = Math.max(bottom, node.y + node.height)
  }
  const padding = Math.max(80, Math.max(right - left, bottom - top) * 0.08)
  let width = right - left + padding * 2, height = bottom - top + padding * 2
  if (width / height < aspect) width = height * aspect
  else height = width / aspect
  return { x: (left + right - width) / 2, y: (top + bottom - height) / 2, width, height }
}

export function cameraAtCenter(point: { x: number; y: number }, size: { width: number; height: number }, zoom: number): Camera {
  return { x: size.width / 2 - point.x * zoom, y: size.height / 2 - point.y * zoom, zoom }
}

export function minimapCamera(point: { x: number; y: number }, size: { width: number; height: number }, zoom: number, bounds: Rect, inset = 0): Camera {
  const halfWidth = Math.min(bounds.width / 2, size.width / (2 * zoom) + inset)
  const halfHeight = Math.min(bounds.height / 2, size.height / (2 * zoom) + inset)
  return cameraAtCenter({
    x: Math.max(bounds.x + halfWidth, Math.min(bounds.x + bounds.width - halfWidth, point.x)),
    y: Math.max(bounds.y + halfHeight, Math.min(bounds.y + bounds.height - halfHeight, point.y)),
  }, size, zoom)
}

export function zoomAtCenter(camera: Camera, size: { width: number; height: number }, zoom: number): Camera {
  const viewport = viewportRect(camera, size)
  return cameraAtCenter({ x: viewport.x + viewport.width / 2, y: viewport.y + viewport.height / 2 }, size, clampZoom(zoom))
}
