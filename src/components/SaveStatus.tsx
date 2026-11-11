import { useSyncExternalStore } from 'react'
import { exportCanvasFile, persistenceStore, reportSaveError, requestPersistentStorage, saveLocal } from '../persistence'
import { libraryStore } from '../store/library'
import { cloudStore } from '../sync/cloud'

export function saveStatusIndicator(status: ReturnType<typeof persistenceStore.getSnapshot>, cloud: ReturnType<typeof cloudStore.getSnapshot>) {
  const localState = status.viewOnly && (status.state === 'dirty' || status.state === 'saving') ? 'saved' : status.state
  const localLabel = { saved: '已保存到本机', dirty: '待保存', saving: '正在保存', error: '保存失败', conflict: '保存冲突' }[localState]
  const cloudLabel = { local: '已保存到本机', syncing: '已保存到本机，正在同步', synced: '已同步到云端', offline: '已保存到本机，待同步', error: '已保存到本机，同步失败' }[cloud.state]
  if (localState === 'error' || localState === 'conflict') return { state: localState, label: localLabel, title: status.message || localLabel }
  if (cloud.enabled && cloud.state === 'error') return { state: 'error', label: localState === 'saved' ? cloudLabel : `${localLabel}，云端同步失败`, title: cloud.message || '云端同步失败' }
  const label = localState === 'saved' && cloud.enabled ? cloudLabel : localLabel
  const state = localState === 'saved' && cloud.enabled && cloud.state !== 'synced' ? 'dirty' : localState
  return { state, label, title: (cloud.enabled && cloud.message) || label }
}

export function SaveStatus() {
  const status = useSyncExternalStore(persistenceStore.subscribe, persistenceStore.getSnapshot)
  const library = useSyncExternalStore(libraryStore.subscribe, libraryStore.getSnapshot)
  const cloud = useSyncExternalStore(cloudStore.subscribe, cloudStore.getSnapshot)
  const indicator = saveStatusIndicator(status, cloud)
  const failed = status.state === 'error' || status.state === 'conflict'
  return <>
    <span className={`save-status ${indicator.state}`} role="status" aria-label={indicator.label} title={indicator.title}>●</span>
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
