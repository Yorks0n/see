import { useSyncExternalStore } from 'react'
import { exportCanvasFile, persistenceStore, reportSaveError, requestPersistentStorage, saveLocal } from '../persistence'
import { libraryStore } from '../store/library'
import { cloudStore } from '../sync/cloud'

export function SaveStatus() {
  const status = useSyncExternalStore(persistenceStore.subscribe, persistenceStore.getSnapshot)
  const library = useSyncExternalStore(libraryStore.subscribe, libraryStore.getSnapshot)
  const cloud = useSyncExternalStore(cloudStore.subscribe, cloudStore.getSnapshot)
  const cloudLabel = { local: '已保存到本机', syncing: '已保存到本机，正在同步', synced: '已同步到云端', offline: '已保存到本机，待同步', error: '已保存到本机，同步失败' }[cloud.state]
  const label = status.state === 'saved' ? cloudLabel : { saved: '', dirty: '待保存', saving: '正在保存', error: '保存失败', conflict: '保存冲突' }[status.state]
  const failed = status.state === 'error' || status.state === 'conflict'
  return <>
    <span className={`save-status ${status.state === 'saved' && cloud.enabled && cloud.state !== 'synced' ? 'dirty' : status.state}`} role="status" aria-label={label} title={cloud.message || label}>●</span>
    {failed && <div className="storage-notice floating-panel" role="alert">
      <span>{status.message}</span>
      <div>
        {status.state === 'error' && <button disabled={library.busy} onClick={() => { void requestPersistentStorage(); void saveLocal().catch(() => {}) }}>重试保存</button>}
        <button disabled={library.busy} onClick={() => { void libraryStore.saveCopy().catch(reportSaveError) }}>保存为副本</button>
        <button onClick={() => { void exportCanvasFile().catch(reportSaveError) }}>下载白板</button>
      </div>
    </div>}
  </>
}
