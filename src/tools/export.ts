import type { CanvasFile, CanvasNode, ImageNode } from '../types'
import { edgeGeometry, resolveColor, strokePath } from '../render/renderer'
import { expandSelection } from './tools'

const escape = (text: string) => text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!)
const blobURL = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(reader.result as string)
  reader.onerror = () => reject(new Error('图片读取失败'))
  reader.readAsDataURL(blob)
})
async function imageData(url: string) {
  if (url.startsWith('data:')) return url
  const response = await fetch(url)
  if (!response.ok) throw new Error('无法读取原图')
  return blobURL(await response.blob())
}
function textSVG(text: string, x: number, y: number, width: number, size = 14) {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = '', length = 0
    for (const character of paragraph) {
      const advance = /[\u0000-\u00ff]/.test(character) ? size * 0.58 : size
      if (length + advance > width && line) { lines.push(line); line = ''; length = 0 }
      line += character; length += advance
    }
    lines.push(line)
  }
  return `<text font-family="system-ui,sans-serif" font-size="${size}" fill="#45414f">${lines.map((line, index) => `<tspan x="${x}" y="${y + index * size * 1.6}">${escape(line)}</tspan>`).join('')}</text>`
}
export async function selectionSVG(doc: CanvasFile, ids?: Set<string>, format: 'svg' | 'png' = 'svg') {
  const expanded = ids?.size ? expandSelection(ids) : null
  const nodes = (doc.nodes ?? []).filter((n) => !expanded || expanded.has(n.id))
  if (!nodes.length) throw new Error('画布中没有可导出的内容')
  const singleImage = format === 'png' && nodes.length === 1 && nodes[0].type === 'image'
  const padding = singleImage ? 0 : 24, topPadding = singleImage ? 0 : 40
  const x = Math.min(...nodes.map((n) => n.x)) - padding, y = Math.min(...nodes.map((n) => n.y)) - topPadding
  const width = Math.max(...nodes.map((n) => n.x + n.width)) - x + padding, height = Math.max(...nodes.map((n) => n.y + n.height)) - y + padding
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const groups = nodes.filter((n) => n.type === 'group').map((n) => `<rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="10" fill="${escape(resolveColor(n.color, '#9b95ab'))}" fill-opacity=".07" stroke="${escape(resolveColor(n.color, '#9b95ab'))}" />${textSVG(n.type === 'group' ? n.label ?? '' : '', n.x + 8, n.y + (n.layout === 'list' ? 26 : -10), n.width - 16)}`).join('')
  const edges = (doc.edges ?? []).flatMap((edge) => {
    const geometry = edgeGeometry(edge, byId)
    if (!geometry) return []
    const color = escape(resolveColor(edge.color, '#609fbb'))
    return [`<path d="${geometry.path}" fill="none" stroke="${color}" stroke-width="4"/>${edge.label && edge.labelIsVisible !== false ? textSVG(edge.label, geometry.center.x + (edge.labelOffset?.x ?? 0), geometry.center.y + (edge.labelOffset?.y ?? 0), 260) : ''}`]
  }).join('')
  const cards = await Promise.all(nodes.filter((n) => n.type !== 'group').map(async (node: CanvasNode) => {
    if (node.type === 'rectangle') return `<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" fill="none" stroke="${escape(resolveColor(node.color, '#76717f'))}" stroke-width="2"/>`
    if (node.type === 'draw') return `<path transform="translate(${node.x},${node.y})" d="${strokePath(node.points)}" fill="none" stroke="${escape(resolveColor(node.color, '#44434d'))}" stroke-width="${node.strokeWidth ?? 3}" stroke-linecap="round" stroke-linejoin="round"/>`
    if (node.type === 'image') {
      const crop = node.crop ?? { x: 0, y: 0, width: 1, height: 1 }, url = await imageData(node.url)
      return `<svg x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" viewBox="0 0 ${node.width} ${node.height}" overflow="hidden"><image href="${escape(url)}" x="${-crop.x / crop.width * node.width}" y="${-crop.y / crop.height * node.height}" width="${node.width / crop.width}" height="${node.height / crop.height}" preserveAspectRatio="none"/>${node.text ? `<rect y="${Math.max(0, node.height - 44)}" width="${node.width}" height="44" fill="white" fill-opacity=".95"/>${textSVG(node.text, 10, Math.max(18, node.height - 22), node.width - 20, 13)}` : ''}</svg>`
    }
    const text = node.type === 'text' ? node.text : node.type === 'link' ? node.url : node.type === 'file' ? node.file : ''
    return `<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="10" fill="${escape(resolveColor(node.color, '#fff'))}" ${node.color ? 'fill-opacity=".18"' : ''} stroke="#e3eaee"/>${textSVG(text, node.x + 12, node.y + 25, node.width - 24)}`
  }))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${x} ${y} ${width} ${height}">${groups}${edges}${cards.join('')}</svg>`
}
export async function svgPNG(svg: string): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const image = new Image()
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('图片导出失败')); image.src = url })
    const canvas = document.createElement('canvas')
    const scale = Math.min(2, 8192 / Math.max(image.width, image.height))
    canvas.width = Math.max(1, Math.ceil(image.width * scale)); canvas.height = Math.max(1, Math.ceil(image.height * scale))
    const ctx = canvas.getContext('2d')!
    ctx.scale(scale, scale); ctx.drawImage(image, 0, 0)
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG 导出失败')), 'image/png'))
  } finally { URL.revokeObjectURL(url) }
}
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), link = document.createElement('a')
  link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export async function downloadOriginal(node: ImageNode) {
  const response = await fetch(node.url)
  if (!response.ok) throw new Error('无法下载原图')
  const blob = await response.blob()
  const extension = blob.type.split('/')[1]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') || 'png'
  downloadBlob(blob, `原图.${extension}`)
}
