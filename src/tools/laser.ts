import type { DrawPoint } from '../types'

export const LASER_LIFETIME = 900
export interface LaserPoint extends DrawPoint { time: number; start: boolean }

export class LaserTrail {
  points: LaserPoint[] = []
  onChange = () => {}

  add(point: DrawPoint, start: boolean, time = performance.now()) {
    this.prune(time)
    this.points.push({ ...point, time, start })
    this.onChange()
  }

  prune(time: number) {
    this.points = this.points.filter((point) => time - point.time < LASER_LIFETIME)
  }

  clear() {
    this.points = []
    this.onChange()
  }
}
