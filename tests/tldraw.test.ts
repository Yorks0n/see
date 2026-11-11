import { test } from 'node:test'
import assert from 'node:assert/strict'
import { importCanvasFile } from '../src/persistence'
import { importTldraw } from '../src/tools/tldraw'
import { DocumentStore } from '../src/store/document'

const shape = (id: string, type: string, props = {}, extra = {}) => ({
  id, typeName: 'shape', type, x: 10, y: 20, rotation: 0, parentId: 'page:one', index: 'a1', props, ...extra,
})
const page = { id: 'page:one', typeName: 'page', name: '第一页', index: 'a1' }
const file = (records: unknown[]) => ({ tldrawFileFormatVersion: 1, schema: { schemaVersion: 2, sequences: {} }, records: [page, ...records] })

test('opens .tldr files and store snapshots, preserving the source through see reload', async () => {
  const source = file([
    { id: 'document:document', typeName: 'document', name: '导入示例' },
    shape('text', 'text', { richText: { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: '你好', marks: [{ type: 'bold' }] }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '第二行' }] }] }] },
    ] }, w: 300 }),
    shape('note', 'note', { text: '便签', color: 'yellow', growY: 20, scale: 2 }),
    shape('link', 'bookmark', { url: 'https://example.com' }),
  ])
  const imported = await importCanvasFile(new File([JSON.stringify(source)], 'board.tldr'))
  assert.equal(imported.meta?.name, '导入示例')
  assert.equal(imported.nodes?.[0].type, 'text')
  assert.equal((imported.nodes?.[0] as any).text, '你好\n- 第二行')
  assert.equal(imported.nodes?.[1].height, 440)
  assert.equal(imported.nodes?.[2].type, 'link')
  const store = new DocumentStore()
  store.load(imported)
  const exported = store.toJSON()
  assert.deepEqual(exported.meta?.tldraw?.source, source)
  for (const snapshot of [{ store: Object.fromEntries(source.records.map((r: any) => [r.id, r])), schema: source.schema },
    { document: { store: Object.fromEntries(source.records.map((r: any) => [r.id, r])), schema: source.schema } }]) {
    assert.deepEqual(importTldraw(snapshot)?.nodes, imported.nodes)
  }
})

test('composes nested rotations and group coordinates without losing children or stacking order', () => {
  const doc = importTldraw(file([
    shape('child', 'draw', { segments: [{ points: [{ x: 0, y: 0 }, { x: 20, y: 0 }] }] }, { x: 5, y: 0, parentId: 'inner' }),
    shape('outer', 'group', {}, { x: 100, y: 200, rotation: Math.PI / 2 }),
    shape('inner', 'group', {}, { x: 10, y: 0, parentId: 'outer' }),
  ]))!
  const child = doc.nodes!.find((n) => n.id === 'child')!
  assert.ok(Math.abs(child.x - 100) < 1e-8)
  assert.equal(child.y, 215)
  assert.equal(child.height, 20)
  assert.deepEqual(doc.nodes!.map((n) => n.id), ['outer', 'inner', 'child'])
  assert.deepEqual((doc.nodes![0] as any).memberIds, ['inner'])
  assert.deepEqual((doc.nodes![1] as any).memberIds, ['child'])
})

test('retains embedded image dimensions and crop and warns about missing assets', () => {
  const doc = importTldraw(file([
    { id: 'asset:photo', typeName: 'asset', type: 'image', props: { src: 'data:image/png;base64,aGk=', w: 800, h: 600 } },
    shape('photo', 'image', { assetId: 'asset:photo', w: 200, h: 150, crop: { topLeft: { x: 0.25, y: 0.1 }, bottomRight: { x: 0.75, y: 0.9 } }, altText: '图片说明' }),
    shape('missing', 'image', { assetId: 'missing' }),
  ]))!
  assert.deepEqual((doc.nodes![0] as any).crop, { x: 0.25, y: 0.1, width: 0.5, height: 0.8 })
  assert.equal((doc.nodes![0] as any).naturalWidth, 800)
  assert.equal((doc.nodes![0] as any).text, '图片说明')
  assert.match((doc.nodes![1] as any).text, /缺失图片/)
  assert.ok(doc.meta!.tldraw!.warnings.some((w) => w.includes('缺少资源')))
})

test('imports current and legacy arrow bindings and keeps unbound arrows visible', () => {
  const doc = importTldraw(file([
    shape('a', 'geo', { geo: 'rectangle', w: 100, h: 100 }),
    shape('b', 'geo', { geo: 'rectangle', w: 100, h: 100 }, { x: 400 }),
    shape('arrow', 'arrow', { start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, text: '连接', bend: 30, arrowheadStart: 'none', arrowheadEnd: 'triangle' }),
    { id: 'binding:start', typeName: 'binding', type: 'arrow', fromId: 'arrow', toId: 'a', props: { terminal: 'start', normalizedAnchor: { x: 1, y: 0.5 } } },
    { id: 'binding:end', typeName: 'binding', type: 'arrow', fromId: 'arrow', toId: 'b', props: { terminal: 'end', normalizedAnchor: { x: 0, y: 0.5 } } },
    shape('legacy', 'arrow', { start: { type: 'binding', boundShapeId: 'a' }, end: { type: 'binding', boundShapeId: 'b' }, arrowheadEnd: 'none' }),
    shape('free', 'arrow', { start: { x: 0, y: 0 }, end: { x: 100, y: 40 }, text: '自由箭头' }),
  ]))!
  assert.deepEqual(doc.edges![0], { id: 'arrow', fromNode: 'a', toNode: 'b', fromSide: 'right', toSide: 'left', fromEnd: 'none', toEnd: 'arrow', color: '#1d1d1d', label: '连接', lineStyle: 'curve' })
  assert.equal(doc.edges![1].toEnd, 'none')
  assert.equal(doc.nodes!.find((n) => n.id === 'free')?.type, 'draw')
  assert.ok(doc.nodes!.some((n) => n.type === 'text' && n.text === '自由箭头'))
  const store = new DocumentStore()
  store.load(doc)
  assert.equal(store.toJSON().edges!.length, 2)
})

test('decodes both dimensions of compressed paths, legacy Float16 points, and lazy scaling', () => {
  const encoded = (dim: number) => {
    const bytes = new Uint8Array(dim * 6), view = new DataView(bytes.buffer)
    view.setFloat32(0, 10, true); view.setFloat32(4, -20, true)
    if (dim === 3) view.setFloat32(8, 0.5, true)
    view.setUint16(dim * 4, 0x4000, true) // +2
    view.setUint16(dim * 4 + 2, 0xc200, true) // -3
    return btoa(String.fromCharCode(...bytes))
  }
  for (const dim of [2, 3]) {
    const doc = importTldraw(file([shape('draw', 'draw', { segments: [{ path: encoded(dim), dim }], scaleX: 2, scaleY: 3 })]))!
    assert.deepEqual((doc.nodes![0] as any).points, [{ x: 0, y: 9 }, { x: 4, y: 0 }])
    assert.equal(doc.nodes![0].x, 30)
    assert.equal(doc.nodes![0].y, -49)
  }
  const bytes = new Uint8Array([0, 0x3c, 0, 0x40, 0, 0x38, 0, 0x42, 0, 0x44, 0, 0x38])
  const legacy = importTldraw(file([shape('old', 'draw', { segments: [{ points: btoa(String.fromCharCode(...bytes)) }] })]))!
  assert.deepEqual((legacy.nodes![0] as any).points, [{ x: 0, y: 0 }, { x: 2, y: 2 }])
})

test('places every page separately, preserves unknown shapes and escapes SVG text', () => {
  const doc = importTldraw(file([
    { id: 'page:two', typeName: 'page', name: '第二页', index: 'a2' },
    shape('one', 'geo', { geo: 'ellipse', text: '<script>&"', w: 100, h: 100, fill: 'solid' }),
    shape('two', 'custom-widget', { text: '自定义内容' }, { parentId: 'page:two' }),
  ]))!
  const one = doc.nodes!.find((n) => n.id === 'one')!, two = doc.nodes!.find((n) => n.id === 'two')!
  assert.ok(two.x > one.x + one.width)
  assert.equal(doc.nodes!.filter((n) => n.type === 'group').length, 2)
  const svg = decodeURIComponent((one as any).url.split(',')[1])
  assert.match(svg, /<ellipse/)
  assert.match(svg, /&lt;script&gt;&amp;&quot;/)
  assert.ok(doc.meta!.tldraw!.warnings.some((w) => w.includes('custom-widget')))
  assert.equal((two as any).text, '自定义内容')
})

test('rejects broken records, duplicate IDs, parent cycles and unsupported file versions', async () => {
  for (const source of [
    { tldrawFileFormatVersion: 2, records: [] }, { tldrawFileFormatVersion: 1 },
    file([null]), file([shape('same', 'text'), shape('same', 'text')]),
    file([shape('bad', 'text', {}, { x: 'oops' })]),
    file([shape('a', 'group', {}, { parentId: 'b' }), shape('b', 'group', {}, { parentId: 'a' })]),
    file([shape('bad', 'draw', { segments: [{ path: 'bad' }] })]),
    { document: { version: 15, pages: {} } },
  ]) await assert.rejects(importCanvasFile(new File([JSON.stringify(source)], 'bad.tldr')))
  assert.equal(importTldraw({ nodes: [], edges: [] }), null)
  assert.deepEqual(importTldraw(file([]))!.nodes, [])
})
