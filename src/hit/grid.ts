export interface Rect {
  id: string
  x: number
  y: number
  width: number
  height: number
}

const GRID_SIZE = 100

export class SpatialGrid {
  private grid = new Map<string, string[]>()

  constructor(rects: Rect[]) {
    for (const r of rects) {
      const c0 = Math.floor(r.x / GRID_SIZE)
      const r0 = Math.floor(r.y / GRID_SIZE)
      const c1 = Math.floor((r.x + r.width) / GRID_SIZE)
      const r1 = Math.floor((r.y + r.height) / GRID_SIZE)
      for (let row = r0; row <= r1; row++) {
        for (let col = c0; col <= c1; col++) {
          const key = `${row},${col}`
          const cell = this.grid.get(key)
          if (cell) cell.push(r.id)
          else this.grid.set(key, [r.id])
        }
      }
    }
  }

  queryPoint(x: number, y: number, rects: Map<string, Rect>): Rect[] {
    const key = `${Math.floor(y / GRID_SIZE)},${Math.floor(x / GRID_SIZE)}`
    const ids = this.grid.get(key) ?? []
    const hits: Rect[] = []
    const seen = new Set<string>()
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      const r = rects.get(id)
      if (r && x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) hits.push(r)
    }
    return hits
  }

  queryRect(x: number, y: number, width: number, height: number, rects: Map<string, Rect>): Rect[] {
    const c0 = Math.floor(x / GRID_SIZE)
    const r0 = Math.floor(y / GRID_SIZE)
    const c1 = Math.floor((x + width) / GRID_SIZE)
    const r1 = Math.floor((y + height) / GRID_SIZE)
    const seen = new Set<string>()
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        for (const id of this.grid.get(`${row},${col}`) ?? []) seen.add(id)
      }
    }
    const hits: Rect[] = []
    for (const id of seen) {
      const r = rects.get(id)
      if (
        r &&
        r.x < x + width &&
        r.x + r.width > x &&
        r.y < y + height &&
        r.y + r.height > y
      ) {
        hits.push(r)
      }
    }
    return hits
  }
}

export function buildGrid(rects: Rect[]): { grid: SpatialGrid; rectsById: Map<string, Rect> } {
  const rectsById = new Map(rects.map((r) => [r.id, r]))
  return { grid: new SpatialGrid(rects), rectsById }
}
