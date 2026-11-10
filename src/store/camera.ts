export interface Camera {
  x: number
  y: number
  zoom: number
}

export const MIN_ZOOM = 0.2
export const MAX_ZOOM = 3
export const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))

type Listener = () => void

export class CameraStore {
  private camera: Camera = { x: 0, y: 0, zoom: 1 }
  private listeners = new Set<Listener>()

  subscribe = (l: Listener) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  getSnapshot = (): Camera => this.camera
  private emit() {
    this.camera = { ...this.camera }
    this.listeners.forEach((l) => l())
  }

  set(patch: Partial<Camera>) {
    this.camera = {
      x: Number.isFinite(patch.x) ? patch.x! : this.camera.x,
      y: Number.isFinite(patch.y) ? patch.y! : this.camera.y,
      zoom: clampZoom(Number.isFinite(patch.zoom) ? patch.zoom! : this.camera.zoom),
    }
    this.emit()
  }

  screenToWorld(sx: number, sy: number) {
    const { x, y, zoom } = this.camera
    return { x: (sx - x) / zoom, y: (sy - y) / zoom }
  }
  worldToScreen(wx: number, wy: number) {
    const { x, y, zoom } = this.camera
    return { x: wx * zoom + x, y: wy * zoom + y }
  }
}

export const cameraStore = new CameraStore()
