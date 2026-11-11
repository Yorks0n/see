import type { CanvasFile, CanvasNode } from '../types'

export interface CloudBoard { id: string; revision: number; doc: CanvasFile | null }
export interface SyncBase { revision: number; doc: CanvasFile | null }
export const ASSET_PREFIX = 'see-asset:'
export const PART_SIZE = 8 * 1024 * 1024

export function cloudCanvas(doc: CanvasFile | null): CanvasFile | null {
  if (!doc) return null
  const { camera: _camera, ...meta } = doc.meta ?? {}
  return { ...doc, nodes: doc.nodes ?? [], edges: doc.edges ?? [], meta }
}

export function assetRefs(doc: CanvasFile | null): string[] {
  const refs = new Set<string>()
  for (const node of doc?.nodes ?? []) {
    const url = node.type === 'image' ? node.url : node.type === 'group' ? node.background : node.type === 'file' ? node.file : null
    if (url?.startsWith(ASSET_PREFIX)) refs.add(url.slice(ASSET_PREFIX.length))
  }
  return [...refs]
}

export function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => equal(item, b[index]))
  }
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>
  const keys = Object.keys(left).filter((key) => left[key] !== undefined)
  return keys.length === Object.keys(right).filter((key) => right[key] !== undefined).length && keys.every((key) => equal(left[key], right[key]))
}

class MergeConflict extends Error {}
function field(base: unknown, local: unknown, remote: unknown): unknown {
  if (equal(local, remote) || equal(remote, base)) return local
  if (equal(local, base)) return remote
  throw new MergeConflict()
}
function object(base: Record<string, unknown>, local: Record<string, unknown>, remote: Record<string, unknown>, node = false) {
  const result: Record<string, unknown> = {}
  const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])
  // A move is atomic: don't combine x from one device with y from the other.
  if (node) {
    Object.assign(result, field({ x: base.x, y: base.y }, { x: local.x, y: local.y }, { x: remote.x, y: remote.y }))
    keys.delete('x'); keys.delete('y')
  }
  for (const key of keys) {
    const value = field(base[key], local[key], remote[key])
    if (value !== undefined) result[key] = value
  }
  return result
}
function records<T extends { id: string }>(base: T[], local: T[], remote: T[], node = false): T[] {
  const old = new Map(base.map((item) => [item.id, item])), left = new Map(local.map((item) => [item.id, item])), right = new Map(remote.map((item) => [item.id, item]))
  const ids = new Set([...left.keys(), ...right.keys()])
  const merged = new Map<string, T>()
  for (const id of ids) {
    const b = old.get(id), l = left.get(id), r = right.get(id)
    const value = b && l && r
      ? object(b as Record<string, unknown>, l as Record<string, unknown>, r as Record<string, unknown>, node) as T
      : field(b, l, r) as T | undefined
    if (value) merged.set(id, value)
  }
  const surviving = new Set([...old.keys()].filter((id) => merged.has(id)))
  const order = (items: T[]) => items.map((item) => item.id).filter((id) => surviving.has(id))
  const ordered = field(order(base), order(local), order(remote)) as string[]
  // Concurrent additions are retained in deterministic order after existing records.
  const additions = [...merged.keys()].filter((id) => !old.has(id)).sort()
  return [...ordered, ...additions].map((id) => merged.get(id)!)
}

export function mergeCanvas(base: CanvasFile | null, local: CanvasFile | null, remote: CanvasFile | null): { doc: CanvasFile | null; conflict: boolean } {
  try {
    if (equal(local, remote) || equal(remote, base)) return { doc: local, conflict: false }
    if (equal(local, base)) return { doc: remote, conflict: false }
    if (!base || !local || !remote) throw new MergeConflict()
    const nodes = records(base.nodes ?? [], local.nodes ?? [], remote.nodes ?? [], true)
    const edges = records(base.edges ?? [], local.edges ?? [], remote.edges ?? [])
    const ids = new Set(nodes.map((node) => node.id))
    if (edges.some((edge) => !ids.has(edge.fromNode) || !ids.has(edge.toNode))) throw new MergeConflict()
    const memberships = new Map<string, string>()
    for (const node of nodes) if (node.type === 'group') {
      for (const id of node.memberIds ?? []) {
        if (!ids.has(id) || memberships.has(id)) throw new MergeConflict()
        memberships.set(id, node.id)
      }
    }
    const meta = object({ ...base.meta }, { ...local.meta }, { ...remote.meta })
    return { doc: { ...remote, nodes, edges, meta }, conflict: false }
  } catch (error) {
    if (!(error instanceof MergeConflict)) throw error
    return { doc: remote, conflict: true }
  }
}

export function validateCanvas(doc: unknown): doc is CanvasFile | null {
  if (doc === null) return true
  if (!doc || typeof doc !== 'object') return false
  const value = doc as CanvasFile
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) return false
  const ids = new Set<string>()
  const types = new Set(['text', 'file', 'link', 'image', 'group', 'draw', 'rectangle'])
  for (const node of value.nodes as CanvasNode[]) {
    if (!node || typeof node.id !== 'string' || node.id.length > 256 || ids.has(node.id) || !types.has(node.type)) return false
    if (![node.x, node.y, node.width, node.height].every(Number.isFinite)) return false
    ids.add(node.id)
    const url = node.type === 'image' ? node.url : node.type === 'group' ? node.background : node.type === 'file' ? node.file : ''
    if (url !== undefined && (typeof url !== 'string' || /^(data:|blob:)/.test(url))) return false
  }
  const edges = new Set<string>()
  for (const edge of value.edges) {
    if (!edge || typeof edge.id !== 'string' || edges.has(edge.id) || !ids.has(edge.fromNode) || !ids.has(edge.toNode)) return false
    edges.add(edge.id)
  }
  return assetRefs(value).every((ref) => /^[a-f0-9]{64}$/.test(ref))
}
