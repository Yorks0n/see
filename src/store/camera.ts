export interface Camera {
  x: number
  y: number
  zoom: number
}

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
      x: patch.x ?? this.camera.x,
      y: patch.y ?? this.camera.y,
      zoom: Math.min(4, Math.max(0.1, patch.zoom ?? this.camera.zoom)),
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
