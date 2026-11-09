import { exportCanvasFile, importCanvasFile, saveLocal } from '../persistence'
import { documentStore } from '../store/document'
import type { ToolId } from '../tools/tools'

const TOOLS: { id: ToolId; label: string; key: string }[] = [
  { id: 'select', label: '选择', key: 'V' },
  { id: 'hand', label: '抓手', key: 'H' },
  { id: 'card', label: '卡片', key: 'C' },
  { id: 'connect', label: '连线', key: 'L' },
  { id: 'box', label: '分组', key: 'B' },
  { id: 'draw', label: '手绘', key: 'D' },
]

export function Toolbar(props: { tool: ToolId; setTool: (t: ToolId) => void }) {
  return (
    <div className="toolbar">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          className={props.tool === t.id ? 'tool active' : 'tool'}
          title={`${t.label} (${t.key})`}
          onClick={() => props.setTool(t.id)}
        >
          {t.label}
        </button>
      ))}
      <span className="toolbar-sep" />
      <button
        className="tool"
        title="导出 .canvas 文件"
        onClick={() => {
          void saveLocal()
          exportCanvasFile()
        }}
      >
        导出
      </button>
      <button
        className="tool"
        title="导入 .canvas 文件"
        onClick={() => {
          const input = document.createElement('input')
          input.type = 'file'
          input.accept = '.canvas,application/json'
          input.onchange = () => {
            const f = input.files?.[0]
            if (f) void importCanvasFile(f).then((doc) => documentStore.load(doc))
          }
          input.click()
        }}
      >
        导入
      </button>
    </div>
  )
}
