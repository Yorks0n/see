import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyCanvasChanges, assetRefs, canvasChanges, cloudCanvas, equal, mergeCanvas, validAssetMime, validateCanvas } from '../src/sync/protocol'
import type { CanvasFile } from '../src/types'

const doc = (): CanvasFile => ({
  nodes: [
    { id: 'a', type: 'text', text: 'hello', x: 10, y: 10, width: 100, height: 50 },
    { id: 'b', type: 'text', text: 'world', x: 200, y: 10, width: 100, height: 50 },
  ], edges: [], meta: { name: 'board' },
})
test('different devices editing separate cards or fields merge without losing either change', () => {
  const base = doc(), left = doc(), right = doc()
  left.nodes![0].x = 50
  right.nodes![0].color = '3'
  right.nodes![1].y = 80
  const merged = mergeCanvas(base, left, right)
  assert.equal(merged.conflict, false)
  assert.equal(merged.doc!.nodes![0].x, 50)
  assert.equal(merged.doc!.nodes![0].color, '3')
  assert.equal(merged.doc!.nodes![1].y, 80)
})
test('competing position or text changes are conflicts instead of silent last-write wins', () => {
  const base = doc(), left = doc(), right = doc()
  left.nodes![0].x = 50
  right.nodes![0].y = 80
  assert.equal(mergeCanvas(base, left, right).conflict, true)
  left.nodes![0] = { ...base.nodes![0], type: 'text', text: 'left' }
  right.nodes![0] = { ...base.nodes![0], type: 'text', text: 'right' }
  assert.equal(mergeCanvas(base, left, right).conflict, true)
})
test('whole-board and node deletion versus editing preserve a conflict', () => {
  const base = doc(), edited = doc()
  edited.nodes![0].color = '3'
  assert.equal(mergeCanvas(base, edited, null).conflict, true)
  assert.equal(mergeCanvas(base, null, edited).conflict, true)
  assert.equal(mergeCanvas(base, base, null).doc, null)
  const deleted = doc(); deleted.nodes!.shift()
  assert.equal(mergeCanvas(base, edited, deleted).conflict, true)
})
test('concurrent additions both survive and result order is deterministic', () => {
  const base = doc(), left = doc(), right = doc()
  left.nodes!.push({ ...left.nodes![0], id: 'left' })
  right.nodes!.push({ ...right.nodes![0], id: 'right' })
  assert.deepEqual(mergeCanvas(base, left, right), mergeCanvas(base, right, left))
  assert.equal(mergeCanvas(base, left, right).doc!.nodes!.length, 4)
})
test('reconnect compares semantic JSON rather than property insertion order', () => {
  assert.equal(equal({ a: 1, b: 2 }, { b: 2, a: 1 }), true)
  assert.equal(equal({ a: undefined }, {}), true)
  assert.equal(equal([1, 2], [2, 1]), false)
})
test('camera state remains local rather than moving another device viewport', () => {
  const value = doc(); value.meta!.camera = { x: 10, y: 10, zoom: 2 }
  assert.equal(cloudCanvas(value)!.meta!.camera, undefined)
  assert.equal(value.meta!.camera!.zoom, 2)
})
test('dangling connections and concurrent membership changes are not silently accepted', () => {
  const base = doc(), left = doc(), right = doc()
  left.nodes!.pop()
  right.edges!.push({ id: 'edge', fromNode: 'a', toNode: 'b' })
  assert.equal(mergeCanvas(base, left, right).conflict, true)
})
test('cloud documents validate IDs, geometry and attachment references before saving', () => {
  assert.equal(validateCanvas(doc()), true)
  assert.equal(validateCanvas(null), true)
  assert.equal(validateCanvas({ nodes: [{ id: 'bad' }], edges: [] }), false)
  const value = doc()
  value.nodes!.push({ ...value.nodes![0] })
  assert.equal(validateCanvas(value), false)
  const media: CanvasFile = { nodes: [{ id: 'image', type: 'image', x: 0, y: 0, width: 50, height: 50, url: `see-asset:${'a'.repeat(64)}` }], edges: [] }
  assert.equal(validateCanvas(media), true)
  assert.deepEqual(assetRefs(media), ['a'.repeat(64)])
  ;(media.nodes![0] as any).url = 'data:image/png;base64,AA'
  assert.equal(validateCanvas(media), false)
})

test('incremental changes retain unchanged images and drawings and round-trip edits, deletion, additions and order', () => {
  const base = doc()
  base.nodes!.push({ id: 'image', type: 'image', x: 0, y: 0, width: 100, height: 100, url: `see-asset:${'a'.repeat(64)}` })
  base.nodes!.push({ id: 'draw', type: 'draw', x: 0, y: 0, width: 100, height: 100, points: Array.from({ length: 1000 }, (_, x) => ({ x, y: x })) })
  base.edges!.push({ id: 'edge', fromNode: 'a', toNode: 'b' })
  const next = structuredClone(base)
  next.nodes![0].x += 20
  const move = canvasChanges(base, next)
  assert.deepEqual(move.nodes.upsert.map((n) => n.id), ['a'])
  assert.equal(move.nodes.order, undefined)
  assert.equal(JSON.stringify(move).includes('see-asset:'), false)
  assert.ok(JSON.stringify(move).length < JSON.stringify(next).length / 20)
  assert.deepEqual(applyCanvasChanges(base, move), next)
  next.nodes!.splice(1, 1)
  next.nodes!.push({ id: 'new', type: 'text', text: 'added', x: 0, y: 0, width: 100, height: 50 })
  next.nodes!.reverse()
  next.edges = [{ id: 'new-edge', fromNode: 'a', toNode: 'new' }]
  next.meta = {}
  assert.deepEqual(applyCanvasChanges(base, canvasChanges(base, next)), next)
  assert.deepEqual(applyCanvasChanges(next, canvasChanges(next, next)), next)
})

test('invalid incremental changes cannot silently remove records or create dangling connections', () => {
  const base = doc(), changes = canvasChanges(base, base)
  assert.throws(() => applyCanvasChanges(base, { ...changes, nodes: { ...changes.nodes, order: ['a', 'a'] } }))
  assert.throws(() => applyCanvasChanges(base, { ...changes, nodes: { ...changes.nodes, order: ['a'] } }))
  assert.throws(() => applyCanvasChanges(base, { ...changes, nodes: { upsert: [], remove: ['a', 'a'] } }))
  assert.throws(() => applyCanvasChanges(base, { ...changes, edges: { upsert: [{ id: 'bad', fromNode: 'a', toNode: 'missing' }], remove: [] } }))
  assert.throws(() => applyCanvasChanges(base, null))
})

test('SVG and other parameterized MIME types remain valid without changing their attachment hashes', () => {
  for (const mime of ['image/png', 'image/svg+xml;charset=utf-8', 'text/plain; charset="utf-8"']) assert.equal(validAssetMime(mime), true)
  for (const mime of ['', 'image', 'image/png\r\nX-Header: injected', 'image/png;broken', 'a'.repeat(257), null]) assert.equal(validAssetMime(mime), false)
})
