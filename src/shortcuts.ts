// Canonical shortcut list. Keep this in sync with handlers whenever bindings change.
export const SHORTCUTS = [
  { id: 'select', group: '工具', label: '选择', keys: 'V / 1' },
  { id: 'hand', group: '工具', label: '平移', keys: 'H / 2' },
  { id: 'box', group: '工具', label: '分组框', keys: 'B / 3' },
  { id: 'draw', group: '工具', label: '自由手绘', keys: 'D / 4' },
  { id: 'list', group: '工具', label: '绘制列表', keys: 'L' },
  { id: 'text', group: '工具', label: '新建文本块', keys: 'T / 双击空白' },
  { id: 'pan', group: '画布', label: '临时平移', keys: '按住空格拖动 / 鼠标中键拖动' },
  { id: 'zoom', group: '画布', label: '缩放', keys: 'Mod + 滚轮' },
  { id: 'fit', group: '画布', label: '缩放至全部内容', keys: 'Shift + 1' },
  { id: 'reset-zoom', group: '画布', label: '缩放至 100%', keys: 'Shift + 0' },
  { id: 'toggle-ui', group: '画布', label: '显示 / 隐藏界面', keys: 'Mod + \\' },
  { id: 'undo', group: '编辑', label: '撤销', keys: 'Mod + Z' },
  { id: 'redo', group: '编辑', label: '重做', keys: 'Mod + Shift + Z / Mod + Y' },
  { id: 'copy', group: '编辑', label: '复制', keys: 'Mod + C' },
  { id: 'cut', group: '编辑', label: '剪切', keys: 'Mod + X' },
  { id: 'paste', group: '编辑', label: '粘贴', keys: 'Mod + V' },
  { id: 'copy-svg', group: '编辑', label: '复制为 SVG', keys: 'Mod + Shift + C' },
  { id: 'duplicate', group: '编辑', label: '创建副本', keys: 'Mod + D' },
  { id: 'select-all', group: '编辑', label: '全选', keys: 'Mod + A' },
  { id: 'group', group: '编辑', label: '组合', keys: 'Mod + G' },
  { id: 'ungroup', group: '编辑', label: '取消组合 / 解散列表', keys: 'Mod + Shift + G' },
  { id: 'delete', group: '编辑', label: '删除', keys: 'Delete / Backspace' },
  { id: 'edit', group: '编辑', label: '编辑文字 / 裁剪图片', keys: 'Enter' },
  { id: 'nudge', group: '编辑', label: '移动选中内容', keys: '方向键 / Shift + 方向键（10px）' },
  { id: 'multi-select', group: '选择', label: '追加 / 取消选择', keys: 'Shift + 点击' },
  { id: 'box-select', group: '选择', label: '框选', keys: 'Shift + 拖动空白处' },
  { id: 'resize', group: '编辑', label: '切换自由 / 等比缩放', keys: 'Shift + 拖动缩放手柄' },
  { id: 'open-link', group: '文字编辑', label: '打开文字中的链接', keys: 'Mod + 点击链接' },
  { id: 'cancel', group: '选择', label: '取消操作 / 关闭菜单', keys: 'Esc' },
  { id: 'save', group: '文件', label: '保存到本地', keys: 'Mod + S' },
  { id: 'open', group: '文件', label: '打开 .canvas', keys: 'Mod + O' },
  { id: 'media', group: '文件', label: '插入媒体文件', keys: 'Mod + Shift + K' },
  { id: 'shortcuts', group: '文件', label: '键盘快捷方式', keys: '?' },
  { id: 'continue-list', group: '文字编辑', label: '继续列表 / 换行', keys: 'Enter' },
  { id: 'undo-text', group: '文字编辑', label: '撤销 / 重做文字', keys: 'Mod + Z / Mod + Shift + Z' },
  { id: 'finish-edit', group: '文字编辑', label: '完成编辑', keys: 'Mod + Enter / Esc' },
] as const

export function shortcut(id: string) {
  const keys = SHORTCUTS.find((item) => item.id === id)?.keys ?? ''
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
  return keys.split(' / ')[0].replace(/Mod/g, mac ? '⌘' : 'Ctrl').replace(/Shift/g, '⇧').replace(/ \+ /g, ' ')
}

export type BoardCommand = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'duplicate' | 'delete' | 'select-all' | 'group' | 'ungroup' | 'fit' | 'reset-zoom' | 'toggle-ui' | 'shortcuts' | 'export-svg' | 'export-png' | 'copy-svg' | 'copy-png' | 'text'
export function runBoardCommand(command: BoardCommand) {
  window.dispatchEvent(new CustomEvent('see-command', { detail: command }))
}
