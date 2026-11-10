import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DocumentStore, documentStore, restoreCanvas } from '../src/store/document'
import { CameraStore, cameraStore } from '../src/store/camera'
import { DEFAULT_CONNECTION_COLOR, PreferencesStore, preferencesStore, THEME_STORAGE_KEY, COLORS_STORAGE_KEY } from '../src/store/preferences'
import { cameraAtCenter, minimapBounds, minimapCamera, viewportRect, zoomAtCenter } from '../src/render/minimap'
import { edgeGeometry, hitTest, PRESET_COLORS, strokePath } from '../src/render/renderer'
import { createImageCard, createTextCard, duplicateNodes, expandSelection, finishConnection, moveConnection, splitImageCaption, startConnection, tools, ToolState, type ToolEnv, type PointerInfo } from '../src/tools/tools'
import { importCanvasFile, loadLocal, saveLocal, saveRecovery } from '../src/persistence'
import { cropImage, uncroppedBounds, type CropHandle } from '../src/tools/imageCrop'
import { CLIPBOARD_MIME, copySelection, pasteSelection, readClipboard, writeClipboard } from '../src/tools/clipboard'
import type { CanvasNode, GroupNode, ImageNode, TextNode } from '../src/types'
import { EditorState, TextSelection } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { liftListItem, splitListItem } from 'prosemirror-schema-list'
import { undoInputRule } from 'prosemirror-inputrules'
import { undo, redo } from 'prosemirror-history'
import { textDocument, textMarkdown, textPlugins, textSchema } from '../src/tools/textEditor'

const card = (id: string, x = 20, y = 20): TextNode => ({ id, type: 'text', x, y, width: 100, height: 60, text: id })
const frame = (ids = ['a', 'b']): GroupNode => ({ id: 'group', type: 'group', x: 0, y: 0, width: 350, height: 250, label: 'Ideas', memberIds: ids })
const pointer = (x: number, y: number, nodeId?: string): PointerInfo => ({ world: { x, y }, screen: { x, y }, shiftKey: false, nodeId })
function environment(selection = new Set<string>()): ToolEnv {
  const env: ToolEnv = { selection, setSelection: (next) => { env.selection = next }, setDragPreview: () => {}, setMarquee: () => {}, setPaintTrail: () => {}, setEditingId: () => {}, setTool: () => {}, drawStyle: { color: '5', strokeWidth: 4 } }
  return env
}

test('text blocks render three heading levels and preserve ordinary text and blank lines', () => {
  const doc = textDocument('# 大标题\r\n## 二级标题\n### 三级标题\n正文\n\n#没有空格\n#### 四级原文')
  assert.deepEqual([0, 1, 2].map((i) => [doc.child(i).type.name, doc.child(i).attrs.level]), [['heading', 1], ['heading', 2], ['heading', 3]])
  assert.equal(doc.child(3).textContent, '正文')
  assert.equal(doc.child(4).textContent, '')
  assert.equal(doc.child(5).textContent, '#没有空格')
  assert.equal(doc.child(6).textContent, '#### 四级原文')
})

test('consecutive dash items render as lists and stop at headings or ordinary text', () => {
  const doc = textDocument('- 第一项\n- 第二项\n正文\n- 第三项\n## 标题\n-最后保留原文')
  assert.equal(doc.child(0).type.name, 'bullet_list')
  assert.equal(doc.child(0).childCount, 2)
  assert.equal(doc.child(1).textContent, '正文')
  assert.equal(doc.child(2).type.name, 'bullet_list')
  assert.equal(doc.child(2).childCount, 1)
  assert.equal(doc.child(3).type.name, 'heading')
  assert.equal(doc.child(4).textContent, '-最后保留原文')
})

test('Markdown and bare links render safely inside headings, lists and ordinary text', () => {
  const doc = textDocument('# [标题链接](https://example.com/title)\n- 访问 https://example.com/docs。\n[带括号](https://example.com/a_(b)) 与 https://example.com/wiki/Foo_(bar).\n[邮件](mailto:hello@example.com)')
  const links: string[] = []
  doc.descendants((node) => { if (node.marks.length) links.push(node.marks[0].attrs.href) })
  assert.deepEqual(links, ['https://example.com/title', 'https://example.com/docs', 'https://example.com/a_(b)', 'https://example.com/wiki/Foo_(bar)', 'mailto:hello@example.com'])
  assert.equal(doc.child(0).textContent, '标题链接')
  assert.equal(doc.child(1).textContent, '访问 https://example.com/docs。')
})

test('text Markdown leaves HTML and executable link schemes as plain text', () => {
  const source = '<img src=x onerror=alert(1)>\n[unsafe](javascript:alert(1))\n[data](data:text/html,test)'
  const doc = textDocument(source)
  doc.descendants((node) => { assert.equal(node.marks.length, 0) })
  assert.equal(textMarkdown(doc), source)
})

function textInput(text = '') {
  const doc = textDocument(text)
  const view = {
    state: EditorState.create({ doc, selection: TextSelection.atEnd(doc), plugins: textPlugins() }),
    composing: false,
    dispatch(tr: import('prosemirror-state').Transaction) { view.state = view.state.applyTransaction(tr).state },
  }
  return {
    view,
    type(text: string) {
      for (const char of text) {
        const { from, to } = view.state.selection
        const handled = view.state.plugins.some((plugin) => plugin.props.handleTextInput?.call(plugin, view as unknown as EditorView, from, to, char, () => view.state.tr.insertText(char)))
        if (!handled) view.dispatch(view.state.tr.insertText(char))
      }
    },
  }
}

test('rich text preserves Markdown headings, lists, blank lines and link targets on round trip', () => {
  const source = '# 标题\n## 二级\n### 三级\n正文\n\n- 列表\n- [链接](https://example.com/a_(b))\nhttps://example.org。'
  assert.equal(textMarkdown(textDocument(source)), source)
  assert.equal(textMarkdown(textDocument('# \n- ')), '# \n- ')
})

test('typing Markdown prefixes converts headings immediately without moving the text cursor', () => {
  for (const level of [1, 2, 3]) {
    const input = textInput()
    input.type('#'.repeat(level) + ' ')
    assert.equal(input.view.state.doc.firstChild!.type.name, 'heading')
    assert.equal(input.view.state.doc.firstChild!.attrs.level, level)
    assert.equal(input.view.state.selection.$from.parentOffset, 0)
    input.type('实时标题')
    assert.equal(input.view.state.selection.$from.parentOffset, 4)
    assert.equal(textMarkdown(input.view.state.doc), '#'.repeat(level) + ' 实时标题')
  }
})

test('list input converts immediately, Enter continues items, and an empty item exits the list', () => {
  const input = textInput()
  input.type('- ')
  assert.equal(input.view.state.doc.firstChild!.type.name, 'bullet_list')
  input.type('第一项')
  assert.ok(splitListItem(textSchema.nodes.list_item)(input.view.state, input.view.dispatch))
  input.type('第二项')
  assert.equal(textMarkdown(input.view.state.doc), '- 第一项\n- 第二项')
  assert.ok(splitListItem(textSchema.nodes.list_item)(input.view.state, input.view.dispatch))
  assert.equal(splitListItem(textSchema.nodes.list_item)(input.view.state, input.view.dispatch), false)
  assert.ok(liftListItem(textSchema.nodes.list_item)(input.view.state, input.view.dispatch))
  assert.equal(input.view.state.selection.$from.parent.type.name, 'paragraph')
  input.type('列表外正文')
  assert.equal(textMarkdown(input.view.state.doc), '- 第一项\n- 第二项\n列表外正文')
})

test('Backspace can undo prefix conversion and editor history restores formatted content', () => {
  const input = textInput()
  input.type('## ')
  assert.ok(undoInputRule(input.view.state, input.view.dispatch))
  assert.equal(input.view.state.doc.firstChild!.type.name, 'paragraph')
  assert.equal(input.view.state.doc.textContent, '## ')
  const other = textInput('# 原标题')
  other.type('增加')
  assert.ok(undo(other.view.state, other.view.dispatch))
  assert.equal(textMarkdown(other.view.state.doc), '# 原标题')
  assert.ok(redo(other.view.state, other.view.dispatch))
  assert.equal(textMarkdown(other.view.state.doc), '# 原标题增加')
})

test('Backspace at the start of an existing heading restores ordinary text', () => {
  const input = textInput('## 标题')
  input.view.dispatch(input.view.state.tr.setSelection(TextSelection.create(input.view.state.doc, 1)))
  const event = { key: 'Backspace', keyCode: 8, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false } as KeyboardEvent
  const handled = input.view.state.plugins.some((plugin) => plugin.props.handleKeyDown?.call(plugin, input.view as unknown as EditorView, event))
  assert.equal(handled, true)
  assert.equal(input.view.state.doc.firstChild!.type.name, 'paragraph')
  assert.equal(textMarkdown(input.view.state.doc), '标题')
})

test('text selections preserve Markdown when copying partial lists and linked labels', () => {
  const doc = textDocument('- 第一项\n- [文档](https://example.com)')
  const positions: number[] = []
  doc.descendants((node, pos) => { if (node.isText) positions.push(pos) })
  const slice = doc.slice(positions[0] + 1, positions[1] + 2, true)
  assert.equal(textMarkdown(textSchema.nodes.doc.create(null, slice.content)), '- 一项\n- [文档](https://example.com)')
  const label = doc.child(0).child(1).child(0).content
  assert.equal(textMarkdown(textSchema.nodes.doc.create(null, label)), '[文档](https://example.com)')
})

test('live links update their targets as text is typed and explicit links retain their label', () => {
  const input = textInput()
  input.type('https://example.com/path')
  assert.equal(input.view.state.doc.firstChild!.firstChild!.marks[0].attrs.href, 'https://example.com/path')
  assert.equal(textMarkdown(input.view.state.doc), 'https://example.com/path')
  const labeled = textInput()
  labeled.type('[文档](https://example.com/docs)')
  assert.equal(labeled.view.state.doc.textContent, '文档')
  assert.equal(labeled.view.state.doc.firstChild!.firstChild!.marks[0].attrs.href, 'https://example.com/docs')
  assert.equal(textMarkdown(labeled.view.state.doc), '[文档](https://example.com/docs)')
})

test('composition input is not replaced by Markdown prefix rules mid-composition', () => {
  const input = textInput()
  input.view.composing = true
  input.type('# 中文')
  assert.equal(input.view.state.doc.firstChild!.type.name, 'paragraph')
  assert.equal(input.view.state.doc.textContent, '# 中文')
})

test('restoration preserves crop, natural dimensions, group membership and stroke style', () => {
  const doc = restoreCanvas({ nodes: [
    { ...card('photo'), type: 'image', url: 'data:image/png;base64,abc', naturalWidth: 600, naturalHeight: 400, crop: { x: 0.2, y: 0.1, width: 0.5, height: 0.7 } },
    { ...frame(['photo']), background: 'pattern', backgroundStyle: 'repeat' },
    { ...card('stroke'), type: 'draw', color: '5', strokeWidth: 8, points: [{ x: 0, y: 0 }, { x: 10, y: 20 }] },
  ], edges: [{ id: 'edge', fromNode: 'photo', toNode: 'stroke', toEnd: 'none', label: 'related' }] })
  assert.equal(doc.nodes![0].type, 'image')
  assert.deepEqual((doc.nodes![0] as any).crop, { x: 0.2, y: 0.1, width: 0.5, height: 0.7 })
  assert.equal((doc.nodes![0] as any).naturalWidth, 600)
  assert.deepEqual((doc.nodes![1] as any).memberIds, ['photo'])
  assert.equal((doc.nodes![1] as any).backgroundStyle, 'repeat')
  assert.equal((doc.nodes![2] as any).strokeWidth, 8)
  assert.equal(doc.edges![0].toEnd, 'none')
  assert.deepEqual(restoreCanvas(JSON.parse(JSON.stringify(doc))), doc)
})

test('invalid imported geometry is sanitized and dangling edges are removed', () => {
  const doc = restoreCanvas({ nodes: [card('a'), { ...card('bad'), x: NaN }, { ...card('photo'), type: 'image', url: '', width: -4, crop: { x: 0.9, y: 0, width: 0.9, height: 1 } }], edges: [{ id: 'bad', fromNode: 'a', toNode: 'missing' }] })
  assert.equal(doc.nodes!.length, 2)
  assert.equal(doc.nodes![1].width, 1)
  assert.equal((doc.nodes![1] as any).crop, undefined)
  assert.equal(doc.edges!.length, 0)
})

test('connection styles survive restoration and straight paths keep endpoint anchors', () => {
  const doc = restoreCanvas({ nodes: [card('a'), card('b', 300, 180)], edges: [
    { id: 'straight', fromNode: 'a', toNode: 'b', fromSide: 'right', toSide: 'left', lineStyle: 'straight', label: '隐藏标签', labelIsVisible: false },
    { id: 'legacy', fromNode: 'a', toNode: 'b', lineStyle: 'invalid', labelIsVisible: 'invalid' },
  ] })
  assert.equal(doc.edges![0].lineStyle, 'straight')
  assert.equal(doc.edges![0].labelIsVisible, false)
  assert.equal(doc.edges![1].lineStyle, undefined)
  assert.equal(doc.edges![1].labelIsVisible, undefined)
  assert.deepEqual(restoreCanvas(JSON.parse(JSON.stringify(doc))), doc)
  const nodes = new Map(doc.nodes!.map((node) => [node.id, node]))
  const straight = edgeGeometry(doc.edges![0], nodes)!
  assert.equal(straight.path, 'M 120 50 L 300 210')
  assert.deepEqual(straight.center, { x: 210, y: 130 })
  assert.match(edgeGeometry(doc.edges![1], nodes)!.path, / C /)
  const store = new DocumentStore()
  store.load(doc)
  store.updateEdge('straight', { lineStyle: 'curve', labelIsVisible: true })
  store.undo()
  assert.equal(store.getEdge('straight')!.lineStyle, 'straight')
  assert.equal(store.getEdge('straight')!.labelIsVisible, false)
})

test('one drag gesture is one undo step, with redo and cancellation', () => {
  const store = new DocumentStore()
  store.load({ nodes: [card('a')] })
  store.beginInteraction()
  for (let x = 21; x <= 100; x++) store.updateNode('a', { x })
  store.endInteraction()
  assert.equal(store.getNode('a')!.x, 100)
  store.undo()
  assert.equal(store.getNode('a')!.x, 20)
  assert.equal(store.canUndo, false)
  store.redo()
  assert.equal(store.getNode('a')!.x, 100)
  store.beginInteraction(); store.updateNode('a', { x: 200 }); store.cancelInteraction()
  assert.equal(store.getNode('a')!.x, 100)
  store.undo()
  assert.equal(store.getNode('a')!.x, 20)
})

test('image decoding does not add an undo step or erase redo', () => {
  const store = new DocumentStore()
  store.addNode({ id: 'photo', type: 'image', url: '', x: 0, y: 0, width: 280, height: 180 })
  store.initializeImage('photo', 600, 400)
  assert.equal(store.getNode('photo')!.height, 280 * 400 / 600)
  store.undo()
  assert.equal(store.getNode('photo'), undefined)
  store.redo()
  assert.equal((store.getNode('photo') as any).naturalWidth, 600)
  store.updateNode('photo', { width: 560, height: 280 * 400 / 300 })
  store.undo(); store.redo()
  assert.equal(store.getNode('photo')!.width, 560)
})

test('deleting a member cleans up connected edges and group references', () => {
  const store = new DocumentStore()
  store.load({ nodes: [card('a'), card('b'), frame()], edges: [{ id: 'ab', fromNode: 'a', toNode: 'b' }] })
  store.deleteNode('a')
  assert.deepEqual((store.getNode('group') as GroupNode).memberIds, ['b'])
  assert.equal(store.getSnapshot().edges!.length, 0)
  store.undo()
  assert.equal(store.getSnapshot().edges!.length, 1)
  assert.deepEqual((store.getNode('group') as GroupNode).memberIds, ['a', 'b'])
})

test('duplicating nested groups remaps members and internal connections', () => {
  const inner = { ...frame(['a']), id: 'inner', width: 150, height: 120 }
  documentStore.load({ nodes: [card('a'), card('b', 200), inner, frame(['inner', 'b'])], edges: [{ id: 'ab', fromNode: 'a', toNode: 'b' }] })
  const selection = duplicateNodes(new Set(['group']))
  const copiedGroup = documentStore.getNode([...selection][0]) as GroupNode
  const descendants = expandSelection(selection)
  assert.equal(descendants.size, 4)
  assert.ok(!copiedGroup.memberIds!.includes('inner'))
  const newEdge = documentStore.getSnapshot().edges![1]
  assert.ok(descendants.has(newEdge.fromNode) && descendants.has(newEdge.toNode))
  documentStore.undo()
  assert.equal(documentStore.getSnapshot().nodes!.length, 4)
  assert.equal(documentStore.getSnapshot().edges!.length, 1)
})

function clipboardData() {
  const values = new Map<string, string>()
  return {
    getData: (type: string) => values.get(type) ?? '',
    setData: (type: string, value: string) => { values.set(type, value) },
    clearData: (type: string) => { values.delete(type) },
  } as DataTransfer
}

test('single card clipboard keeps multiline text, color and size, with readable external text', () => {
  const original = { ...card('a', -120, 90), text: '<想法 & "notes">\n第二行', color: '#abcdef' as const, width: 237, height: 123 }
  documentStore.load({ nodes: [original] })
  const data = clipboardData()
  writeClipboard(data, copySelection(new Set(['a']))!)
  assert.equal(data.getData('text/plain'), original.text)
  assert.match(data.getData('text/html'), /&lt;想法 &amp; &quot;notes&quot;&gt;/)
  const content = readClipboard(data)!
  documentStore.updateNode('a', { text: 'changed after copying', width: 300 })
  const selection = pasteSelection(content, { x: 800, y: -50 })
  const pasted = documentStore.getNode([...selection][0])!
  assert.notEqual(pasted.id, original.id)
  assert.deepEqual(pasted, { ...original, id: pasted.id, x: 800, y: -50 })
  documentStore.undo()
  assert.equal(documentStore.getSnapshot().nodes!.length, 1)
  assert.equal((documentStore.getNode('a') as TextNode).text, 'changed after copying')
  documentStore.redo()
  assert.deepEqual(documentStore.getNode(pasted.id), pasted)
})

test('multi-card clipboard survives a new document and remaps only internal styled connections', () => {
  documentStore.load({ nodes: [card('a', -50, 40), card('b', 250, 180), card('outside', 900)], edges: [
    { id: 'ab', fromNode: 'a', toNode: 'b', fromSide: 'bottom', toSide: 'left', fromEnd: 'none', toEnd: 'arrow', color: '#123456', label: 'next', labelIsVisible: false, labelOffset: { x: 12, y: -8 }, lineStyle: 'straight' },
    { id: 'external', fromNode: 'a', toNode: 'outside' },
  ] })
  const sourceEdge = documentStore.getSnapshot().edges![0]
  const data = clipboardData()
  writeClipboard(data, copySelection(new Set(['a', 'b']))!)
  // Browsers may only retain the standard HTML and text clipboard formats.
  data.clearData(CLIPBOARD_MIME)
  const content = readClipboard(data)!
  documentStore.load({ nodes: [] })
  const selection = pasteSelection(content, { x: 600, y: 500 })
  const [a, b] = documentStore.getSnapshot().nodes!
  assert.equal(selection.size, 2)
  assert.deepEqual([a.x, a.y, b.x, b.y], [600, 500, 900, 640])
  const [edge] = documentStore.getSnapshot().edges!
  assert.equal(documentStore.getSnapshot().edges!.length, 1)
  assert.notEqual(edge.id, sourceEdge.id)
  assert.deepEqual(edge, { ...sourceEdge, id: edge.id, fromNode: a.id, toNode: b.id })
  const repeated = pasteSelection(content, { x: 1000, y: 100 })
  assert.ok([...repeated].every((id) => !selection.has(id)))
  assert.equal(documentStore.getSnapshot().edges!.length, 2)
  documentStore.undo()
  assert.equal(documentStore.getSnapshot().nodes!.length, 2)
  assert.equal(documentStore.getSnapshot().edges!.length, 1)
  documentStore.undo()
  assert.equal(documentStore.getSnapshot().nodes!.length, 0)
  assert.equal(documentStore.getSnapshot().edges!.length, 0)
})

test('clipboard preserves all card formats, crop, drawing points and file subpaths', () => {
  documentStore.load({ nodes: [
    { ...card('text'), color: '4' },
    { ...card('image', 200), type: 'image', url: 'data:image/png;base64,abc', text: 'caption', naturalWidth: 800, naturalHeight: 600, crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 } },
    { ...card('draw', 400), type: 'draw', color: '6', strokeWidth: 9, points: [{ x: 0, y: 0 }, { x: 100, y: 60 }] },
    { ...card('link', 600), type: 'link', url: 'https://example.com' },
    { ...card('file', 800), type: 'file', file: 'notes.md', subpath: '#idea' },
  ] })
  const originals = documentStore.toJSON().nodes!
  const data = clipboardData()
  writeClipboard(data, copySelection(new Set(originals.map((node) => node.id)))!)
  const selection = pasteSelection(readClipboard(data)!, { x: 1020, y: 220 })
  const copies = documentStore.getSnapshot().nodes!.filter((node) => selection.has(node.id))
  for (let i = 0; i < originals.length; i++) {
    assert.deepEqual(JSON.parse(JSON.stringify(copies[i])), { ...originals[i], id: copies[i].id, x: originals[i].x + 1000, y: originals[i].y + 200 })
  }
})

test('clipboard preserves explicit nested group structure and joins destination groups', () => {
  // Explicit members can extend beyond the group bounds.
  const inner = { ...frame(['a']), id: 'inner', width: 150, height: 120, background: 'pattern', backgroundStyle: 'repeat' as const }
  documentStore.load({ nodes: [card('a', 400, 400), card('b', 200), inner, frame(['inner', 'b'])], edges: [{ id: 'ab', fromNode: 'a', toNode: 'b' }] })
  const data = clipboardData()
  writeClipboard(data, copySelection(new Set(['group']))!)
  const content = readClipboard(data)!
  documentStore.load({ nodes: [{ ...frame([]), id: 'destination', x: 900, y: 900, width: 1000, height: 1000 }] })
  const selection = pasteSelection(content, { x: 1000, y: 1000 })
  assert.equal(selection.size, 1)
  const group = documentStore.getNode([...selection][0]) as GroupNode
  const descendants = expandSelection(selection)
  assert.equal(descendants.size, 4)
  assert.ok(group.memberIds!.every((id) => descendants.has(id)))
  const copiedInner = documentStore.getNode(group.memberIds![0]) as GroupNode
  assert.equal(copiedInner.background, 'pattern')
  assert.equal(copiedInner.backgroundStyle, 'repeat')
  assert.equal(copiedInner.memberIds!.length, 1)
  assert.ok(descendants.has(copiedInner.memberIds![0]))
  assert.deepEqual((documentStore.getNode('destination') as GroupNode).memberIds, [group.id])
  const edge = documentStore.getSnapshot().edges![0]
  assert.ok(descendants.has(edge.fromNode) && descendants.has(edge.toNode))
  documentStore.undo()
  assert.equal(documentStore.getSnapshot().nodes!.length, 1)
  assert.deepEqual((documentStore.getNode('destination') as GroupNode).memberIds, [])
})

test('clipboard includes members of legacy groups without explicit membership', () => {
  documentStore.load({ nodes: [card('a'), card('b', 200), { ...frame(), memberIds: undefined }] })
  const content = copySelection(new Set(['group']))!
  documentStore.load({ nodes: [] })
  const selection = pasteSelection(content, { x: 500, y: 500 })
  assert.equal(expandSelection(selection).size, 3)
})

test('clipboard ignores foreign, malformed and unsupported selection data', () => {
  assert.equal(copySelection(new Set(['missing'])), null)
  const data = clipboardData()
  for (const value of ['', 'hello', '{}', 'null', '{"type":"see/selection","version":2}', '{"type":"see/selection","version":1,"nodes":[],"selection":[]}']) {
    data.setData(CLIPBOARD_MIME, value)
    assert.equal(readClipboard(data), null)
  }
  data.clearData(CLIPBOARD_MIME)
  data.setData('text/html', '<div data-see-selection="%malformed">text</div>')
  assert.equal(readClipboard(data), null)
})

test('moving a group moves all descendants once and can be undone together', () => {
  documentStore.load({ nodes: [card('a'), card('b', 200), frame()] })
  const env = environment(new Set(['group'])), state = new ToolState()
  documentStore.beginInteraction()
  tools.select.onPointerDown!(pointer(5, 5, 'group'), env, state)
  tools.select.onPointerMove!(pointer(55, 35), env, state)
  tools.select.onPointerUp!(pointer(55, 35), env, state)
  documentStore.endInteraction()
  assert.equal(documentStore.getNode('a')!.x, 70)
  assert.equal(documentStore.getNode('b')!.x, 250)
  assert.equal(documentStore.getNode('group')!.y, 30)
  documentStore.undo()
  assert.equal(documentStore.getNode('a')!.x, 20)
  assert.equal(documentStore.getNode('group')!.y, 0)
})

test('cards created inside a frame join its members in the same undo step', () => {
  documentStore.load({ nodes: [frame([])] })
  const text = createTextCard({ x: 150, y: 100 })
  assert.deepEqual((documentStore.getNode('group') as GroupNode).memberIds, [text.id])
  documentStore.undo()
  assert.deepEqual((documentStore.getNode('group') as GroupNode).memberIds, [])
  assert.equal(documentStore.getNode(text.id), undefined)
  const image = createImageCard({ x: 150, y: 110 }, '')
  assert.ok((documentStore.getNode('group') as GroupNode).memberIds!.includes(image.id))
})

test('text layout measurement does not leave phantom undo steps after editing', () => {
  const store = new DocumentStore()
  store.load({ nodes: [card('a')] })
  store.updateNode('a', { text: 'A longer piece of text' })
  store.updateTextLayout('a', 180)
  store.undo()
  assert.equal((store.getNode('a') as TextNode).text, 'a')
  assert.equal(store.getNode('a')!.height, 60)
  assert.equal(store.canUndo, false)
  store.redo()
  assert.equal(store.getNode('a')!.height, 180)
})

test('shift selection toggles members and retains existing selection during marquee', () => {
  documentStore.load({ nodes: [card('a'), card('b', 200)] })
  const env = environment(new Set(['a'])), state = new ToolState()
  tools.select.onPointerDown!({ ...pointer(210, 30), shiftKey: true }, env, state)
  assert.deepEqual([...env.selection], ['a', 'b'])
  tools.select.onPointerUp!(pointer(210, 30), env, state)
  tools.select.onPointerDown!({ ...pointer(210, 30), shiftKey: true }, env, state)
  assert.deepEqual([...env.selection], ['a'])
})

test('Shift box selection includes images, preserves prior selection, and requires enclosure', () => {
  const photo: CanvasNode = { id: 'photo', type: 'image', url: '', x: 200, y: 100, width: 140, height: 90 }
  documentStore.load({ nodes: [card('a', 40, 100), photo, card('outside', 600, 100)] })
  const env = environment(new Set(['outside'])), state = new ToolState()
  const shifted = (x: number, y: number) => ({ ...pointer(x, y), shiftKey: true })
  tools.select.onPointerDown!(shifted(380, 230), env, state)
  tools.select.onPointerMove!(shifted(10, 80), env, state)
  assert.deepEqual([...env.selection].sort(), ['a', 'outside', 'photo'])
  tools.select.onPointerMove!(shifted(220, 80), env, state)
  assert.deepEqual([...env.selection], ['outside'])
  tools.select.onPointerUp!(shifted(10, 80), env, state)
  assert.deepEqual([...env.selection].sort(), ['a', 'outside', 'photo'])
  assert.equal(state.dragging, null)
  assert.equal(documentStore.canUndo, false)
  assert.equal(documentStore.getNode('photo')!.x, 200)
})

test('paint selection sweeps across image and text cards without selecting the whole bounding area', () => {
  documentStore.load({ nodes: [
    card('a', 100, 100),
    { id: 'photo', type: 'image', url: '', x: 300, y: 100, width: 140, height: 90 },
    card('untouched', 200, 280),
    { ...frame(['a', 'photo']), width: 500, height: 400 },
  ] })
  const env = environment(), state = new ToolState()
  tools.select.onPointerDown!(pointer(-20, 130), env, state)
  // One fast move must still select everything the pointer crossed.
  tools.select.onPointerMove!(pointer(500, 130), env, state)
  assert.deepEqual([...env.selection].sort(), ['a', 'photo'])
  tools.select.onPointerMove!(pointer(500, 400), env, state)
  assert.deepEqual([...env.selection].sort(), ['a', 'photo'])
  tools.select.onPointerUp!(pointer(500, 400), env, state)
  assert.deepEqual([...env.selection].sort(), ['a', 'photo'])
})

test('Shift can change selection modes at the current pointer position in either order', () => {
  documentStore.load({ nodes: [
    card('a', 100, 100),
    { id: 'photo', type: 'image', url: '', x: 300, y: 200, width: 140, height: 90 },
    card('prior', 700, 300),
  ] })
  let marquee: unknown = null, trail: unknown = null
  const env = environment(new Set(['prior'])), state = new ToolState()
  env.setMarquee = (value) => { marquee = value }
  env.setPaintTrail = (value) => { trail = value }
  tools.select.onPointerDown!(pointer(20, 20), env, state)
  tools.select.onPointerMove!(pointer(500, 20), env, state)
  tools.select.onPointerMove!(pointer(400, 250), env, state)
  tools.select.onPointerMove!(pointer(500, 320), env, state)
  assert.deepEqual([...env.selection], ['photo'])
  assert.equal(marquee, null)
  assert.ok(trail)
  const shifted = { ...pointer(500, 320), shiftKey: true }
  tools.select.onPointerMove!(shifted, env, state)
  assert.deepEqual([...env.selection].sort(), ['a', 'photo', 'prior'])
  assert.ok(marquee)
  assert.equal(trail, null)
  tools.select.onPointerMove!(pointer(500, 320), env, state)
  assert.deepEqual([...env.selection], ['photo'])
  assert.equal(marquee, null)
  assert.ok(trail)
  tools.select.onPointerUp!(shifted, env, state)
  assert.deepEqual([...env.selection].sort(), ['a', 'photo', 'prior'])
  assert.equal(marquee, null)
  assert.equal(trail, null)
  const before = environment(new Set(['prior'])), next = new ToolState()
  tools.select.onPointerDown!({ ...pointer(20, 20), shiftKey: true }, before, next)
  tools.select.onPointerUp!(shifted, before, next)
  assert.deepEqual([...before.selection].sort(), [...env.selection].sort())
})

test('paint selection follows actual drawing curves and uses a constant screen radius', () => {
  documentStore.load({ nodes: [
    { id: 'stroke', type: 'draw', x: 100, y: 100, width: 100, height: 100, points: [{ x: 0, y: 0 }, { x: 100, y: 100 }], strokeWidth: 4 },
    { id: 'photo', type: 'image', url: '', x: 300, y: 100, width: 100, height: 60 },
  ] })
  const previousCamera = cameraStore.getSnapshot()
  try {
    const sweep = (from: { x: number; y: number }, to: { x: number; y: number }) => {
      const env = environment(), state = new ToolState()
      tools.select.onPointerDown!(pointer(from.x, from.y), env, state)
      tools.select.onPointerUp!(pointer(to.x, to.y), env, state)
      return [...env.selection]
    }
    assert.deepEqual(sweep({ x: 80, y: 180 }, { x: 120, y: 180 }), [])
    assert.deepEqual(sweep({ x: 80, y: 150 }, { x: 220, y: 150 }), ['stroke'])
    cameraStore.set({ zoom: 2 })
    assert.deepEqual(sweep({ x: 280, y: 94 }, { x: 420, y: 94 }), [])
    assert.deepEqual(sweep({ x: 280, y: 96 }, { x: 420, y: 96 }), ['photo'])
    cameraStore.set({ zoom: 0.5 })
    assert.deepEqual(sweep({ x: 260, y: 84 }, { x: 440, y: 84 }), ['photo'])
  } finally { cameraStore.set(previousCamera) }
})

test('connections avoid duplicates, reject self-connections, and create cards on empty drop', () => {
  documentStore.load({ nodes: [card('a'), card('b', 200)] })
  const env = environment(), state = new ToolState()
  const connect = (id: string, to: PointerInfo) => { startConnection(id, pointer(120, 40), env, state); moveConnection(to, env, state); finishConnection(to, env, state) }
  connect('a', pointer(220, 40))
  connect('b', pointer(30, 40))
  assert.equal(documentStore.getSnapshot().edges!.length, 1)
  connect('a', pointer(30, 40))
  assert.equal(documentStore.getSnapshot().edges!.length, 1)
  connect('a', pointer(500, 200))
  assert.equal(documentStore.getSnapshot().nodes!.length, 3)
  assert.equal(documentStore.getSnapshot().edges!.length, 2)
  assert.equal(documentStore.getSnapshot().edges![1].toEnd, 'none')
})

test('frames are behind contents and stroke hit testing ignores empty bounding-box space', () => {
  const stroke: CanvasNode = { id: 'stroke', type: 'draw', x: 0, y: 0, width: 100, height: 100, points: [{ x: 0, y: 0 }, { x: 100, y: 100 }], strokeWidth: 4 }
  assert.equal(hitTest({ nodes: [stroke] }, 10, 90), null)
  assert.equal(hitTest({ nodes: [stroke] }, 50, 52)!.id, 'stroke')
  assert.equal(hitTest({ nodes: [card('a'), frame()] }, 50, 50)!.id, 'a')
  const curve = { ...stroke, points: [{ x: 0, y: 100 }, { x: 0, y: 0 }, { x: 100, y: 0 }] }
  assert.equal(hitTest({ nodes: [curve] }, 12.5, 25)!.id, 'stroke')
})

test('freehand supports single dots and preserves brush appearance across camera zoom', () => {
  documentStore.load({ nodes: [] })
  const env = environment(), state = new ToolState()
  tools.draw.onPointerDown!(pointer(40, 40), env, state)
  tools.draw.onPointerUp!(pointer(40, 40), env, state)
  const stroke = documentStore.getSnapshot().nodes![0]
  assert.equal(stroke.type, 'draw')
  assert.equal(stroke.color, '5')
  assert.equal((stroke as any).strokeWidth, 4)
  const camera = new CameraStore()
  camera.set({ x: 100, y: 50, zoom: 2 })
  assert.deepEqual(camera.screenToWorld(180, 130), { x: 40, y: 40 })
  assert.deepEqual(camera.worldToScreen(40, 40), { x: 180, y: 130 })
  camera.set({ x: NaN, y: Infinity, zoom: NaN })
  assert.deepEqual(camera.getSnapshot(), { x: 100, y: 50, zoom: 2 })
})

test('new drawings stack above existing nodes and layer changes update hits with undo', () => {
  documentStore.load({ nodes: [card('a', 0, 0)] })
  const env = environment(), state = new ToolState()
  const draw = () => {
    documentStore.beginInteraction()
    tools.draw.onPointerDown!(pointer(0, 30), env, state)
    tools.draw.onPointerUp!(pointer(100, 30), env, state)
    documentStore.endInteraction()
    return documentStore.getSnapshot().nodes!.at(-1)!
  }
  const first = draw(), second = draw()
  assert.equal(hitTest(documentStore.getSnapshot(), 50, 30)!.id, second.id)
  documentStore.sendToBack(second.id)
  assert.equal(hitTest(documentStore.getSnapshot(), 50, 30)!.id, first.id)
  documentStore.bringToFront('a')
  assert.equal(hitTest(documentStore.getSnapshot(), 50, 30)!.id, 'a')
  documentStore.undo()
  assert.equal(hitTest(documentStore.getSnapshot(), 50, 30)!.id, first.id)
  documentStore.undo()
  assert.equal(hitTest(documentStore.getSnapshot(), 50, 30)!.id, second.id)
  assert.deepEqual(restoreCanvas(documentStore.toJSON()).nodes!.map((n) => n.id), ['a', first.id, second.id])
  assert.equal(strokePath([{ x: 0, y: 0 }, { x: 50, y: 100 }, { x: 100, y: 0 }]), 'M 0 0 Q 50 100 75 50 L 100 0')
  assert.match(strokePath([{ x: 1, y: 2 }, { x: 1, y: 2 }]), /L 1.01 2$/)
})

test('import rejects malformed documents before replacing the current canvas', async () => {
  for (const value of [null, [], {}, { nodes: 'wrong' }, { nodes: [], edges: false }]) {
    await assert.rejects(importCanvasFile(new File([JSON.stringify(value)], 'bad.canvas')))
  }
  const doc = { nodes: [card('a')], edges: [] }
  assert.deepEqual(await importCanvasFile(new File([JSON.stringify(doc)], 'good.canvas')), doc)
})

test('synchronous recovery preserves the newest snapshot, including an empty canvas', async () => {
  const storage = new Map<string, string>()
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  } })
  try {
    documentStore.load({ nodes: [card('a')], meta: { name: 'Before' } })
    await saveLocal() // Node has no IndexedDB; use the same recovery fallback.
    assert.equal((await loadLocal())!.nodes!.length, 1)
    documentStore.load({ nodes: [], edges: [], meta: { name: 'Empty' } })
    saveRecovery()
    const restored = await loadLocal()
    assert.deepEqual(restored!.nodes, [])
    assert.equal(restored!.meta!.name, 'Empty')
  } finally {
    if (previous === undefined) delete (globalThis as any).localStorage
    else Object.defineProperty(globalThis, 'localStorage', previous)
  }
})

test('text and connection defaults persist independently, migrate legacy color, and affect only new content', () => {
  const storage = new Map<string, string>()
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const previousColors = preferencesStore.getSnapshot()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  } })
  try {
    const defaults = { textColor: undefined, connectionColor: DEFAULT_CONNECTION_COLOR }
    assert.deepEqual(new PreferencesStore().getSnapshot(), defaults)
    assert.equal(PRESET_COLORS[DEFAULT_CONNECTION_COLOR], '#609fbb')
    storage.set(THEME_STORAGE_KEY, '#39cbd4')
    assert.deepEqual(new PreferencesStore().getSnapshot(), defaults)
    preferencesStore.setTextColor(undefined)
    preferencesStore.setConnectionColor(DEFAULT_CONNECTION_COLOR)
    documentStore.load({ nodes: [card('existing')] })
    const whiteCard = createTextCard({ x: 300, y: 200 })
    assert.equal(whiteCard.color, undefined)
    preferencesStore.setConnectionColor('2')
    assert.equal(preferencesStore.getSnapshot().textColor, undefined)
    preferencesStore.setTextColor('4')
    assert.deepEqual(new PreferencesStore().getSnapshot(), { textColor: '4', connectionColor: '2' })
    assert.deepEqual(JSON.parse(storage.get(COLORS_STORAGE_KEY)!), { textColor: '4', connectionColor: '2' })
    assert.equal(createImageCard({ x: 700, y: 200 }, '').color, undefined)
    const state = new ToolState(), env = environment()
    startConnection(whiteCard.id, pointer(400, 180), env, state)
    moveConnection(pointer(1000, 400), env, state)
    finishConnection(pointer(1000, 400), env, state)
    assert.equal(documentStore.getSnapshot().edges![0].color, '2')
    assert.equal(documentStore.getSnapshot().nodes!.at(-1)!.color, '4')
    assert.equal(documentStore.getNode(whiteCard.id)!.color, undefined)
    assert.equal(documentStore.getNode('existing')!.color, undefined)
    storage.set(COLORS_STORAGE_KEY, JSON.stringify({ textColor: 'invalid', connectionColor: 'invalid' }))
    storage.set(THEME_STORAGE_KEY, 'invalid')
    assert.deepEqual(new PreferencesStore().getSnapshot(), defaults)
  } finally {
    preferencesStore.setTextColor(previousColors.textColor)
    preferencesStore.setConnectionColor(previousColors.connectionColor)
    if (previous === undefined) delete (globalThis as any).localStorage
    else Object.defineProperty(globalThis, 'localStorage', previous)
  }
})

test('minimap includes negative and distant content, padding, and the current viewport on empty boards', () => {
  const size = { width: 1000, height: 600 }
  const viewport = viewportRect({ x: 100, y: -80, zoom: 2 }, size)
  assert.deepEqual(viewport, { x: -50, y: 40, width: 500, height: 300 })
  const nodes = [card('negative', -1200, -900), card('distant', 2400, 1600)]
  for (const content of [nodes, []]) {
    const bounds = minimapBounds(content, viewport, 240 / 152)
    assert.ok(Math.abs(bounds.width / bounds.height - 240 / 152) < 1e-10)
    for (const rect of [...content, viewport]) {
      assert.ok(rect.x > bounds.x && rect.y > bounds.y)
      assert.ok(rect.x + rect.width < bounds.x + bounds.width)
      assert.ok(rect.y + rect.height < bounds.y + bounds.height)
    }
  }
  assert.deepEqual(cameraAtCenter({ x: -1200, y: 800 }, size, 2), { x: 2900, y: -1300, zoom: 2 })
})

test('slider zoom keeps the visible center fixed across zoom limits', () => {
  const size = { width: 1200, height: 700 }, camera = { x: -450, y: 220, zoom: 0.7 }
  const before = viewportRect(camera, size)
  for (const requested of [0.01, 0.5, 1, 2.4, 10]) {
    const next = zoomAtCenter(camera, size, requested), after = viewportRect(next, size)
    assert.ok(Math.abs(before.x + before.width / 2 - after.x - after.width / 2) < 1e-9)
    assert.ok(Math.abs(before.y + before.height / 2 - after.y - after.height / 2) < 1e-9)
    assert.equal(next.zoom, Math.max(0.2, Math.min(3, requested)))
  }
})

test('camera clamps restored and programmatic zoom to 20–300 percent', () => {
  const camera = new CameraStore()
  camera.set({ zoom: 0.1 })
  assert.equal(camera.getSnapshot().zoom, 0.2)
  camera.set({ zoom: 4 })
  assert.equal(camera.getSnapshot().zoom, 3)
  camera.set({ zoom: NaN })
  assert.equal(camera.getSnapshot().zoom, 3)
  camera.set({ zoom: 1 })
  assert.equal(camera.getSnapshot().zoom, 1)
})

test('minimap navigation keeps the whole viewport and its stroke inside every edge at all zooms', () => {
  for (const size of [{ width: 1200, height: 700 }, { width: 375, height: 654 }]) {
    for (const zoom of [0.2, 1, 3]) {
      const bounds = minimapBounds([card('negative', -1600, -900), card('far', 2400, 1600)], viewportRect({ x: 0, y: 0, zoom }, size), 240 / 152)
      const inset = bounds.width / 240
      for (const x of [bounds.x - 1000, bounds.x, bounds.x + bounds.width / 2, bounds.x + bounds.width + 1000]) {
        for (const y of [bounds.y - 1000, bounds.y, bounds.y + bounds.height / 2, bounds.y + bounds.height + 1000]) {
          const camera = minimapCamera({ x, y }, size, zoom, bounds, inset)
          const viewport = viewportRect(camera, size)
          assert.ok(viewport.x >= bounds.x + inset - 1e-8)
          assert.ok(viewport.y >= bounds.y + inset - 1e-8)
          assert.ok(viewport.x + viewport.width <= bounds.x + bounds.width - inset + 1e-8)
          assert.ok(viewport.y + viewport.height <= bounds.y + bounds.height - inset + 1e-8)
          assert.equal(camera.zoom, zoom)
        }
      }
    }
  }
})

test('inline crop preserves image pixels in world space and can reveal previously cropped content', () => {
  const image: ImageNode = { id: 'photo', type: 'image', x: 100, y: 80, width: 400, height: 240, url: '', naturalWidth: 1000, naturalHeight: 600 }
  const cropped = { ...image, ...cropImage(image, 'nw', 80, 48) }
  assert.deepEqual(cropped.crop, { x: 0.2, y: 0.2, width: 0.8, height: 0.8 })
  assert.equal(cropped.x, 180)
  assert.equal(cropped.y, 128)
  assert.equal(cropped.width, 320)
  assert.equal(cropped.height, 192)
  assert.deepEqual(uncroppedBounds(cropped), uncroppedBounds(image))
  const restored = { ...cropped, ...cropImage(cropped, 'nw', -800, -480) }
  assert.equal(restored.crop, undefined)
  assert.deepEqual(uncroppedBounds(restored), uncroppedBounds(image))
  assert.equal(restored.width, image.width)
  assert.equal(restored.height, image.height)
})

test('all inline crop handles and dragging the crop region stay inside the original image', () => {
  for (const width of [10, 400]) {
    const image: ImageNode = { id: 'photo', type: 'image', x: 100, y: 80, width, height: width * 0.6, url: '', crop: { x: 0.2, y: 0.1, width: 0.6, height: 0.7 } }
    for (const handle of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw', 'move'] as CropHandle[]) {
      for (const delta of [-10000, 10000]) {
        const next = { ...image, ...cropImage(image, handle, delta, delta) }, crop = next.crop!
        assert.ok(crop.x >= 0 && crop.y >= 0 && crop.width > 0 && crop.height > 0)
        assert.ok(crop.x + crop.width <= 1 + 1e-8 && crop.y + crop.height <= 1 + 1e-8)
        const before = uncroppedBounds(image), after = uncroppedBounds(next)
        for (const key of ['x', 'y', 'width', 'height'] as const) assert.ok(Math.abs(before[key] - after[key]) < 1e-8)
      }
    }
  }
})

test('inline crop gestures undo as one operation and cancellation restores the original image', () => {
  const store = new DocumentStore()
  const image: ImageNode = { id: 'photo', type: 'image', x: 100, y: 80, width: 400, height: 240, url: '' }
  store.load({ nodes: [image] })
  const original = store.toJSON()
  store.beginInteraction()
  for (const dx of [10, 20, 40, 80]) store.updateNode(image.id, cropImage(image, 'se', -dx, -dx))
  store.endInteraction()
  const cropped = store.toJSON()
  store.undo()
  assert.deepEqual(store.toJSON(), original)
  store.redo()
  assert.deepEqual(store.toJSON(), cropped)
  store.beginInteraction()
  store.updateNode(image.id, cropImage(store.getNode(image.id) as ImageNode, 'nw', 40, 40))
  store.cancelInteraction()
  assert.deepEqual(store.toJSON(), cropped)
})

test('splitting a caption creates a text block and clears only the image caption in one undo step', () => {
  const image: ImageNode = { id: 'photo', type: 'image', x: 20, y: 20, width: 100, height: 60, url: 'image', text: '图片注释', crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } }
  documentStore.load({ nodes: [image, frame(['photo'])] })
  assert.equal(splitImageCaption(image.id, '  '), null)
  const text = splitImageCaption(image.id, image.text!)!
  assert.equal(text.text, image.text)
  assert.equal(text.x, image.x)
  assert.equal(text.y, image.y + image.height + 24)
  assert.equal((documentStore.getNode(image.id) as ImageNode).text, undefined)
  assert.deepEqual((documentStore.getNode(image.id) as ImageNode).crop, image.crop)
  assert.ok((documentStore.getNode('group') as GroupNode).memberIds!.includes(text.id))
  documentStore.undo()
  assert.equal(documentStore.getNode(text.id), undefined)
  assert.equal((documentStore.getNode(image.id) as ImageNode).text, image.text)
  documentStore.redo()
  assert.equal((documentStore.getNode(text.id) as TextNode).text, image.text)
})

test('connection label drag offsets survive export, restoration, undo, and invalid imported offsets', () => {
  const store = new DocumentStore()
  store.load({ nodes: [card('a'), card('b', 300)], edges: [{ id: 'edge', fromNode: 'a', toNode: 'b', label: '标签' }] })
  store.beginInteraction()
  store.updateEdge('edge', { labelOffset: { x: 60, y: -40 } })
  store.updateEdge('edge', { labelOffset: { x: 120, y: -80 } })
  store.endInteraction()
  assert.deepEqual(restoreCanvas(store.toJSON()).edges![0].labelOffset, { x: 120, y: -80 })
  store.undo()
  assert.equal(store.getEdge('edge')!.labelOffset, undefined)
  store.redo()
  assert.deepEqual(store.getEdge('edge')!.labelOffset, { x: 120, y: -80 })
  store.updateEdge('edge', { labelOffset: { x: NaN, y: Infinity } })
  assert.equal(restoreCanvas(store.toJSON()).edges![0].labelOffset, undefined)
})
