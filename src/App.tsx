import { useEffect, useState, useSyncExternalStore } from 'react'
import { Board } from './components/Board'
import { Toolbar } from './components/Toolbar'
import { libraryStore } from './store/library'
import type { ToolId } from './tools/tools'

export default function App() {
  const [tool, setTool] = useState<ToolId>('select')
  const [newNodeId, setNewNodeId] = useState<string | null>(null)
  const [uiVisible, setUiVisible] = useState(true)
  const library = useSyncExternalStore(libraryStore.subscribe, libraryStore.getSnapshot)
  const [error, setError] = useState('')

  useEffect(() => {
    void libraryStore.initialize().catch((error: Error) => setError(error.message))
  }, [])
  useEffect(() => { setNewNodeId(null); setTool('select') }, [library.activeFileId])

  if (!library.ready) return <div className="app-loading" role="status">{error || '正在打开白板…'}</div>
  return (
    <div className={`app ${uiVisible ? '' : 'ui-hidden'}`}>
      <Toolbar tool={tool} setTool={setTool} onSelectNode={setNewNodeId} />
      <Board key={library.activeFileId} tool={tool} setTool={setTool} newNodeId={newNodeId} uiVisible={uiVisible} onToggleUI={() => setUiVisible((visible) => !visible)} />
    </div>
  )
}
