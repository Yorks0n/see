import { IDBFactory } from 'fake-indexeddb'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DocumentStore, documentStore, restoreCanvas } from '../src/store/document'
import { CameraStore, cameraStore } from '../src/store/camera'
import { DEFAULT_CONNECTION_COLOR, PreferencesStore, preferencesStore, THEME_STORAGE_KEY, COLORS_STORAGE_KEY } from '../src/store/preferences'
import { cameraAtCenter, minimapBounds, minimapCamera, viewportRect, zoomAtCenter } from '../src/render/minimap'
import { edgeGeometry, hitTest, PRESET_COLORS, strokePath } from '../src/render/renderer'
import { arrangeNodes, createImageCard, createList, createTextCard, duplicateNodes, expandSelection, finishConnection, listFromSelection, moveConnection, splitImageCaption, startConnection, tools, ToolState, ungroupNodes, updateMembership, type ToolEnv, type PointerInfo } from '../src/tools/tools'
import { arrangement, ARRANGE_GAP } from '../src/tools/layout'
import { resizeSelection, selectionBounds } from '../src/tools/resize'
import { selectionSVG } from '../src/tools/export'
import { SHORTCUTS } from '../src/shortcuts'
import { LASER_LIFETIME, LaserTrail } from '../src/tools/laser'
import { TouchNavigation } from '../src/tools/touchNavigation'
import { editingCamera } from '../src/render/editing'
import { inViewport } from '../src/render/viewport'
import { deleteLocalFile, importCanvasFile, initializeLocal, loadLocal, saveCanvas, saveLocal, saveRecovery, setActiveFile } from '../src/persistence'
import { LIBRARY_KEY, LibraryStore } from '../src/store/library'
import { cropImage, uncroppedBounds, type CropHandle } from '../src/tools/imageCrop'
import { CLIPBOARD_MIME, copySelection, pasteSelection, readClipboard, writeClipboard } from '../src/tools/clipboard'
import type { CanvasNode, GroupNode, ImageNode, RectangleNode, TextNode } from '../src/types'
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
  const env: ToolEnv = { selection, setSelection: (next) => { env.selection = next }, selectionOutline: false, setSelectionOutline: (outline) => { env.selectionOutline = outline }, setDragPreview: () => {}, setMarquee: () => {}, setPaintTrail: () => {}, addLaserPoint: () => {}, setEditingId: () => {}, setTool: () => {}, drawStyle: { color: '5', strokeWidth: 4 } }
  return env
}

test('touch editing lifts cards above the keyboard with space below and preserves canvas zoom', () => {
  const camera = { x: 40, y: -20, zoom: 0.59 }
  const card = { x: 100, y: 350, width: 160, height: 50 }
  const next = editingCamera(camera, card, { width: 390, height: 420 })
  assert.deepEqual(next, { ...camera, y: -96 })
  assert.deepEqual(card, { x: 100, y: 350, width: 160, height: 50 })
  assert.equal(editingCamera(next, { ...card, y: card.y + next.y - camera.y }, { width: 390, height: 420 }), next)
})

test('touch editing leaves comfortably visible cards in place and adapts to keyboard resizing', () => {
  const camera = { x: 0, y: 0, zoom: 1 }, card = { x: 100, y: 400, width: 200, height: 60 }
  assert.equal(editingCamera(camera, card, { width: 390, height: 844 }), camera)
  const next = editingCamera(camera, card, { width: 390, height: 440 })
  assert.equal(card.y + next.y + card.height, 344)
  assert.equal(editingCamera(next, { ...card, y: card.y + next.y }, { width: 390, height: 844 }), next)
})

test('touch editing keeps long-card carets visible rather than moving the entire card into view', () => {
  const camera = { x: 0, y: 0, zoom: 2 }
  const card = { x: 80, y: -300, width: 200, height: 1000 }
  const size = { width: 390, height: 420 }
  assert.equal(editingCamera(camera, card, size, { x: 110, y: 200, width: 1, height: 24 }), camera)
  assert.equal(editingCamera(camera, card, size, { x: 110, y: 380, width: 1, height: 24 }).y, -80)
  assert.equal(editingCamera(camera, card, size, { x: 110, y: 20, width: 1, height: 24 }).y, 60)
})

test('touch editing avoids horizontal clipping and remains usable in short viewports', () => {
  const camera = { x: 0, y: 0, zoom: 1 }
  assert.equal(editingCamera(camera, { x: 300, y: 100, width: 200, height: 60 }, { width: 390, height: 420 }).x, -134)
  const next = editingCamera(camera, { x: -500, y: -400, width: 1000, height: 1000 }, { width: 390, height: 180 }, { x: 380, y: 160, width: 1, height: 24 })
  assert.deepEqual(next, { x: -15, y: -49, zoom: 1 })
})

test('two touch pointers pan and zoom around their moving midpoint', () => {
  const touch = new TouchNavigation(), camera = { x: 40, y: -20, zoom: 0.5 }
  touch.start(1, { x: 100, y: 100 }, camera)
  assert.equal(touch.active, false)
  // The first finger may already have moved before the second lands.
  assert.equal(touch.move(1, { x: 120, y: 100 }), null)
  touch.start(2, { x: 220, y: 100 }, camera)
  assert.equal(touch.active, true)
  const next = touch.move(2, { x: 320, y: 100 })!
  assert.equal(next.zoom, 1)
  assert.equal((220 - next.x) / next.zoom, (170 - camera.x) / camera.zoom)
  assert.equal((100 - next.y) / next.zoom, (100 - camera.y) / camera.zoom)
  touch.move(1, { x: 150, y: 140 })
  const translated = touch.move(2, { x: 350, y: 140 })!
  assert.deepEqual(translated, { x: next.x + 30, y: next.y + 40, zoom: 1 })
  assert.equal(touch.move(99, { x: 0, y: 0 }), null)
})

test('touch zoom limits keep the original world point under the midpoint', () => {
  for (const [distance, expected] of [[1, 0.2], [1000, 3]]) {
    const touch = new TouchNavigation(), camera = { x: -80, y: 50, zoom: 1 }
    touch.start(1, { x: 100, y: 100 }, camera)
    touch.start(2, { x: 200, y: 100 }, camera)
    const next = touch.move(2, { x: 100 + distance, y: 100 })!
    assert.equal(next.zoom, expected)
    assert.equal((100 + distance / 2 - next.x) / next.zoom, 150 - camera.x)
    assert.equal((100 - next.y) / next.zoom, 100 - camera.y)
  }
  const touch = new TouchNavigation(), camera = { x: 0, y: 0, zoom: 1 }
  touch.start(1, { x: 100, y: 100 }, camera)
  touch.start(2, { x: 100, y: 100 }, camera)
  const next = touch.move(2, { x: 120, y: 100 })!
  assert.ok(Object.values(next).every(Number.isFinite))
})

test('lifting or cancelling one finger suppresses tool input until all touches end', () => {
  const touch = new TouchNavigation(), camera = { x: 0, y: 0, zoom: 1 }
  touch.start(1, { x: 100, y: 100 }, camera)
  touch.start(2, { x: 200, y: 100 }, camera)
  const next = touch.move(2, { x: 250, y: 100 })!
  assert.equal(touch.end(2, next), true)
  assert.equal(touch.active, true)
  assert.equal(touch.move(1, { x: 400, y: 200 }), null)
  assert.equal(touch.end(2, next), false) // Automatic capture loss after pointerup.
  touch.start(3, { x: 500, y: 200 }, next)
  assert.deepEqual(touch.move(3, { x: 500, y: 200 }), next)
  assert.equal(touch.end(1, next), true)
  assert.equal(touch.end(3, next), true)
  assert.equal(touch.active, false)
  assert.equal(touch.size, 0)
  touch.start(4, { x: 10, y: 10 }, next)
  assert.equal(touch.active, false)
  assert.equal(touch.end(4, next), false)
})

test('adding and replacing a third touch rebases navigation without a camera jump', () => {
  const touch = new TouchNavigation(), camera = { x: 20, y: -10, zoom: 1 }
  touch.start(1, { x: 100, y: 100 }, camera)
  touch.start(2, { x: 200, y: 100 }, camera)
  const next = touch.move(2, { x: 250, y: 100 })!
  touch.start(3, { x: 400, y: 200 }, next)
  assert.deepEqual(touch.move(3, { x: 450, y: 200 }), next)
  assert.equal(touch.end(1, next), true)
  assert.deepEqual(touch.move(2, { x: 250, y: 100 }), next)
  const moved = touch.move(3, { x: 500, y: 200 })!
  assert.notDeepEqual(moved, next)
})

test('laser gestures leave document, selection and undo history untouched and separate strokes', () => {
  documentStore.load({ nodes: [card('a')] })
  documentStore.updateNode('a', { text: 'changed' })
  const before = documentStore.toJSON(), env = environment(new Set(['a'])), state = new ToolState()
  const trail = new LaserTrail()
  env.addLaserPoint = (point, start) => trail.add(point, start, 0)
  tools.laser.onPointerMove!(pointer(0, 0), env, state)
  assert.equal(trail.points.length, 0)
  for (const x of [20, 200]) {
    tools.laser.onPointerDown!(pointer(x, 20, 'a'), env, state)
    tools.laser.onPointerMove!(pointer(x + 10, 30), env, state)
    tools.laser.onPointerUp!(pointer(x + 20, 40), env, state)
    assert.equal(state.dragging, null)
  }
  assert.deepEqual(trail.points.map((point) => point.start), [true, false, false, true, false, false])
  assert.deepEqual(documentStore.toJSON(), before)
  assert.deepEqual([...env.selection], ['a'])
  documentStore.undo()
  assert.equal((documentStore.getNode('a') as TextNode).text, 'a')
})

test('laser points expire independently and cancellation clears all trails', () => {
  const trail = new LaserTrail()
  trail.add({ x: 0, y: 0 }, true, 0)
  trail.add({ x: 50, y: 20 }, false, 300)
  trail.prune(LASER_LIFETIME)
  assert.equal(trail.points.length, 1)
  assert.equal(trail.points[0].x, 50)
  trail.prune(LASER_LIFETIME + 300)
  assert.equal(trail.points.length, 0)
  trail.add({ x: 10, y: 10 }, true, 2000)
  trail.clear()
  assert.equal(trail.points.length, 0)
  assert.equal(SHORTCUTS.find((s) => s.id === 'laser')?.keys, 'K')
  assert.equal(SHORTCUTS.find((s) => s.id === 'list')?.keys, 'L')
})

test('rectangle waits for a drag before showing a shape at the dragged size', () => {
  documentStore.load({ nodes: [card('existing')] })
  const before = documentStore.toJSON(), env = environment(new Set(['existing'])), state = new ToolState()
  documentStore.beginInteraction()
  tools.rectangle.onPointerDown!(pointer(300, 240), env, state)
  assert.deepEqual(documentStore.toJSON(), before)
  assert.deepEqual([...env.selection], ['existing'])
  tools.rectangle.onPointerMove!(pointer(302, 241), env, state)
  assert.deepEqual(documentStore.toJSON(), before)
  tools.rectangle.onPointerMove!(pointer(280, 230), env, state)
  const shape = documentStore.getNode([...env.selection][0])!
  assert.deepEqual([shape.x, shape.y, shape.width, shape.height], [280, 230, 20, 10])
  tools.rectangle.onPointerMove!(pointer(250, 210), env, state)
  assert.equal(documentStore.getSnapshot().nodes!.length, 2)
  assert.equal(documentStore.getNode(shape.id)!.width, 50)
  documentStore.cancelInteraction()
  assert.deepEqual(documentStore.toJSON(), before)
})

test('rectangle tool creates click and reverse-drag shapes, moves independently, and supports cancel and undo', () => {
  documentStore.load({ nodes: [card('inside', 120, 120)] })
  const before = documentStore.toJSON(), env = environment(), state = new ToolState()
  documentStore.beginInteraction()
  tools.rectangle.onPointerDown!(pointer(300, 240), env, state)
  tools.rectangle.onPointerMove!(pointer(100, 100), env, state)
  tools.rectangle.onPointerUp!(pointer(100, 100), env, state)
  documentStore.endInteraction()
  const shape = documentStore.getNode([...env.selection][0])!
  assert.equal(shape.type, 'rectangle')
  assert.deepEqual([shape.x, shape.y, shape.width, shape.height], [100, 100, 200, 140])
  assert.deepEqual([...expandSelection(env.selection)], [shape.id])
  documentStore.beginInteraction()
  tools.select.onPointerDown!(pointer(100, 150, shape.id), env, state)
  tools.select.onPointerMove!(pointer(150, 180), env, state)
  tools.select.onPointerUp!(pointer(150, 180), env, state)
  documentStore.endInteraction()
  assert.equal(documentStore.getNode(shape.id)!.x, 150)
  assert.equal(documentStore.getNode('inside')!.x, 120)
  documentStore.undo()
  assert.equal(documentStore.getNode(shape.id)!.x, 100)
  documentStore.undo()
  assert.deepEqual(documentStore.toJSON(), before)
  documentStore.redo()
  assert.equal(documentStore.getNode(shape.id)!.width, 200)
  documentStore.beginInteraction()
  tools.rectangle.onPointerDown!(pointer(450, 100), env, state)
  tools.rectangle.onPointerUp!(pointer(450, 100), env, state)
  documentStore.endInteraction()
  const clicked = documentStore.getNode([...env.selection][0])!
  assert.deepEqual([clicked.width, clicked.height], [160, 100])
  const saved = documentStore.toJSON()
  documentStore.beginInteraction()
  tools.rectangle.onPointerDown!(pointer(650, 100), env, state)
  documentStore.cancelInteraction()
  assert.deepEqual(documentStore.toJSON(), saved)
})

test('rectangle selection hits its border and passes through the transparent interior', () => {
  const shape: RectangleNode = { id: 'rectangle', type: 'rectangle', x: 100, y: 100, width: 240, height: 180 }
  const doc = { nodes: [card('inside', 150, 150), shape] }
  assert.equal(hitTest(doc, 100, 150)!.id, shape.id)
  assert.equal(hitTest(doc, 345, 200)!.id, shape.id)
  assert.equal(hitTest(doc, 180, 180)!.id, 'inside')
  assert.equal(hitTest(doc, 290, 240), null)
  documentStore.load({ nodes: [shape] })
  const env = environment(), state = new ToolState()
  tools.select.onPointerDown!(pointer(150, 150), env, state)
  tools.select.onPointerMove!(pointer(250, 200), env, state)
  assert.equal(env.selection.size, 0)
  tools.select.onPointerUp!(pointer(350, 200), env, state)
  assert.deepEqual([...env.selection], [shape.id])
})

test('rectangles survive restoration, clipboard and SVG export with no fill or connection arrowheads', async () => {
  const shape: RectangleNode = { id: 'rectangle', type: 'rectangle', x: -100, y: 50, width: 240, height: 180, color: '#123456' }
  const doc = restoreCanvas({ nodes: [shape, card('text', 300, 200)], edges: [{ id: 'direction', fromNode: shape.id, toNode: 'text', toEnd: 'arrow' }] })
  assert.deepEqual(doc.nodes![0], shape)
  documentStore.load(doc)
  const clipboard = copySelection(new Set([shape.id]))!
  const data = new Map<string, string>()
  const transfer = { getData: (type: string) => data.get(type) ?? '', setData: (type: string, value: string) => data.set(type, value) } as DataTransfer
  writeClipboard(transfer, clipboard)
  const restored = readClipboard(transfer)!
  assert.equal(restored.nodes[0].type, 'rectangle')
  const pasted = pasteSelection(restored, { x: 600, y: 100 })
  assert.equal(documentStore.getNode([...pasted][0])!.type, 'rectangle')
  const svg = await selectionSVG(doc)
  assert.match(svg, /<rect x="-100" y="50" width="240" height="180" fill="none" stroke="#123456" stroke-width="2"/)
  assert.doesNotMatch(svg, /marker|arrow/)
  assert.equal(doc.edges![0].toEnd, 'arrow')
})

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

test('Option drag copies once at the pointer offset and is one undo step', () => {
  documentStore.load({ nodes: [card('a')] })
  const before = documentStore.getSnapshot(), env = environment(), state = new ToolState()
  documentStore.beginInteraction()
  tools.select.onPointerDown!({ ...pointer(30, 30, 'a'), altKey: true }, env, state)
  tools.select.onPointerMove!({ ...pointer(32, 30), altKey: true }, env, state)
  assert.equal(documentStore.getSnapshot().nodes!.length, 1)
  tools.select.onPointerMove!({ ...pointer(80, 60), altKey: true }, env, state)
  const copyId = [...env.selection][0]
  assert.notEqual(copyId, 'a')
  assert.equal(documentStore.getNode(copyId)!.x, 70)
  assert.equal(documentStore.getNode(copyId)!.y, 50)
  tools.select.onPointerMove!(pointer(100, 90), env, state)
  tools.select.onPointerUp!(pointer(110, 100), env, state)
  documentStore.endInteraction()
  assert.equal(documentStore.getSnapshot().nodes!.length, 2)
  assert.deepEqual(documentStore.getNode('a'), before.nodes![0])
  assert.deepEqual(documentStore.getNode(copyId), { ...before.nodes![0], id: copyId, x: 100, y: 90 })
  documentStore.undo()
  assert.deepEqual(documentStore.getSnapshot(), before)
  assert.equal(documentStore.canUndo, false)
  documentStore.redo()
  assert.equal(documentStore.getNode(copyId)!.x, 100)
  assert.equal(SHORTCUTS.find((s) => s.id === 'duplicate-drag')!.keys, 'Option / Alt + 拖动选中内容')
  assert.equal(SHORTCUTS.find((s) => s.id === 'duplicate-drag')!.group, '编辑')
})

test('Option click does not copy, and ordinary dragging still moves the original', () => {
  documentStore.load({ nodes: [card('a')] })
  const env = environment(), state = new ToolState()
  documentStore.beginInteraction()
  tools.select.onPointerDown!({ ...pointer(30, 30, 'a'), altKey: true }, env, state)
  tools.select.onPointerUp!(pointer(30, 30), env, state)
  documentStore.endInteraction()
  assert.equal(documentStore.getSnapshot().nodes!.length, 1)
  assert.equal(documentStore.canUndo, false)
  documentStore.beginInteraction()
  tools.select.onPointerDown!(pointer(30, 30, 'a'), env, state)
  tools.select.onPointerMove!(pointer(100, 90), env, state)
  tools.select.onPointerUp!(pointer(100, 90), env, state)
  documentStore.endInteraction()
  assert.equal(documentStore.getSnapshot().nodes!.length, 1)
  assert.equal(documentStore.getNode('a')!.x, 90)
  assert.deepEqual([...env.selection], ['a'])
})

test('Option drag copies selected blocks and internal connections with Shift axis locking', () => {
  documentStore.load({ nodes: [card('a'), card('b', 200)], edges: [{ id: 'ab', fromNode: 'a', toNode: 'b' }] })
  const before = documentStore.getSnapshot(), env = environment(new Set(['a', 'b'])), state = new ToolState()
  documentStore.beginInteraction()
  tools.select.onPointerDown!({ ...pointer(30, 30, 'a'), altKey: true }, env, state)
  const end = { ...pointer(330, 100), shiftKey: true, altKey: true }
  tools.select.onPointerMove!(end, env, state)
  tools.select.onPointerUp!(end, env, state)
  documentStore.endInteraction()
  assert.equal(env.selection.size, 2)
  assert.equal(documentStore.getSnapshot().nodes!.length, 4)
  for (const id of ['a', 'b']) assert.deepEqual(documentStore.getNode(id), before.nodes!.find((n) => n.id === id))
  assert.deepEqual([...env.selection].map((id) => documentStore.getNode(id)!.y), [20, 20])
  const edge = documentStore.getSnapshot().edges![1]
  assert.ok(env.selection.has(edge.fromNode) && env.selection.has(edge.toNode))
})

test('Option dragging groups copies descendants and can be cancelled without an undo entry', () => {
  documentStore.load({ nodes: [card('a'), card('b', 200), frame()], edges: [{ id: 'ab', fromNode: 'a', toNode: 'b' }] })
  const before = documentStore.getSnapshot(), env = environment(new Set(['group'])), state = new ToolState()
  documentStore.beginInteraction()
  tools.select.onPointerDown!({ ...pointer(5, 5, 'group'), altKey: true }, env, state)
  tools.select.onPointerMove!(pointer(505, 305), env, state)
  const copies = expandSelection(env.selection)
  assert.equal(copies.size, 3)
  assert.ok([...copies].every((id) => !['a', 'b', 'group'].includes(id)))
  assert.equal(documentStore.getNode([...env.selection][0])!.x, 500)
  for (const node of before.nodes!) assert.deepEqual(documentStore.getNode(node.id)?.x, node.x)
  assert.deepEqual([...state.dragging!.initialSelection!], ['group'])
  documentStore.cancelInteraction()
  assert.deepEqual(documentStore.getSnapshot(), before)
  assert.equal(documentStore.canUndo, false)
})

test('Option dragging a list member out leaves the original list intact', () => {
  documentStore.load({ nodes: [card('a'), card('b', 200)] })
  const list = listFromSelection(new Set(['a', 'b']))!, before = documentStore.getSnapshot()
  const original = documentStore.getNode('a')!, env = environment(new Set(['a'])), state = new ToolState()
  documentStore.beginInteraction()
  tools.select.onPointerDown!({ ...pointer(original.x + 10, original.y + 10, 'a'), altKey: true }, env, state)
  tools.select.onPointerMove!(pointer(700, 500), env, state)
  tools.select.onPointerUp!(pointer(700, 500), env, state)
  documentStore.endInteraction()
  assert.deepEqual((documentStore.getNode(list.id) as GroupNode).memberIds, ['a', 'b'])
  for (const node of before.nodes!) assert.deepEqual(documentStore.getNode(node.id), node)
  assert.equal(documentStore.getNode([...env.selection][0])!.x, 690)
  documentStore.undo()
  assert.deepEqual(documentStore.getSnapshot(), before)
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

test('multi-selection resize scales geometry, spacing and drawing points around each fixed corner', () => {
  const nodes: CanvasNode[] = [
    card('a', -100, -60),
    { id: 'stroke', type: 'draw', x: 100, y: 40, width: 100, height: 100, points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] },
  ]
  const bounds = selectionBounds(nodes)
  assert.deepEqual(bounds, { x: -100, y: -60, width: 300, height: 200 })
  for (const corner of ['nw', 'ne', 'se', 'sw']) {
    const west = corner.includes('w'), north = corner.includes('n')
    const patches = resizeSelection(nodes, bounds, west ? -300 : 300, north ? -200 : 200, corner, true)
    const resized = nodes.map((node) => ({ ...node, ...patches.get(node.id) } as CanvasNode))
    const after = selectionBounds(resized)
    assert.equal(after.width, 600)
    assert.equal(after.height, 400)
    assert.equal(west ? after.x + after.width : after.x, west ? bounds.x + bounds.width : bounds.x)
    assert.equal(north ? after.y + after.height : after.y, north ? bounds.y + bounds.height : bounds.y)
    assert.equal(resized[1].x - resized[0].x, 400)
    assert.equal(resized[1].y - resized[0].y, 200)
    assert.equal(resized[0].width, 200)
    assert.deepEqual((resized[1] as any).points, [{ x: 0, y: 0 }, { x: 200, y: 200 }])
  }
})

test('multi-selection resize supports independent axes and clamps the whole selection before any block collapses', () => {
  const nodes: CanvasNode[] = [
    { id: 'photo', type: 'image', url: 'image.png', x: 0, y: 0, width: 200, height: 100, crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.5 } },
    { id: 'rect', type: 'rectangle', x: 300, y: 100, width: 100, height: 100 },
  ]
  const bounds = selectionBounds(nodes)
  const patches = resizeSelection(nodes, bounds, 400, 100, 'se', false)
  assert.deepEqual(patches.get('photo'), { x: 0, y: 0, width: 400, height: 150 })
  assert.deepEqual(patches.get('rect'), { x: 600, y: 150, width: 200, height: 150 })
  const clamped = resizeSelection(nodes, bounds, -1000, -1000, 'se', false)
  assert.equal(clamped.get('photo')!.width, 64)
  assert.equal(clamped.get('rect')!.width, 32)
  assert.equal(clamped.get('rect')!.height, 24)
  assert.deepEqual(nodes[0].crop, { x: 0.1, y: 0.2, width: 0.5, height: 0.5 })
  const proportional = resizeSelection(nodes, bounds, 200, 0, 'se', true)
  assert.equal(proportional.get('photo')!.width, 300)
  assert.equal(proportional.get('photo')!.height, 150)
})

test('three or six images with thin annotations resize without jumping or hitting stroke minimums', () => {
  for (const count of [3, 6]) {
    const nodes: CanvasNode[] = Array.from({ length: count }, (_, i) => ({
      id: `photo-${i}`, type: 'image', url: 'image.png', x: (i % 3) * 140, y: Math.floor(i / 3) * 240, width: 100, height: 200,
    }))
    nodes.push(
      { id: 'vertical', type: 'draw', x: 170, y: 30, width: 1, height: 150, points: [{ x: 0, y: 0 }, { x: 1, y: 150 }] },
      { id: 'horizontal', type: 'draw', x: 155, y: 185, width: 60, height: 1, points: [{ x: 0, y: 0 }, { x: 60, y: 1 }] },
    )
    const bounds = selectionBounds(nodes)
    for (const scale of [1, 1.001, 0.999, 0.9, 0.5]) {
      const patches = resizeSelection(nodes, bounds, bounds.width * (scale - 1), bounds.height * (scale - 1), 'se', true)
      for (const node of nodes.filter((n) => n.type === 'image')) {
        const patch = patches.get(node.id)!
        assert.ok(Math.abs(patch.width! - node.width * scale) < 1e-8)
        assert.ok(Math.abs(patch.height! - node.height * scale) < 1e-8)
        assert.ok(Math.abs(patch.x! - node.x * scale) < 1e-8)
      }
      assert.equal((patches.get('vertical') as any).points[1].y, 150 * scale)
      assert.equal((patches.get('horizontal') as any).points[1].x, 60 * scale)
      assert.ok(patches.get('vertical')!.width! >= 1)
      assert.ok(patches.get('horizontal')!.height! >= 1)
    }
  }
})

test('resizing a selection with nested groups transforms each member once and preserves undo, redo and cancellation', () => {
  documentStore.load({ nodes: [card('a'), card('b', 200), frame(), card('outside', 500, 400), card('unselected', 900, 900)], edges: [{ id: 'ab', fromNode: 'a', toNode: 'b' }] })
  const ids = expandSelection(new Set(['group', 'a', 'outside']))
  const nodes = documentStore.getSnapshot().nodes!.filter((node) => ids.has(node.id))
  const bounds = selectionBounds(nodes), before = documentStore.toJSON()
  documentStore.beginInteraction()
  for (const scale of [0.5, 1, 1.5, 2]) documentStore.updateNodes(resizeSelection(nodes, bounds, bounds.width * (scale - 1), bounds.height * (scale - 1), 'se', true))
  updateMembership(ids)
  documentStore.endInteraction()
  assert.equal(documentStore.getNode('a')!.width, 200)
  assert.equal(documentStore.getNode('a')!.x, 40)
  assert.deepEqual((documentStore.getNode('group') as GroupNode).memberIds, ['a', 'b'])
  assert.deepEqual(documentStore.toJSON().nodes!.find((node) => node.id === 'unselected'), before.nodes!.find((node) => node.id === 'unselected'))
  assert.deepEqual(documentStore.toJSON().edges, before.edges)
  const after = documentStore.toJSON()
  documentStore.undo()
  assert.deepEqual(documentStore.toJSON(), before)
  assert.equal(documentStore.canUndo, false)
  documentStore.redo()
  assert.deepEqual(documentStore.toJSON(), after)
  documentStore.beginInteraction()
  documentStore.updateNodes(resizeSelection(nodes, bounds, -100, -50, 'nw', false))
  documentStore.cancelInteraction()
  assert.deepEqual(documentStore.toJSON(), after)
})

test('resizing a selection containing a list retains its minimum height and reflows members without losing membership', () => {
  documentStore.load({ nodes: [card('a'), card('b', 200)] })
  const list = documentStore.getNode(listFromSelection(new Set(['a', 'b']))!.id) as GroupNode
  documentStore.addNode(card('outside', 500, 400))
  const before = documentStore.toJSON()
  const ids = expandSelection(new Set([list.id, 'outside']))
  const nodes = documentStore.getSnapshot().nodes!.filter((node) => ids.has(node.id)), bounds = selectionBounds(nodes)
  documentStore.beginInteraction()
  const patches = resizeSelection(nodes, bounds, bounds.width, bounds.height, 'se', true)
  documentStore.updateNodes(patches)
  const patch = patches.get(list.id)!
  documentStore.resizeList(list.id, patch.width!, patch.height!)
  updateMembership(ids)
  documentStore.endInteraction()
  const resized = documentStore.getNode(list.id) as GroupNode
  assert.equal(resized.width, list.width * 2)
  assert.equal(resized.minHeight, list.height * 2)
  assert.deepEqual(resized.memberIds, ['a', 'b'])
  assert.equal(documentStore.getNode('a')!.width, resized.width - 32)
  documentStore.undo()
  assert.deepEqual(documentStore.toJSON(), before)
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
  assert.equal(env.selectionOutline, true)
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
  assert.equal(env.selectionOutline, true)
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
  assert.equal(env.selectionOutline, false)
})

test('paint selection clears a previous Shift outline and moving that selection keeps paint highlighting', () => {
  documentStore.load({ nodes: [card('a', 100, 100), card('b', 300, 100)] })
  const env = environment(), state = new ToolState()
  env.selectionOutline = true
  tools.select.onPointerDown!(pointer(0, 130), env, state)
  assert.equal(state.dragging!.initialSelectionOutline, true)
  assert.equal(env.selectionOutline, false)
  tools.select.onPointerMove!(pointer(500, 130), env, state)
  tools.select.onPointerUp!(pointer(500, 130), env, state)
  assert.deepEqual([...env.selection], ['a', 'b'])
  assert.equal(env.selectionOutline, false)
  tools.select.onPointerDown!(pointer(110, 110, 'a'), env, state)
  assert.equal(env.selectionOutline, false)
  tools.select.onPointerUp!(pointer(110, 110), env, state)
  tools.select.onPointerDown!({ ...pointer(0, 0), shiftKey: true }, env, state)
  tools.select.onPointerUp!({ ...pointer(500, 200), shiftKey: true }, env, state)
  assert.equal(env.selectionOutline, true)
  tools.select.onPointerDown!(pointer(110, 110, 'a'), env, state)
  tools.select.onPointerUp!(pointer(110, 110), env, state)
  assert.equal(env.selectionOutline, true)
  assert.equal(SHORTCUTS.find((s) => s.id === 'box-select')!.label, '框选并显示整体缩放外框')
  assert.equal(SHORTCUTS.find((s) => s.id === 'box-select')!.keys, 'Shift + 拖动空白处')
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
  assert.equal(env.selectionOutline, false)
  assert.equal(marquee, null)
  assert.ok(trail)
  const shifted = { ...pointer(500, 320), shiftKey: true }
  tools.select.onPointerMove!(shifted, env, state)
  assert.deepEqual([...env.selection].sort(), ['a', 'photo', 'prior'])
  assert.equal(env.selectionOutline, true)
  assert.ok(marquee)
  assert.equal(trail, null)
  tools.select.onPointerMove!(pointer(500, 320), env, state)
  assert.deepEqual([...env.selection], ['photo'])
  assert.equal(env.selectionOutline, false)
  assert.equal(marquee, null)
  assert.ok(trail)
  tools.select.onPointerUp!(shifted, env, state)
  assert.deepEqual([...env.selection].sort(), ['a', 'photo', 'prior'])
  assert.equal(env.selectionOutline, true)
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
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() })
  const storage = new Map<string, string>()
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    get length() { return storage.size },
    key: (index: number) => [...storage.keys()][index] ?? null,
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  } })
  try {
    setActiveFile('recovery-test')
    documentStore.load({ nodes: [card('a')], meta: { name: 'Before' } })
    await saveLocal()
    assert.equal((await loadLocal())!.nodes!.length, 1)
    documentStore.load({ nodes: [], edges: [], meta: { name: 'Empty' } })
    saveRecovery()
    await initializeLocal()
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

test('viewport culling retains crossing images and nearby annotations across pan, zoom and resize', () => {
  const size = { width: 1000, height: 600 }
  for (const zoom of [0.2, 1, 3]) {
    const camera = { x: 400, y: -200, zoom }
    const world = (left: number, top: number, width: number, height: number) => ({ x: (left - camera.x) / zoom, y: (top - camera.y) / zoom, width: width / zoom, height: height / zoom })
    assert.equal(inViewport(world(100, 100, 300, 200), camera, size), true)
    assert.equal(inViewport(world(-2000, -2000, 4000, 4000), camera, size), true)
    assert.equal(inViewport(world(-150, 100, 1, 1), camera, size), true)
    assert.equal(inViewport(world(1100, 100, 100, 100), camera, size), true)
    assert.equal(inViewport(world(1200, 100, 100, 100), camera, size), false)
    assert.equal(inViewport(world(1200, 100, 100, 100), camera, { width: 1400, height: 600 }), true)
    assert.equal(inViewport(world(-300, 100, 100, 100), camera, size), false)
    assert.equal(inViewport(world(100, 800, 100, 100), camera, size), false)
    assert.equal(inViewport(world(100, -300, 100, 100), camera, size), false)
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

test('list creation preserves card content and image ratio, assigns one parent, and undoes together', () => {
  const photo: ImageNode = { id: 'photo', type: 'image', x: 400, y: 220, width: 200, height: 100, url: 'data:image/png;base64,AA' }
  documentStore.load({ nodes: [card('a', 100, 100), photo, { ...frame(['a']), width: 800, height: 500 }] })
  const before = documentStore.toJSON()
  const list = listFromSelection(new Set(['photo', 'a']))!
  const restored = documentStore.getNode(list.id) as GroupNode
  assert.equal(restored.layout, 'list')
  assert.deepEqual(restored.memberIds, ['a', 'photo'])
  assert.deepEqual((documentStore.getNode('group') as GroupNode).memberIds, [])
  const a = documentStore.getNode('a')!, image = documentStore.getNode('photo')!
  assert.equal(a.x, image.x)
  assert.equal(a.width, image.width)
  assert.equal(image.y, a.y + a.height + 12)
  assert.equal(image.width / image.height, 2)
  assert.equal((a as TextNode).text, 'a')
  assert.ok(restored.height >= image.y + image.height - restored.y + 16)
  assert.equal(restoreCanvas(documentStore.toJSON()).nodes!.find((n) => n.id === list.id)!.type, 'group')
  documentStore.undo()
  assert.deepEqual(documentStore.toJSON(), before)
  documentStore.redo()
  assert.equal((documentStore.getNode(list.id) as GroupNode).layout, 'list')
})

test('draw-list gesture creates a list around enclosed cards and rejects tiny gestures', () => {
  documentStore.load({ nodes: [card('a', 100, 100), card('outside', 700, 300)] })
  const env = environment(), state = new ToolState()
  documentStore.beginInteraction()
  tools.list.onPointerDown!(pointer(60, 60), env, state)
  tools.list.onPointerMove!(pointer(320, 240), env, state)
  tools.list.onPointerUp!(pointer(320, 240), env, state)
  documentStore.endInteraction()
  const list = documentStore.getNode([...env.selection][0]) as GroupNode
  assert.equal(list.layout, 'list')
  assert.deepEqual(list.memberIds, ['a'])
  assert.equal(state.dragging, null)
  documentStore.undo()
  assert.equal(documentStore.getNode(list.id), undefined)
  tools.list.onPointerDown!(pointer(0, 0), env, state)
  tools.list.onPointerMove!(pointer(5, 5), env, state)
  tools.list.onPointerUp!(pointer(5, 5), env, state)
  assert.equal(documentStore.getSnapshot().nodes!.length, 2)
})

test('dropping into lists uses the pointer, supports reordering and drag-out, and preserves undo', () => {
  documentStore.load({ nodes: [card('a', 400, 40), card('b', 400, 180)] })
  const list = createList({ x: 0, y: 0, width: 200, height: 200 })
  const move = (id: string, x: number, y: number) => {
    const n = documentStore.getNode(id)!, env = environment(new Set([id])), state = new ToolState()
    documentStore.beginInteraction()
    tools.select.onPointerDown!(pointer(n.x + 10, n.y + 10, id), env, state)
    tools.select.onPointerMove!(pointer(x, y), env, state)
    tools.select.onPointerUp!(pointer(x, y), env, state)
    documentStore.endInteraction()
  }
  move('a', 5, 55) // Only the pointer, not the full card, needs to be inside.
  assert.deepEqual((documentStore.getNode(list.id) as GroupNode).memberIds, ['a'])
  move('b', 50, 120)
  assert.deepEqual((documentStore.getNode(list.id) as GroupNode).memberIds, ['a', 'b'])
  move('b', 50, 45)
  assert.deepEqual((documentStore.getNode(list.id) as GroupNode).memberIds, ['b', 'a'])
  const before = documentStore.toJSON()
  move('b', 600, 500)
  assert.deepEqual((documentStore.getNode(list.id) as GroupNode).memberIds, ['a'])
  documentStore.undo()
  assert.deepEqual(documentStore.toJSON(), before)
  move('b', 600, 500)
  assert.equal(documentStore.getNode('a')!.y, 44)
})

test('moving a list keeps all members and cancellation restores all geometry', () => {
  documentStore.load({ nodes: [card('a', 40, 100), card('b', 40, 200)] })
  const list = listFromSelection(new Set(['a', 'b']))!, before = documentStore.toJSON()
  const env = environment(new Set([list.id])), state = new ToolState()
  documentStore.beginInteraction()
  tools.select.onPointerDown!(pointer(list.x + 5, list.y + 5, list.id), env, state)
  tools.select.onPointerMove!(pointer(list.x + 305, list.y + 205), env, state)
  tools.select.onPointerUp!(pointer(list.x + 305, list.y + 205), env, state)
  documentStore.endInteraction()
  assert.deepEqual((documentStore.getNode(list.id) as GroupNode).memberIds, ['a', 'b'])
  assert.equal(documentStore.getNode('a')!.x, before.nodes!.find((n) => n.id === 'a')!.x + 300)
  documentStore.undo()
  assert.deepEqual(documentStore.toJSON(), before)
  documentStore.beginInteraction()
  tools.select.onPointerDown!(pointer(list.x + 5, list.y + 5, list.id), env, state)
  tools.select.onPointerMove!(pointer(list.x + 405, list.y + 105), env, state)
  documentStore.cancelInteraction()
  state.dragging = null
  assert.deepEqual(documentStore.toJSON(), before)
})

test('list reflows after text growth, image decode and deletion without extra image undo steps', () => {
  documentStore.load({ nodes: [card('a', 40, 100), { id: 'photo', type: 'image', x: 40, y: 200, width: 280, height: 180, url: '' }] })
  const list = listFromSelection(new Set(['a', 'photo']))!
  documentStore.updateTextLayout('a', 160)
  const a = documentStore.getNode('a')!
  assert.equal(documentStore.getNode('photo')!.y, a.y + 160 + 12)
  documentStore.initializeImage('photo', 1000, 500)
  const image = documentStore.getNode('photo')!
  assert.equal(image.width / image.height, 2)
  const height = documentStore.getNode(list.id)!.height
  documentStore.deleteNode('a')
  assert.equal(documentStore.getNode('photo')!.y, list.y + 44)
  assert.ok(documentStore.getNode(list.id)!.height < height)
  documentStore.undo()
  assert.equal(documentStore.getNode('photo')!.y, a.y + 160 + 12)
})

test('list duplicate and clipboard remap members and retain layout, dissolution keeps cards', () => {
  documentStore.load({ nodes: [card('a', 20, 100), card('b', 20, 200)] })
  const list = listFromSelection(new Set(['a', 'b']))!
  const copied = copySelection(new Set([list.id]))!
  const duplicate = documentStore.getNode([...duplicateNodes(new Set([list.id]))][0]) as GroupNode
  assert.equal(duplicate.layout, 'list')
  assert.ok(duplicate.memberIds!.every((id) => !['a', 'b'].includes(id)))
  const pasted = documentStore.getNode([...pasteSelection(copied, { x: 800, y: 200 })][0]) as GroupNode
  assert.equal(pasted.layout, 'list')
  const members = [...pasted.memberIds!]
  const next = ungroupNodes(new Set([pasted.id]))
  assert.deepEqual([...next], members)
  assert.equal(documentStore.getNode(pasted.id), undefined)
  assert.ok(members.every((id) => documentStore.getNode(id)))
  documentStore.undo()
  assert.equal((documentStore.getNode(pasted.id) as GroupNode).layout, 'list')
})

test('quick arrange uses a fixed gap with top alignment in rows and left alignment in columns', () => {
  const nodes = [card('a', 20, 60), { ...card('b', 300, 180), width: 160, height: 100 }, card('c', 600, 400)]
  for (const mode of ['horizontal', 'vertical'] as const) {
    const result = arrangement(nodes, mode)
    const axis = mode === 'horizontal' ? 'x' : 'y', cross = mode === 'horizontal' ? 'y' : 'x'
    const dimension = mode === 'horizontal' ? 'width' : 'height'
    nodes.forEach((node, index) => {
      assert.equal(result.get(node.id)![cross], mode === 'horizontal' ? 60 : 20)
      if (index) assert.equal(result.get(node.id)![axis]! - result.get(nodes[index - 1].id)![axis]! - nodes[index - 1][dimension], ARRANGE_GAP)
    })
  }
  const overlapping = arrangement([card('b', 21, 22), card('a', 20, 20)], 'horizontal')
  assert.equal(overlapping.get('b')!.x, 120 + ARRANGE_GAP)
  assert.equal(arrangement([nodes[0]], 'vertical').size, 0)
  documentStore.load({ nodes })
  const before = documentStore.toJSON()
  arrangeNodes(new Set(['a', 'b', 'c']), 'vertical')
  assert.equal(documentStore.getNode('a')!.x, documentStore.getNode('b')!.x)
  documentStore.undo()
  assert.deepEqual(documentStore.toJSON(), before)
})

test('list resize reflows its members during the drag, preserves manual height and supports cancel and undo', () => {
  const store = new DocumentStore()
  store.load({ nodes: [
    { ...frame(['a', 'photo']), layout: 'list' },
    card('a'),
    { id: 'photo', type: 'image', x: 0, y: 0, width: 200, height: 100, url: 'data:image/png;base64,AA' },
  ] })
  const before = store.toJSON()
  store.beginInteraction()
  store.resizeList('group', 480, 600)
  assert.equal(store.getNode('group')!.width, 480)
  assert.equal(store.getNode('group')!.height, 600)
  assert.equal(store.getNode('a')!.width, 448)
  assert.equal(store.getNode('photo')!.width, 448)
  assert.equal(store.getNode('photo')!.height, 224)
  assert.equal(store.getNode('photo')!.y, 44 + 60 + 12)
  store.endInteraction()
  const resized = store.toJSON()
  store.undo()
  assert.deepEqual(store.toJSON(), before)
  store.redo()
  assert.deepEqual(store.toJSON(), resized)
  store.beginInteraction()
  store.resizeList('group', 180, 180)
  store.cancelInteraction()
  assert.deepEqual(store.toJSON(), resized)
  store.load(resized)
  assert.equal(store.getNode('group')!.height, 600)
  store.resizeList('group', 1, 1)
  assert.equal(store.getNode('group')!.width, 160)
  assert.ok(store.getNode('group')!.height >= store.getNode('photo')!.y + store.getNode('photo')!.height + 16)
  store.updateTextLayout('a', 180)
  assert.equal(store.getNode('photo')!.y, 44 + 180 + 12)
  store.updateTextLayout('a', 48)
  assert.equal(store.getNode('a')!.height, 48)
  assert.equal(store.getNode('photo')!.y, 44 + 48 + 12)
})

test('fitting text inside a list preserves the original card height when undoing list creation', () => {
  const store = new DocumentStore()
  store.load({ nodes: [{ ...card('a'), width: 128 }] })
  store.addNode({ ...frame(['a']), layout: 'list', width: 160 })
  store.updateTextLayout('a', 48)
  assert.equal(store.getNode('a')!.height, 48)
  store.undo()
  assert.equal(store.getNode('a')!.height, 60)
  assert.equal(store.getNode('group'), undefined)
})

test('moving cards between two lists removes old membership and only inserts once', () => {
  documentStore.load({ nodes: [card('a', 400, 200)] })
  const first = listFromSelection(new Set(['a']))!
  const second = createList({ x: 0, y: 0, width: 220, height: 180 })
  documentStore.transact(() => {
    documentStore.updateNode('a', { x: 16, y: 44 })
    updateMembership(['a'], { x: 30, y: 55 })
  })
  assert.deepEqual((documentStore.getNode(first.id) as GroupNode).memberIds, [])
  assert.deepEqual((documentStore.getNode(second.id) as GroupNode).memberIds, ['a'])
})

test('renaming preserves metadata, normalizes whitespace and is undoable', () => {
  const store = new DocumentStore()
  store.load({ nodes: [], meta: { name: '旧名字', camera: { x: 5, y: 10, zoom: 1 } } })
  store.rename('  灵感收集  ')
  assert.equal(store.getSnapshot().meta!.name, '灵感收集')
  assert.equal(store.getSnapshot().meta!.camera!.x, 5)
  store.undo()
  assert.equal(store.getSnapshot().meta!.name, '旧名字')
  store.rename('  ')
  assert.equal(store.getSnapshot().meta!.name, '未命名画布')
})

test('SVG export embeds cropped images, escapes text and includes only selected internal connections', async () => {
  const a = { ...card('a', -200, -100), text: '<hello> & "world"' }
  const photo: ImageNode = { id: 'photo', type: 'image', x: 10, y: 20, width: 100, height: 60, url: 'data:image/png;base64,AA', crop: { x: 0.25, y: 0, width: 0.5, height: 1 } }
  const doc = { nodes: [a, photo, card('outside', 600, 600)], edges: [{ id: 'internal', fromNode: 'a', toNode: 'photo' }, { id: 'external', fromNode: 'photo', toNode: 'outside' }] }
  documentStore.load(doc)
  const svg = await selectionSVG(doc, new Set(['a', 'photo']))
  assert.match(svg, /viewBox="-224 -140/)
  assert.match(svg, /&lt;hello&gt;/)
  assert.match(svg, /data:image\/png;base64,AA/)
  assert.match(svg, /x="-50" y="0" width="200"/)
  assert.equal((svg.match(/stroke-width="4"/g) ?? []).length, 1)
  assert.doesNotMatch(svg, /outside/)
  await assert.rejects(selectionSVG({ nodes: [] }), /没有可导出/)
})

test('shortcut registry has unique entries for list, SVG copy and file and view commands', () => {
  assert.equal(SHORTCUTS.find((s) => s.id === 'open')!.label, '打开白板')
  assert.equal(SHORTCUTS.find((s) => s.id === 'open')!.keys, 'Mod + O')
  assert.equal(new Set(SHORTCUTS.map((s) => s.id)).size, SHORTCUTS.length)
  for (const id of ['list', 'copy-svg', 'save', 'open', 'media', 'fit', 'reset-zoom', 'toggle-ui', 'cut']) assert.ok(SHORTCUTS.some((s) => s.id === id))
  assert.equal(SHORTCUTS.find((s) => s.id === 'copy-svg')!.keys, 'Mod + Shift + C')
})

test('pending saves retain the source file and snapshot when another file becomes active', async () => {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() })
  const storage = new Map<string, string>(), previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    get length() { return storage.size },
    key: (index: number) => [...storage.keys()][index] ?? null,
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  } })
  try {
    setActiveFile('save-source')
    documentStore.load({ nodes: [card('source')], meta: { name: '源文件' } })
    const saving = saveLocal()
    setActiveFile('save-destination')
    documentStore.load({ nodes: [card('destination')], meta: { name: '目标文件' } })
    await saving
    await saveLocal()
    assert.equal((await loadLocal('save-source'))!.meta!.name, '源文件')
    assert.equal((await loadLocal('save-source'))!.nodes![0].id, 'source')
    assert.equal((await loadLocal('save-destination'))!.nodes![0].id, 'destination')
  } finally {
    if (previous === undefined) delete (globalThis as any).localStorage
    else Object.defineProperty(globalThis, 'localStorage', previous)
  }
})

test('file library migrates content, manages independent boards, and flattens legacy projects without losing files', async () => {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() })
  const storage = new Map<string, string>(), previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const subscribe = documentStore.subscribe, subscriptions: (() => void)[] = []
  documentStore.subscribe = (listener) => { const unsubscribe = subscribe(listener); subscriptions.push(unsubscribe); return unsubscribe }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    get length() { return storage.size },
    key: (index: number) => [...storage.keys()][index] ?? null,
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  } })
  try {
    setActiveFile('legacy-library-test')
    documentStore.load({ nodes: [card('legacy')], meta: { name: '原有白板' } })
    await saveLocal()
    const library = new LibraryStore()
    await Promise.all([library.initialize(), library.initialize()])
    const initial = library.getSnapshot(), first = initial.files[0]
    assert.equal(initial.files.length, 1)
    assert.equal(first.name, '原有白板')
    assert.equal(documentStore.getNode('legacy')!.type, 'text')
    const second = (await library.createFile('第二份白板'))!
    assert.equal(documentStore.getSnapshot().nodes!.length, 0)
    documentStore.addNode(card('second-content'))
    documentStore.rename('修改后的白板')
    cameraStore.set({ x: 120, y: -40, zoom: 0.7 })
    assert.equal(library.getSnapshot().files.find((file) => file.id === second.id)!.name, '修改后的白板')
    await library.switchFile(first.id)
    assert.ok(documentStore.getNode('legacy'))
    assert.equal(documentStore.getNode('second-content'), undefined)
    await library.switchFile(second.id)
    assert.ok(documentStore.getNode('second-content'))
    assert.deepEqual(cameraStore.getSnapshot(), { x: 120, y: -40, zoom: 0.7 })
    const imported = (await library.createFile('导入白板', { nodes: [card('imported')], meta: { camera: { x: 40, y: 50, zoom: 1.2 } } }))!
    assert.equal(documentStore.getSnapshot().meta!.name, '导入白板')
    assert.ok(documentStore.getNode('imported'))
    assert.deepEqual(cameraStore.getSnapshot(), { x: 40, y: 50, zoom: 1.2 })
    assert.ok(library.getSnapshot().files.some((file) => file.id === imported.id))
    await library.switchFile(first.id)
    assert.ok(documentStore.getNode('legacy'))
    const activeBefore = documentStore.toJSON(), cameraBefore = cameraStore.getSnapshot()
    await library.renameFile(second.id, '后台重命名')
    assert.deepEqual(documentStore.toJSON(), activeBefore)
    assert.deepEqual(cameraStore.getSnapshot(), cameraBefore)
    assert.equal((await loadLocal(second.id))!.meta!.name, '后台重命名')
    const duplicate = (await library.duplicateFile(second.id))!
    assert.equal(documentStore.getSnapshot().meta!.name, '后台重命名 副本')
    assert.ok(documentStore.getNode('second-content'))
    assert.deepEqual(cameraStore.getSnapshot(), { x: 120, y: -40, zoom: 0.7 })
    documentStore.updateNode('second-content', { text: '只修改副本' })
    await library.switchFile(second.id)
    assert.equal((documentStore.getNode('second-content') as TextNode).text, 'second-content')
    library.togglePin(imported.id)
    assert.equal(library.getSnapshot().files[0].id, imported.id)
    assert.equal(JSON.parse(storage.get(LIBRARY_KEY)!).files[0].pinned, true)
    library.togglePin(imported.id)
    assert.equal(library.getSnapshot().files[0].pinned, false)
    await library.deleteFile(duplicate.id)
    assert.equal(library.getSnapshot().activeFileId, second.id)
    assert.equal(await loadLocal(duplicate.id), null)
    await library.deleteFile(second.id)
    assert.equal(library.getSnapshot().activeFileId, imported.id)
    assert.ok(documentStore.getNode('imported'))
    assert.equal(await loadLocal(second.id), null)
    subscriptions.splice(0).forEach((unsubscribe) => unsubscribe())
    const reopened = new LibraryStore()
    await reopened.initialize()
    assert.equal(reopened.getSnapshot().activeFileId, imported.id)
    assert.equal(documentStore.getSnapshot().meta!.name, '导入白板')
    await reopened.deleteFile(first.id)
    await reopened.deleteFile(imported.id)
    const fresh = reopened.getSnapshot().files[0]
    assert.equal(reopened.getSnapshot().files.length, 1)
    assert.notEqual(fresh.id, imported.id)
    assert.equal(documentStore.getSnapshot().nodes!.length, 0)
    assert.ok(await loadLocal(fresh.id))
    subscriptions.splice(0).forEach((unsubscribe) => unsubscribe())
    await saveCanvas('legacy-one', { nodes: [card('project-one-card')], meta: { name: '项目一白板' } })
    await saveCanvas('legacy-two', { nodes: [card('project-two-card')], meta: { name: '项目二白板' } })
    storage.set(LIBRARY_KEY, JSON.stringify({
      projects: [{ id: 'p1', name: '项目一' }, { id: 'p2', name: '项目二' }],
      files: [{ id: 'legacy-one', name: '项目一白板', projectId: 'p1' }, { id: 'legacy-two', name: '项目二白板', projectId: 'p2', pinned: true }],
      activeFileId: 'legacy-one',
    }))
    const migrated = new LibraryStore()
    await migrated.initialize()
    assert.deepEqual(migrated.getSnapshot().files.slice(0, 2).map((file) => file.id), ['legacy-two', 'legacy-one'])
    assert.ok(migrated.getSnapshot().files.some((file) => file.id === fresh.id))
    assert.equal(JSON.parse(storage.get(LIBRARY_KEY)!).projects, undefined)
    assert.ok(migrated.getSnapshot().files.every((file) => !('projectId' in file)))
    await migrated.switchFile('legacy-two')
    assert.ok(documentStore.getNode('project-two-card'))
    await migrated.switchFile('legacy-one')
    assert.ok(documentStore.getNode('project-one-card'))
    const pendingSave = saveLocal()
    await deleteLocalFile('legacy-one')
    await pendingSave
    await saveLocal()
    saveRecovery()
    assert.equal(await loadLocal('legacy-one'), null)
  } finally {
    subscriptions.forEach((unsubscribe) => unsubscribe())
    documentStore.subscribe = subscribe
    if (previous === undefined) delete (globalThis as any).localStorage
    else Object.defineProperty(globalThis, 'localStorage', previous)
  }
})
