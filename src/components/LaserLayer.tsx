import { useEffect, useRef } from 'react'
import { cameraStore } from '../store/camera'
import { LASER_LIFETIME, type LaserTrail } from '../tools/laser'

export function LaserLayer({ trail }: { trail: LaserTrail }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current!, ctx = canvas.getContext('2d')!
    let raf = 0
    const render = (time: number) => {
      raf = 0
      const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      trail.prune(time)
      const camera = cameraStore.getSnapshot()
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'
      ctx.strokeStyle = '#ff344f'; ctx.fillStyle = '#ff344f'
      ctx.shadowColor = '#ff344f'; ctx.shadowBlur = 8
      trail.points.forEach((point, i) => {
        const opacity = Math.max(0, 1 - (time - point.time) / LASER_LIFETIME)
        const x = point.x * camera.zoom + camera.x, y = point.y * camera.zoom + camera.y
        const previous = trail.points[i - 1]
        ctx.globalAlpha = opacity
        ctx.lineWidth = 3 * opacity + 0.5
        ctx.beginPath()
        if (previous && !point.start) {
          ctx.moveTo(previous.x * camera.zoom + camera.x, previous.y * camera.zoom + camera.y)
          ctx.lineTo(x, y); ctx.stroke()
        } else {
          ctx.arc(x, y, 2.5 * opacity, 0, Math.PI * 2); ctx.fill()
        }
      })
      ctx.globalAlpha = 1
      if (trail.points.length) raf = requestAnimationFrame(render)
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(render) }
    trail.onChange = schedule
    const unsubscribe = cameraStore.subscribe(schedule)
    const observer = new ResizeObserver(schedule)
    observer.observe(canvas); schedule()
    return () => { cancelAnimationFrame(raf); observer.disconnect(); unsubscribe(); trail.onChange = () => {} }
  }, [trail])
  return <canvas ref={ref} className="canvas laser" aria-hidden="true" />
}
