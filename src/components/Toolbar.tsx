import { useRef, useState } from 'react'
import { exportCanvasFile, importCanvasFile, saveLocal } from '../persistence'
import { documentStore } from '../store/document'
import { createImageCard, viewportCenterWorld, type ToolId } from '../tools/tools'

const TOOLS: { id: ToolId; label: string; key: string }[] = [
  { id: 'select', label: '选择', key: 'V' },
  { id: 'hand', label: '抓手', key: 'H / 按住空格' },
  { id: 'card', label: '卡片', key: 'C' },
  { id: 'connect', label: '连线', key: 'L' },
  { id: 'box', label: '分组', key: 'B' },
  { id: 'draw', label: '手绘', key: 'D' },
]

function addImageAtViewportCenter(url: string) {
  createImageCard(viewportCenterWorld(), url)
}

export function Toolbar(props: { tool: ToolId; setTool: (t: ToolId) => void }) {
  const [imageOpen, setImageOpen] = useState(false)
  const [imageUrl, setImageUrl] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const submitUrl = () => {
    const url = imageUrl.trim()
    if (!url) return
    addImageAtViewportCenter(url)
    setImageUrl('')
    setImageOpen(false)
  }

  const onPickFile = (f: File | undefined) => {
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') addImageAtViewportCenter(reader.result)
    }
    reader.readAsDataURL(f)
    setImageOpen(false)
  }

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
      <div className="toolbar-image">
        <button className="tool" title="添加图片卡片" onClick={() => setImageOpen((v) => !v)}>
          图片
        </button>
        {imageOpen && (
          <div className="image-pop">
            <input
              type="text"
              value={imageUrl}
              placeholder="粘贴图片链接 https://…"
              onChange={(e) => setImageUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitUrl()
                if (e.key === 'Escape') setImageOpen(false)
              }}
            />
            <button onClick={submitUrl}>添加</button>
            <button onClick={() => fileRef.current?.click()}>本地上传</button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => onPickFile(e.target.files?.[0])}
            />
          </div>
        )}
      </div>
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
