import { useState, useSyncExternalStore } from 'react'
import { cloudStore, configuredEndpoint, loginCloud, logoutCloud, syncNow } from '../sync/cloud'
import { X } from './icons'
import { IconButton } from './IconButton'

export function CloudDialog({ onClose }: { onClose: () => void }) {
  const cloud = useSyncExternalStore(cloudStore.subscribe, cloudStore.getSnapshot)
  const [server, setServer] = useState(configuredEndpoint)
  const [username, setUsername] = useState(cloud.username || 'owner')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <div className="cloud-backdrop" onPointerDown={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose() }}>
    <form className="cloud-dialog floating-panel" role="dialog" aria-modal="true" aria-label="云端同步"
      onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape') onClose() }}
      onSubmit={(event) => {
        event.preventDefault(); setBusy(true); setError('')
        void loginCloud(server, username, password).then(() => { setPassword(''); onClose() })
          .catch((error: Error) => setError(error.message)).finally(() => setBusy(false))
      }}>
      <div className="popover-heading"><span>云端同步</span><IconButton type="button" icon={X} label="关闭同步设置" onClick={onClose} /></div>
      <label>服务器<input autoFocus type="url" required value={server} onChange={(event) => setServer(event.target.value)} /></label>
      <label>账号<input autoComplete="username" required value={username} onChange={(event) => setUsername(event.target.value)} /></label>
      <label>密码<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <p>登录后，此浏览器中的白板将同步到你的服务器。退出登录会保留本机副本。</p>
      {(error || cloud.message) && <p role="alert">{error || cloud.message}</p>}
      <div className="cloud-actions">
        <button type="submit" disabled={busy}>{busy ? '正在登录…' : '登录并同步'}</button>
        {cloud.enabled && <>
          <button type="button" disabled={busy} onClick={() => { void syncNow() }}>立即同步</button>
          <button type="button" disabled={busy} onClick={() => {
            setBusy(true)
            void logoutCloud().then(onClose).catch((error: Error) => setError(error.message)).finally(() => setBusy(false))
          }}>退出登录</button>
        </>}
      </div>
    </form>
  </div>
}
