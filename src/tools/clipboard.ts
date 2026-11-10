import { documentStore, restoreCanvas, uid } from '../store/document'
import type { CanvasEdge, CanvasNode, DrawPoint } from '../types'
import { contains, expandSelection, updateMembership } from './tools'

export const CLIPBOARD_MIME = 'application/x-see-selection'

interface ClipboardSelection {
  type: 'see/selection'
  version: 1
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  selection: string[]
}

export function copySelection(ids: Set<string>): ClipboardSelection | null {
  const doc = documentStore.getSnapshot(), all = expandSelection(ids)
  const nodes = (doc.nodes ?? []).filter((node) => all.has(node.id))
  if (!nodes.length) return null
  const x = Math.min(...nodes.map((node) => node.x)), y = Math.min(...nodes.map((node) => node.y))
  return JSON.parse(JSON.stringify({
    type: 'see/selection', version: 1,
    nodes: nodes.map((node) => ({
      ...node, x: node.x - x, y: node.y - y,
      ...(node.type === 'group' ? { memberIds: (node.memberIds ?? nodes.filter((n) => n.id !== node.id && contains(node, n)).map((n) => n.id)).filter((id) => all.has(id)) } : {}),
    })),
    edges: (doc.edges ?? []).filter((edge) => all.has(edge.fromNode) && all.has(edge.toNode)),
    selection: [...ids].filter((id) => nodes.some((node) => node.id === id)),
  }))
}

export function writeClipboard(data: DataTransfer, content: ClipboardSelection) {
  const json = JSON.stringify(content)
  const text = content.nodes.map((node) => {
    if (node.type === 'text') return node.text
    if (node.type === 'image') return node.text || node.url
    if (node.type === 'link') return node.url
    if (node.type === 'file') return node.file
    if (node.type === 'group') return node.label ?? ''
    return ''
  }).filter(Boolean).join('\n')
  const escaped = text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!)
  data.setData(CLIPBOARD_MIME, json)
  data.setData('text/plain', text)
  // HTML carries the full selection across tabs even when custom MIME types are stripped.
  data.setData('text/html', `<div data-see-selection="${encodeURIComponent(json)}">${escaped}</div>`)
}

export function readClipboard(data: DataTransfer): ClipboardSelection | null {
  try {
    const html = data.getData('text/html').match(/data-see-selection="([^"]+)"/)?.[1]
    const json = data.getData(CLIPBOARD_MIME) || (html ? decodeURIComponent(html) : '')
    if (!json) return null
    const raw = JSON.parse(json)
    if (raw?.type !== 'see/selection' || raw.version !== 1 || !Array.isArray(raw.nodes) || !Array.isArray(raw.selection)) return null
    const restored = restoreCanvas(raw), nodes = restored.nodes ?? [], edges = restored.edges ?? []
    const ids = new Set(nodes.map((node) => node.id))
    if (!nodes.length || ids.size !== nodes.length) return null
    const selection = raw.selection.filter((id: unknown): id is string => typeof id === 'string' && ids.has(id))
    if (!selection.length) return null
    return { type: 'see/selection', version: 1, nodes, edges, selection }
  } catch {
    return null
  }
}

export function pasteSelection(content: ClipboardSelection, origin: DrawPoint): Set<string> {
  const { nodes, edges, selection } = JSON.parse(JSON.stringify(content)) as ClipboardSelection
  const idMap = new Map(nodes.map((node) => [node.id, uid()]))
  const members = new Set(nodes.flatMap((node) => node.type === 'group' ? node.memberIds ?? [] : []))
  documentStore.transact(() => {
    for (const node of nodes) {
      const copy = { ...node, id: idMap.get(node.id)!, x: node.x + origin.x, y: node.y + origin.y }
      if (copy.type === 'group') copy.memberIds = (copy.memberIds ?? []).flatMap((id) => idMap.has(id) ? [idMap.get(id)!] : [])
      documentStore.addNode(copy)
    }
    for (const edge of edges) documentStore.addEdge({ ...edge, id: uid(), fromNode: idMap.get(edge.fromNode)!, toNode: idMap.get(edge.toNode)! })
    updateMembership(nodes.filter((node) => !members.has(node.id)).map((node) => idMap.get(node.id)!))
  })
  return new Set(selection.map((id) => idMap.get(id)!))
}
