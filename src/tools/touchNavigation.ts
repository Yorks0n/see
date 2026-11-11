import { clampZoom, type Camera } from '../store/camera'

type Point = { x: number; y: number }

export class TouchNavigation {
  private pointers = new Map<number, Point>()
  private origin: { camera: Camera; center: Point; distance: number } | null = null
  active = false

  get size() { return this.pointers.size }
  has(id: number) { return this.pointers.has(id) }

  private rebase(camera: Camera) {
    const [a, b] = this.pointers.values()
    this.origin = a && b ? {
      camera,
      center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
    } : null
  }

  start(id: number, point: Point, camera: Camera) {
    this.pointers.set(id, point)
    if (this.size >= 2) {
      this.active = true
      this.rebase(camera)
    }
  }

  move(id: number, point: Point): Camera | null {
    if (!this.has(id)) return null
    this.pointers.set(id, point)
    if (!this.origin) return null
    const [a, b] = this.pointers.values()
    const { camera, center, distance } = this.origin
    const zoom = clampZoom(camera.zoom * (Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)) / distance))
    return {
      zoom,
      x: (a.x + b.x) / 2 - (center.x - camera.x) * zoom / camera.zoom,
      y: (a.y + b.y) / 2 - (center.y - camera.y) * zoom / camera.zoom,
    }
  }

  end(id: number, camera: Camera) {
    if (!this.pointers.delete(id)) return false
    const consumed = this.active
    this.rebase(camera)
    // A remaining finger must not resume the tool gesture that the pinch cancelled.
    if (!this.size) this.active = false
    return consumed
  }
}
