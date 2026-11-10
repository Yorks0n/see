import { useEffect, useState } from 'react'
import { Board } from './components/Board'
import { Toolbar } from './components/Toolbar'
import { loadLocal } from './persistence'
import { cameraStore } from './store/camera'
import { documentStore } from './store/document'
import type { ToolId } from './tools/tools'

export default function App() {
  const [tool, setTool] = useState<ToolId>('select')
  const [newNodeId, setNewNodeId] = useState<string | null>(null)
  const [uiVisible, setUiVisible] = useState(true)

  useEffect(() => {
    void loadLocal().then((doc) => {
      if (doc) {
        documentStore.load(doc)
        if (doc.meta?.camera) cameraStore.set(doc.meta.camera)
      } else {
        documentStore.load({
          nodes: [],
          edges: [],
          meta: { name: '我的白板' },
        })
      }
    })
  }, [])

  return (
    <div className={`app ${uiVisible ? '' : 'ui-hidden'}`}>
      <Toolbar tool={tool} setTool={setTool} onSelectNode={setNewNodeId} />
      <Board tool={tool} setTool={setTool} newNodeId={newNodeId} uiVisible={uiVisible} onToggleUI={() => setUiVisible((visible) => !visible)} />
    </div>
  )
}
