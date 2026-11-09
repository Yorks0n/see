import { useEffect, useState } from 'react'
import { Board } from './components/Board'
import { Toolbar } from './components/Toolbar'
import { loadLocal } from './persistence'
import { cameraStore } from './store/camera'
import { documentStore } from './store/document'
import type { ToolId } from './tools/tools'

export default function App() {
  const [tool, setTool] = useState<ToolId>('select')

  useEffect(() => {
    void loadLocal().then((doc) => {
      if (doc && (doc.nodes?.length ?? 0) > 0) {
        documentStore.load(doc)
        if (doc.meta?.camera) cameraStore.set(doc.meta.camera)
      } else {
        documentStore.load({
          nodes: [
            {
              id: 'welcome',
              type: 'text',
              x: 120,
              y: 100,
              width: 320,
              height: 120,
              text: '欢迎使用白板 👋\n\n双击空白处新建卡片，滚轮缩放，中键拖动平移。数据自动保存，可导出 .canvas 文件。',
            },
          ],
          edges: [],
          meta: { name: '我的白板' },
        })
      }
    })
  }, [])

  return (
    <div className="app">
      <Toolbar tool={tool} setTool={setTool} />
      <Board tool={tool} setTool={setTool} />
    </div>
  )
}
