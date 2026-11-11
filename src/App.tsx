import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Board } from './components/Board'
import { Toolbar } from './components/Toolbar'
import { libraryStore } from './store/library'
import type { ToolId } from './tools/tools'
import { localRepository, persistenceStore } from './persistence'
import { documentStore } from './store/document'
import { startCloudSync } from './sync/cloud'

export default function App() {
  const [tool, setTool] = useState<ToolId>('select')
  const [newNodeId, setNewNodeId] = useState<string | null>(null)
  const [uiVisible, setUiVisible] = useState(true)
  const library = useSyncExternalStore(libraryStore.subscribe, libraryStore.getSnapshot)
  const [error, setError] = useState('')
  const appRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void libraryStore.initialize().catch((error: Error) => setError(error.message))
  }, [])
  useEffect(() => { setNewNodeId(null); setTool('select') }, [library.activeFileId])
  useEffect(() => {
    if (!library.ready) return
    return startCloudSync(localRepository,
      () => !libraryStore.getSnapshot().busy && !documentStore.isInteracting && persistenceStore.getSnapshot().state === 'saved',
      (action) => libraryStore.applyCloudChange(action))
  }, [library.ready])
  useLayoutEffect(() => {
    // Do not accept edits to the old document while a file is being loaded.
    appRef.current?.toggleAttribute('inert', library.busy)
  }, [library.busy, library.ready])

  if (!library.ready) return <div className="app-loading" role="status">{error || '正在打开白板…'}{error && <button onClick={() => {
    setError('')
    void libraryStore.initialize().catch((error: Error) => setError(error.message))
  }}>重试</button>}</div>
  return (
    <div ref={appRef} className={`app ${uiVisible ? '' : 'ui-hidden'}`} aria-busy={library.busy}>
      <Toolbar tool={tool} setTool={setTool} onSelectNode={setNewNodeId} />
      <Board key={library.activeFileId} tool={tool} setTool={setTool} newNodeId={newNodeId} uiVisible={uiVisible} onToggleUI={() => setUiVisible((visible) => !visible)} />
    </div>
  )
}
