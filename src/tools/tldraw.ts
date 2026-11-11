import type { CanvasColor, CanvasEdge, CanvasFile, CanvasNode, DrawPoint, NodeSide } from '../types'

type RecordData = Record<string, any>
const object = (value: unknown): RecordData => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordData : {}
const number = (value: unknown, fallback = 0): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback
const string = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback
const colors: Record<string, CanvasColor> = {
  black: '#1d1d1d', grey: '#9fa8b2', white: '#ffffff', red: '#e03131', 'light-red': '#ff8787',
  orange: '#f08c00', yellow: '#f1c40f', green: '#099268', 'light-green': '#69db7c',
  blue: '#4263eb', 'light-blue': '#4dabf7', violet: '#7048e8', 'light-violet': '#b197fc',
}
const color = (value: unknown): CanvasColor => Object.prototype.hasOwnProperty.call(colors, string(value)) ? colors[string(value)] : '#1d1d1d'
const byIndex = (a: RecordData, b: RecordData) => string(a.index) < string(b.index) ? -1 : string(a.index) > string(b.index) ? 1 : 0

function richText(value: unknown, markdown = true): string {
  const node = object(value)
  if (node.type === 'text') {
    let text = string(node.text)
    for (const mark of Array.isArray(node.marks) ? node.marks : []) {
      // see currently supports links, headings and lists, but not inline marks.
      if (markdown && mark.type === 'link') text = `[${text}](${string(object(mark.attrs).href)})`
    }
    return text
  }
  if (node.type === 'hardBreak') return '\n'
  const children = Array.isArray(node.content) ? node.content : []
  if (node.type === 'bulletList' || node.type === 'orderedList') {
    return children.map((child, index) => `${node.type === 'bulletList' ? '-' : `${index + 1}.`} ${richText(child, markdown).trim()}`).join('\n') + '\n'
  }
  const text = children.map((child) => richText(child, markdown)).join('')
  if (node.type === 'heading') return `${markdown ? '#'.repeat(Math.max(1, Math.min(3, number(object(node.attrs).level, 1)))) + ' ' : ''}${text}\n`
  return text + (['paragraph', 'listItem', 'blockquote'].includes(node.type) ? '\n' : '')
}
const textOf = (props: RecordData, markdown = true) => props.richText ? richText(props.richText, markdown).trimEnd() : string(props.text)

// tldraw stores old segments as points (or Float16 triples), newer paths as
// a Float32 start followed by Float16 deltas, in two or three dimensions.
function segmentPoints(segment: RecordData): DrawPoint[] {
  if (Array.isArray(segment.points)) return segment.points.filter((p: any) => Number.isFinite(p?.x) && Number.isFinite(p?.y)).map((p: DrawPoint) => ({ x: p.x, y: p.y }))
  const path = typeof segment.path === 'string' ? segment.path : string(segment.points)
  if (!path) return []
  const bytes = Uint8Array.from(atob(path), (c) => c.charCodeAt(0)), view = new DataView(bytes.buffer)
  const half = (offset: number) => {
    const bits = view.getUint16(offset, true), exponent = (bits >> 10) & 31, fraction = bits & 1023
    return (bits & 32768 ? -1 : 1) * (exponent === 0 ? fraction * 2 ** -24 : exponent === 31 ? NaN : (1 + fraction / 1024) * 2 ** (exponent - 15))
  }
  const points: DrawPoint[] = [], legacy = typeof segment.path !== 'string', dim = segment.dim === 2 ? 2 : 3
  const first = legacy ? 0 : dim * 4, stride = legacy ? 6 : dim * 2
  if (bytes.length < first || (bytes.length - first) % stride) throw new Error('无效的 tldraw 笔迹')
  let x = 0, y = 0
  if (!legacy) { x = view.getFloat32(0, true); y = view.getFloat32(4, true); points.push({ x, y }) }
  for (let offset = first; offset < bytes.length; offset += stride) {
    x = (legacy ? 0 : x) + half(offset); y = (legacy ? 0 : y) + half(offset + 2)
    points.push({ x, y })
  }
  if (points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error('无效的 tldraw 笔迹')
  return points
}

function bounds(points: DrawPoint[]) {
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity
  for (const p of points) { x = Math.min(x, p.x); y = Math.min(y, p.y); right = Math.max(right, p.x); bottom = Math.max(bottom, p.y) }
  return points.length ? { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) } : { x: 0, y: 0, width: 200, height: 80 }
}
const escape = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)

export function importTldraw(raw: unknown): CanvasFile | null {
  const file = object(raw), snapshot = object(file.document), store = file.store ?? snapshot.store
  const values = Array.isArray(file.records) ? file.records : store && typeof store === 'object' && !Array.isArray(store) ? Object.values(store) : null
  if (!values) {
    if ('tldrawFileFormatVersion' in file || snapshot.version) throw new Error('不支持此 tldraw 文件版本，请用 tldraw 重新导出 .tldr 文件')
    return null
  }
  if (file.tldrawFileFormatVersion !== undefined && file.tldrawFileFormatVersion !== 1) throw new Error('不支持此 tldraw 文件版本')
  if (values.some((r) => typeof object(r).id !== 'string' || !object(r).id || typeof object(r).typeName !== 'string')) throw new Error('无效的 tldraw 记录')
  const records = values as RecordData[], byId = new Map(records.map((r) => [r.id, r]))
  if (byId.size !== records.length) throw new Error('tldraw 文件包含重复 ID')
  const shapes = records.filter((r) => r.typeName === 'shape')
  if (shapes.some((r) => !Number.isFinite(r.x) || !Number.isFinite(r.y) || !r.type)) throw new Error('无效的 tldraw 形状')
  const warnings = new Set<string>(), nodes: CanvasNode[] = [], edges: CanvasEdge[] = []
  const generated = new Set(byId.keys())
  const newId = (base: string) => {
    let id = `see:${base}`
    while (generated.has(id)) id += ':'
    generated.add(id)
    return id
  }
  const transforms = new Map<string, { x: number; y: number; rotation: number; page: string }>()
  const transform = (shape: RecordData, visiting = new Set<string>()): { x: number; y: number; rotation: number; page: string } => {
    const cached = transforms.get(shape.id)
    if (cached) return cached
    if (visiting.has(shape.id)) throw new Error('tldraw 分组包含循环引用')
    visiting.add(shape.id)
    const parent = byId.get(shape.parentId)
    const t = parent?.typeName === 'shape' ? transform(parent, visiting) : { x: 0, y: 0, rotation: 0, page: string(shape.parentId, 'page:import') }
    const result = {
      x: t.x + shape.x * Math.cos(t.rotation) - shape.y * Math.sin(t.rotation),
      y: t.y + shape.x * Math.sin(t.rotation) + shape.y * Math.cos(t.rotation),
      rotation: t.rotation + number(shape.rotation), page: t.page,
    }
    transforms.set(shape.id, result)
    return result
  }
  const nodePages = new Map<string, string>(), nodeParents = new Map<string, string>(), nodeShapes = new Map<string, string>()
  const add = (shape: RecordData, node: CanvasNode) => {
    nodes.push(node); nodePages.set(node.id, transform(shape).page); nodeParents.set(node.id, shape.parentId); nodeShapes.set(node.id, shape.id)
  }
  const world = (shape: RecordData, p: DrawPoint) => {
    const t = transform(shape)
    return { x: t.x + p.x * Math.cos(t.rotation) - p.y * Math.sin(t.rotation), y: t.y + p.x * Math.sin(t.rotation) + p.y * Math.cos(t.rotation) }
  }
  const draw = (shape: RecordData, points: DrawPoint[], id = shape.id) => {
    if (!points.length) { warnings.add('空笔迹已转为占位卡片'); add(shape, { id, type: 'text', ...bounds([world(shape, { x: 0, y: 0 })]), text: '[空笔迹]' }); return }
    const transformed = points.map((p) => world(shape, p)), box = bounds(transformed), props = object(shape.props)
    add(shape, { id, type: 'draw', ...box, color: color(props.color), points: transformed.map((p) => ({ x: p.x - box.x, y: p.y - box.y })), strokeWidth: Math.min(24, ({ s: 2, m: 3.5, l: 5, xl: 10 }[string(props.size)] ?? 3) * number(props.scale, 1)) })
  }
  // Sort siblings within their parent so grouped content keeps its stacking order.
  const ordered: RecordData[] = []
  const children = new Map<string, RecordData[]>()
  for (const shape of shapes) {
    transform(shape)
    const siblings = children.get(shape.parentId) ?? []
    siblings.push(shape); children.set(shape.parentId, siblings)
  }
  const visit = (items: RecordData[]) => { for (const shape of items.sort(byIndex)) { ordered.push(shape); visit(children.get(shape.id) ?? []) } }
  visit(shapes.filter((s) => byId.get(s.parentId)?.typeName !== 'shape'))
  const arrows: RecordData[] = []
  for (const shape of ordered) {
    const props = object(shape.props), t = transform(shape), text = textOf(props, shape.type !== 'geo')
    const scale = number(props.scale, 1)
    const width = Math.max(1, number(props.w, shape.type === 'note' ? 200 : 260) * (['text', 'note'].includes(shape.type) ? scale : 1))
    const height = Math.max(1, (number(props.h, shape.type === 'note' ? 200 + number(props.growY) : Math.max(40, text.split('\n').length * 28)) + (shape.type === 'geo' ? number(props.growY) : 0)) * (['text', 'note'].includes(shape.type) ? scale : 1))
    const box = bounds([{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }].map((p) => world(shape, p)))
    const base = { id: shape.id, ...box, color: color(props.color) }
    if (shape.isLocked || number(shape.opacity, 1) !== 1) warnings.add('未导入锁定和透明度')
    if (shape.type === 'arrow') { arrows.push(shape); continue }
    if (shape.type === 'group' || shape.type === 'frame') {
      add(shape, { ...base, type: 'group', label: string(props.name), memberIds: [] })
    } else if (shape.type === 'text' || shape.type === 'note') {
      add(shape, { ...base, type: 'text', text, color: shape.type === 'text' && (!props.color || props.color === 'black') ? undefined : base.color })
      warnings.add('文字与便签使用 see 排版，字体、旋转和部分富文本样式可能不同')
    } else if (shape.type === 'image') {
      const asset = object(byId.get(props.assetId)?.props), url = string(asset.src)
      if (url) {
        const crop = object(props.crop), start = object(crop.topLeft), end = object(crop.bottomRight)
        add(shape, { ...base, type: 'image', url, text: string(props.altText) || undefined,
          naturalWidth: number(asset.w, width), naturalHeight: number(asset.h, height),
          crop: crop.topLeft && crop.bottomRight ? { x: number(start.x), y: number(start.y), width: number(end.x, 1) - number(start.x), height: number(end.y, 1) - number(start.y) } : undefined })
        if (t.rotation || props.flipX || props.flipY || crop.isCircle) warnings.add('未导入图片旋转、翻转和圆形裁剪')
      } else { add(shape, { ...base, type: 'text', text: `[缺失图片] ${string(asset.name)}` }); warnings.add('部分图片缺少资源，已保留占位卡片') }
    } else if (['bookmark', 'embed', 'video'].includes(shape.type)) {
      const asset = object(byId.get(props.assetId)?.props), url = string(shape.type === 'video' ? asset.src : props.url)
      add(shape, url ? { ...base, type: 'link', url } : { ...base, type: 'text', text: `[${shape.type}] ${string(asset.name)}` })
      warnings.add('书签、嵌入内容和视频转为链接或占位卡片')
    } else if (shape.type === 'draw' || shape.type === 'highlight') {
      const segments = Array.isArray(props.segments) ? props.segments : []
      const points = segments.flatMap((s) => segmentPoints(object(s))).map((p) => ({ x: p.x * number(props.scaleX, 1), y: p.y * number(props.scaleY, 1) }))
      draw(shape, points)
      warnings.add('笔迹保留路径，压感、填充和荧光效果使用 see 样式')
    } else if (shape.type === 'line') {
      const points = Object.values(object(props.points ?? props.handles)).map(object).sort(byIndex).map((p) => ({ x: number(p.x), y: number(p.y) }))
      draw(shape, points)
      warnings.add('折线和曲线使用 see 笔迹样式')
    } else if (shape.type === 'geo') {
      if (props.geo === 'rectangle' && !text && (!props.fill || props.fill === 'none') && !t.rotation) add(shape, { ...base, type: 'rectangle' })
      else {
        let geometry: string
        if (props.geo === 'ellipse' || props.geo === 'oval') geometry = `<ellipse cx="${width / 2}" cy="${height / 2}" rx="${width / 2}" ry="${height / 2}"/>`
        else if (props.geo === 'diamond') geometry = `<polygon points="${width / 2},0 ${width},${height / 2} ${width / 2},${height} 0,${height / 2}"/>`
        else if (props.geo === 'triangle') geometry = `<polygon points="${width / 2},0 ${width},${height} 0,${height}"/>`
        else if (['hexagon', 'pentagon', 'octagon', 'star'].includes(props.geo)) {
          const count = props.geo === 'star' ? 10 : props.geo === 'hexagon' ? 6 : props.geo === 'pentagon' ? 5 : 8
          const points = Array.from({ length: count }, (_, i) => {
            const angle = i * 2 * Math.PI / count - Math.PI / 2, radius = props.geo === 'star' && i % 2 ? 0.45 : 1
            return `${width / 2 + Math.cos(angle) * width / 2 * radius},${height / 2 + Math.sin(angle) * height / 2 * radius}`
          })
          geometry = `<polygon points="${points.join(' ')}"/>`
        } else { geometry = `<rect width="${width}" height="${height}"/>`; if (props.geo !== 'rectangle') warnings.add('部分几何形状近似为矩形') }
        const lines = text.split('\n')
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${box.width + 4}" height="${box.height + 4}" viewBox="${box.x - 2} ${box.y - 2} ${box.width + 4} ${box.height + 4}"><g transform="translate(${t.x} ${t.y}) rotate(${t.rotation * 180 / Math.PI})"><g stroke="${base.color}" stroke-width="2" fill="${props.fill && props.fill !== 'none' ? base.color : 'none'}" fill-opacity=".18">${geometry}</g><text text-anchor="middle" font-family="sans-serif" font-size="18" fill="${color(props.labelColor ?? props.color)}">${lines.map((line, i) => `<tspan x="${width / 2}" y="${height / 2 + (i - (lines.length - 1) / 2) * 24}">${escape(line)}</tspan>`).join('')}</text></g></svg>`
        add(shape, { ...base, x: box.x - 2, y: box.y - 2, width: box.width + 4, height: box.height + 4, type: 'image', url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, naturalWidth: box.width + 4, naturalHeight: box.height + 4 })
        warnings.add('带样式的几何形状转为 SVG 图片，可移动和缩放，内部文字不能直接编辑')
      }
    } else {
      add(shape, { ...base, type: 'text', text: text || string(props.url) || `[tldraw: ${shape.type}]` })
      warnings.add(`不支持的 ${shape.type} 已保留为占位卡片`)
    }
  }
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  for (const shape of arrows) {
    const props = object(shape.props)
    const binding = (terminal: string) => records.find((r) => r.typeName === 'binding' && r.type === 'arrow' && r.fromId === shape.id && object(r.props).terminal === terminal)
    const start = binding('start'), end = binding('end')
    const from = nodeById.get(start?.toId ?? object(props.start).boundShapeId), to = nodeById.get(end?.toId ?? object(props.end).boundShapeId)
    const side = (anchor: RecordData): NodeSide | undefined => {
      if (!Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) return undefined
      const choices: [NodeSide, number][] = [['left', anchor.x], ['right', 1 - anchor.x], ['top', anchor.y], ['bottom', 1 - anchor.y]]
      return choices.sort((a, b) => a[1] - b[1])[0][0]
    }
    if (from && to) {
      edges.push({ id: shape.id, fromNode: from.id, toNode: to.id, fromSide: side(object(start?.props?.normalizedAnchor ?? props.start?.normalizedAnchor)), toSide: side(object(end?.props?.normalizedAnchor ?? props.end?.normalizedAnchor)),
        fromEnd: props.arrowheadStart && props.arrowheadStart !== 'none' ? 'arrow' : 'none', toEnd: props.arrowheadEnd === 'none' ? 'none' : 'arrow',
        color: color(props.color), label: textOf(props, false), lineStyle: number(props.bend) ? 'curve' : 'straight' })
    } else {
      const endpoint = (value: unknown, target: CanvasNode | undefined) => {
        if (!target) return { x: number(object(value).x), y: number(object(value).y) }
        const t = transform(shape), dx = target.x + target.width / 2 - t.x, dy = target.y + target.height / 2 - t.y
        return { x: dx * Math.cos(t.rotation) + dy * Math.sin(t.rotation), y: -dx * Math.sin(t.rotation) + dy * Math.cos(t.rotation) }
      }
      const a = endpoint(props.start, from), b = endpoint(props.end, to), points = [a, b]
      const head = (tip: DrawPoint, tail: DrawPoint) => {
        const angle = Math.atan2(tip.y - tail.y, tip.x - tail.x)
        return [{ x: tip.x - 12 * Math.cos(angle - 0.5), y: tip.y - 12 * Math.sin(angle - 0.5) }, tip, { x: tip.x - 12 * Math.cos(angle + 0.5), y: tip.y - 12 * Math.sin(angle + 0.5) }, tip]
      }
      if (props.arrowheadEnd !== 'none') points.push(...head(b, a))
      if (props.arrowheadStart && props.arrowheadStart !== 'none') points.unshift(...head(a, b))
      draw(shape, points)
      if (textOf(props)) {
        const center = world(shape, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
        add(shape, { id: newId(`${shape.id}:label`), type: 'text', x: center.x, y: center.y, width: 200, height: 48, text: textOf(props) })
      }
    }
    warnings.add('箭头使用 see 连线或笔迹样式，弯曲、端点和标签位置可能不同')
  }
  const order = new Map(ordered.map((shape, index) => [shape.id, index]))
  nodes.sort((a, b) => order.get(nodeShapes.get(a.id)!)! - order.get(nodeShapes.get(b.id)!)!)
  // Resolve groups inside out, then lay out all pages side by side.
  for (const shape of [...ordered].reverse()) {
    const node = nodeById.get(shape.id)
    if (node?.type !== 'group') continue
    const members = nodes.filter((n) => nodeParents.get(n.id) === shape.id)
    node.memberIds = members.map((n) => n.id)
    if (shape.type === 'group' && members.length) Object.assign(node, bounds(members.flatMap((n) => [{ x: n.x, y: n.y }, { x: n.x + n.width, y: n.y + n.height }])))
  }
  const pages = [...new Set(nodes.map((n) => nodePages.get(n.id)!))].sort((a, b) => byIndex(byId.get(a) ?? {}, byId.get(b) ?? {}))
  if (pages.length > 1) {
    let left = 0
    for (const page of pages) {
      const members = nodes.filter((n) => nodePages.get(n.id) === page), box = bounds(members.flatMap((n) => [{ x: n.x, y: n.y }, { x: n.x + n.width, y: n.y + n.height }]))
      for (const node of members) { node.x += left - box.x; node.y -= box.y }
      nodes.unshift({ id: newId(page), type: 'group', x: left - 32, y: -48, width: box.width + 64, height: box.height + 80, label: string(byId.get(page)?.name, '页面'), memberIds: members.map((n) => n.id) })
      left += box.width + 160
    }
    warnings.add('多个页面已并排放置到同一白板')
  }
  const document = records.find((r) => r.typeName === 'document')
  const area = bounds(nodes.flatMap((n) => [{ x: n.x, y: n.y }, { x: n.x + n.width, y: n.y + n.height }]))
  return { nodes, edges, meta: { name: string(document?.name) || undefined, camera: { x: 80 - area.x, y: 100 - area.y, zoom: 1 }, tldraw: { warnings: [...warnings] } } }
}
