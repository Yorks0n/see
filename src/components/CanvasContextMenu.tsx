import { documentStore } from '../store/document'
import { arrangeNodes, createList, listFromSelection, ungroupNodes } from '../tools/tools'
import { downloadOriginal } from '../tools/export'
import { shortcut, type BoardCommand } from '../shortcuts'
import type { DrawPoint, ImageNode } from '../types'
import { MenuItems, PopupMenu, type MenuItem } from './Menu'

export interface ContextTarget { x: number; y: number; world: DrawPoint; nodeId?: string; edgeId?: string }
export function CanvasContextMenu({ target, selection, onClose, onCommand, setSelection, onEdit, onCrop, onError }: {
  target: ContextTarget; selection: Set<string>; onClose: () => void
  onCommand: (command: BoardCommand, origin?: DrawPoint) => void
  setSelection: (ids: Set<string>) => void; onEdit: (id: string) => void; onCrop: (id: string) => void; onError: (message: string) => void
}) {
  const node = target.nodeId ? documentStore.getNode(target.nodeId) : undefined
  const edge = target.edgeId ? documentStore.getEdge(target.edgeId) : undefined
  const command = (label: string, id: BoardCommand, disabled = false): MenuItem => ({ label, shortcut: shortcut(id), action: () => onCommand(id, target.world), disabled })
  let items: (MenuItem | null)[]
  let label = '画布菜单'
  if (edge) {
    label = '连接菜单'
    items = [
      { label: '编辑连接名称', action: () => { document.querySelector<HTMLInputElement>('.edge-heading input')?.focus() } },
      { label: edge.lineStyle === 'straight' ? '改为曲线' : '改为直线', action: () => documentStore.updateEdge(edge.id, { lineStyle: edge.lineStyle === 'straight' ? 'curve' : 'straight' }) },
      { label: edge.toEnd === 'arrow' ? '隐藏连接方向' : '显示连接方向', action: () => documentStore.updateEdge(edge.id, { toEnd: edge.toEnd === 'arrow' ? 'none' : 'arrow' }) },
      { label: '反转连接方向', action: () => documentStore.updateEdge(edge.id, { fromNode: edge.toNode, fromSide: edge.toSide, toNode: edge.fromNode, toSide: edge.fromSide }) },
      { label: edge.labelIsVisible === false ? '显示标签' : '隐藏标签', action: () => documentStore.updateEdge(edge.id, { labelIsVisible: edge.labelIsVisible === false }) },
      null, { ...command('删除连接', 'delete'), danger: true },
    ]
  } else if (node) {
    const one = selection.size === 1
    label = one ? ({ text: '文本菜单', image: '图片菜单', group: node.type === 'group' && node.layout === 'list' ? '列表菜单' : '分组菜单', draw: '笔迹菜单', rectangle: '矩形菜单', file: '文件块菜单', link: '链接菜单' })[node.type] : '多选菜单'
    items = [command('剪切', 'cut'), command('复制', 'copy'), command('创建副本', 'duplicate'), null]
    if (one && node.type === 'text') items.push({ label: '编辑文字', shortcut: shortcut('edit'), action: () => onEdit(node.id) })
    if (one && node.type === 'image') items.push(
      { label: '裁剪图片', shortcut: shortcut('edit'), action: () => onCrop(node.id) },
      { label: '编辑图片说明', action: () => onEdit(node.id) },
    )
    if (one && node.type === 'group') items.push({ label: '重命名', action: () => onEdit(node.id) }, { label: node.layout === 'list' ? '解散列表' : '取消组合', shortcut: shortcut('ungroup'), action: () => setSelection(ungroupNodes(selection)) })
    if (one && node.type === 'draw') items.push(...[2, 4, 8].map((width) => ({ label: `笔画粗细 ${width}`, action: () => documentStore.updateNode(node.id, { strokeWidth: width }) })))
    if (!one && [...selection].every((id) => ['text', 'image'].includes(documentStore.getNode(id)?.type ?? ''))) items.push(
      { label: '水平等间距 · 顶部对齐', action: () => arrangeNodes(selection, 'horizontal') }, { label: '垂直等间距 · 左侧对齐', action: () => arrangeNodes(selection, 'vertical') },
      { label: '转换为列表', action: () => { const list = listFromSelection(selection); if (list) setSelection(new Set([list.id])) } },
      command('组合', 'group'),
    )
    const formats: MenuItem[] = !one || node.type === 'text' || node.type === 'image' ? [
      { label: '复制为', items: [command('SVG', 'copy-svg'), command('PNG', 'copy-png')] },
      { label: '导出为', items: [command('SVG', 'export-svg'), command('PNG', 'export-png')] },
    ] : [command('复制为 SVG', 'copy-svg'), command('复制为 PNG', 'copy-png'), command('导出为 SVG', 'export-svg'), command('导出为 PNG', 'export-png')]
    if (one && node.type === 'image') formats.push({ label: '下载原图', action: () => { void downloadOriginal(node as ImageNode).catch((error: Error) => onError(error.message)) } })
    items.push(null, ...formats, null,
      { label: '置于顶层', action: () => documentStore.transact(() => (documentStore.getSnapshot().nodes ?? []).filter((n) => selection.has(n.id)).forEach((n) => documentStore.bringToFront(n.id))) },
      { label: '置于底层', action: () => documentStore.transact(() => [...(documentStore.getSnapshot().nodes ?? [])].reverse().filter((n) => selection.has(n.id)).forEach((n) => documentStore.sendToBack(n.id))) },
      null, { ...command('删除', 'delete'), danger: true })
  } else {
    items = [
      command('新建文本块', 'text'),
      { label: '新建列表', action: () => { const list = createList({ ...target.world, width: 280, height: 180 }); setSelection(new Set([list.id])) } },
      command('粘贴', 'paste'), null, command('全选', 'select-all'),
      command('撤销', 'undo', !documentStore.canUndo), command('重做', 'redo', !documentStore.canRedo),
      null, command('缩放至全部内容', 'fit'), command('缩放至 100%', 'reset-zoom'), command('键盘快捷方式', 'shortcuts'),
    ]
  }
  return <PopupMenu label={label} position={target} onClose={onClose}><MenuItems items={items} onChoose={onClose} /></PopupMenu>
}
