import { ASSET_RETENTION_MS, assetRefs, canvasChanges, cloudCanvas, equal, mergeCanvas, PART_SIZE, type CloudBoard } from './protocol'
import { LocalRepository, StorageConflictError } from '../storage/local'
import type { CanvasFile } from '../types'
import { startCloudPush } from './push'

const SETTINGS_KEY = 'see-cloud-session'
interface Session { endpoint: string; token: string; vaultId: string; username: string }
interface State { enabled: boolean; state: 'local' | 'syncing' | 'synced' | 'offline' | 'error'; message: string; username: string }
class ApiError extends Error { constructor(public status: number, message: string, public current?: CloudBoard, public missingAssets?: string[]) { super(message) } }
let state: State = { enabled: false, state: 'local', message: '', username: '' }
let session: Session | null = null
try { session = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null') } catch { /* Local mode. */ }
if (session?.token && session.vaultId) state = { enabled: true, state: 'offline', message: '', username: session.username }
const listeners = new Set<() => void>()
const publish = (patch: Partial<State>) => { state = { ...state, ...patch }; listeners.forEach((listener) => listener()) }
export const cloudStore = {
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  getSnapshot: () => state,
}
let repository: LocalRepository | null = null
let safe: (() => boolean) | null = null
let apply: ((action: () => Promise<void>) => Promise<boolean>) | null = null
let running: Promise<void> | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let localGeneration = 0
let pushGeneration = 0
let listening = false
let pushSession: Session | null = null
let stopPush: (() => void) | null = null
const uploadedAssets = new Map<string, number>()

function endpoint(value: string) {
  const url = new URL(value || location.origin)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('服务器地址必须使用 HTTPS')
  return url.origin
}
export function configuredEndpoint() { return session?.endpoint ?? location.origin }
async function api(active: Session, path: string, init: RequestInit = {}) {
  const response = await fetch(`${active.endpoint}/api/${path}`, {
    ...init, signal: AbortSignal.timeout(60000),
    headers: { Authorization: `Bearer ${active.token}`, ...init.headers },
  })
  if (!response.ok) {
    const value = await response.json().catch(() => ({ error: '服务器响应无效' }))
    throw new ApiError(response.status, value.error || '同步失败', value.current, value.missingAssets)
  }
  return response
}
export async function loginCloud(server: string, username: string, password: string) {
  const origin = endpoint(server)
  const response = await fetch(`${origin}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(20000),
  })
  const result = await response.json().catch(() => { throw new Error('此地址没有可用的同步服务') })
  if (!response.ok) throw new Error(result.error || '登录失败')
  const next: Session = { endpoint: origin, token: result.token, vaultId: result.vaultId, username: result.username }
  if (!next.token || !next.vaultId) throw new Error('登录响应无效')
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
  stopPush?.(); stopPush = null; pushSession = null
  session = next
  publish({ enabled: true, state: 'syncing', message: '', username: next.username })
  schedule()
}
export async function logoutCloud() {
  const active = session
  if (!active) return
  if (running) await running
  await api(active, 'logout', { method: 'POST' })
  localStorage.removeItem(SETTINGS_KEY)
  session = null
  stopPush?.(); stopPush = null; pushSession = null
  publish({ enabled: false, state: 'local', message: '', username: '' })
}

async function uploadAsset(active: Session, ref: string) {
  const blob = await repository!.getAsset(ref)
  if (!blob) throw new Error('本地附件缺失，未上传白板')
  const start = await (await api(active, 'uploads', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash: ref, mime: blob.type || 'application/octet-stream', size: blob.size }),
  })).json()
  if (start.complete) return
  for (let part = 1; part <= Math.ceil(blob.size / PART_SIZE); part++) {
    if (start.parts.includes(part)) continue
    const chunk = blob.slice((part - 1) * PART_SIZE, part * PART_SIZE)
    const digest = await crypto.subtle.digest('SHA-256', await chunk.arrayBuffer())
    const checksum = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    await api(active, `uploads/${encodeURIComponent(start.uploadId)}/${part}`, { method: 'PUT', headers: { 'X-Content-SHA256': checksum }, body: chunk })
  }
  await api(active, `uploads/${encodeURIComponent(start.uploadId)}/complete`, { method: 'POST' })
}
async function downloadAssets(active: Session, doc: CanvasFile | null) {
  for (const ref of assetRefs(doc)) {
    if (await repository!.getAsset(ref)) continue
    const response = await api(active, `assets/${ref}`)
    await repository!.cacheAsset(ref, await response.blob())
  }
}
async function send(active: Session, board: CloudBoard, remote: CloudBoard, supportsChanges: boolean) {
  const known = new Set(assetRefs(remote.doc)), key = `${active.endpoint}:${active.vaultId}:`
  const missing = assetRefs(board.doc).filter((ref) => !known.has(ref) && (uploadedAssets.get(key + ref) ?? 0) <= Date.now() - ASSET_RETENTION_MS)
  let cursor = 0, completed = 0
  const uploads = await Promise.allSettled(Array.from({ length: Math.min(3, missing.length) }, async () => {
    while (cursor < missing.length) {
      const ref = missing[cursor++]
      publish({ state: 'syncing', message: `正在上传附件 ${completed}/${missing.length}` })
      await uploadAsset(active, ref)
      uploadedAssets.set(key + ref, Date.now())
      publish({ state: 'syncing', message: `正在上传附件 ${++completed}/${missing.length}` })
    }
  }))
  const failure = uploads.find((result) => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
  const incremental = supportsChanges && remote.doc !== null && board.doc !== null
  try {
    const result = await (await api(active, `boards/${encodeURIComponent(board.id)}`, {
      method: incremental ? 'PATCH' : 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseRevision: board.revision, ...(incremental ? { changes: canvasChanges(remote.doc!, board.doc!) } : { doc: board.doc }) }),
    })).json()
    return { ...result, doc: result.doc === undefined ? board.doc : result.doc } as CloudBoard
  } catch (error) {
    if (error instanceof ApiError) for (const ref of error.missingAssets ?? []) uploadedAssets.delete(key + ref)
    throw error
  }
}
function schedule(delay = 500) {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { timer = null; void syncNow() }, delay)
}
export function startCloudSync(repo: LocalRepository, canApply: () => boolean, applyRemote: (action: () => Promise<void>) => Promise<boolean>) {
  repository = repo; safe = canApply; apply = applyRemote
  listening = true
  const unsubscribe = repo.subscribe(() => {
    localGeneration++
    if (session) publish({ state: 'offline', message: '修改已保存在本机，等待同步' })
    schedule()
  })
  const interval = setInterval(() => { void syncNow() }, 5000)
  const online = () => { pushGeneration++; void syncNow() }
  const visible = () => { if (document.visibilityState === 'visible') online() }
  window.addEventListener('online', online)
  window.addEventListener('focus', online)
  document.addEventListener('visibilitychange', visible)
  void syncNow()
  return () => {
    listening = false
    unsubscribe(); clearInterval(interval)
    window.removeEventListener('online', online)
    window.removeEventListener('focus', online)
    document.removeEventListener('visibilitychange', visible)
    if (timer) clearTimeout(timer)
    stopPush?.(); stopPush = null; pushSession = null
  }
}
export function syncNow(): Promise<void> {
  if (running) return running
  if (!session || !repository || !safe || !apply) return Promise.resolve()
  const active = session
  const generation = pushGeneration
  running = synchronize(active).catch((error) => {
    if (error instanceof StorageConflictError) { publish({ state: 'offline', message: '本地内容正在更新，将自动重试' }); return }
    const offline = !navigator.onLine || error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError')
    publish({ state: offline ? 'offline' : 'error', message: offline ? '修改已保存在本机，连接恢复后继续同步' : error instanceof Error ? error.message : '同步失败' })
  }).finally(() => {
    running = null
    if (listening && session === active && generation !== pushGeneration) schedule(0)
  })
  return running
}
async function synchronize(active: Session) {
  if (!navigator.onLine) { publish({ state: 'offline', message: '修改已保存在本机，连接恢复后继续同步' }); return }
  const currentSession = await (await api(active, 'session')).json()
  if (currentSession.vaultId !== active.vaultId) throw new Error('服务器数据仓库已变化，请重新登录')
  if (listening && session === active && currentSession.push && typeof WebSocket !== 'undefined' && pushSession !== active) {
    stopPush?.()
    pushSession = active
    stopPush = startCloudPush(active.endpoint, active.token, () => { pushGeneration++; schedule(0) })
  }
  const generation = localGeneration
  const local = await repository!.syncEntries(active.vaultId)
  const listing = await (await api(active, 'boards')).json() as { boards: { id: string; revision: number }[] }
  const remoteById = new Map(listing.boards.map((board) => [board.id, board.revision]))
  const localById = new Map(local.map((board) => [board.id, board]))
  let pending = false, conflicts = 0
  for (const id of new Set([...localById.keys(), ...remoteById.keys()])) {
    if (session !== active) return
    const entry = localById.get(id)
    const localDoc = cloudCanvas(entry?.doc ?? null), base = entry?.base ?? { revision: 0, doc: null }
    const revision = remoteById.get(id) ?? 0
    const remote: CloudBoard = revision === base.revision
      ? { id, revision, doc: base.doc }
      : await (await api(active, `boards/${encodeURIComponent(id)}`)).json()
    if (equal(localDoc, remote.doc)) {
      if (entry && base.revision !== remote.revision) await repository!.acknowledge(active.vaultId, id, remote)
      continue
    }
    publish({ state: 'syncing', message: '' })
    const merged = remote.revision > 0 && remote.doc === null && localDoc !== null && base.revision === 0
      ? { doc: remote.doc, conflict: true }
      : mergeCanvas(base.doc, localDoc, remote.doc)
    if (merged.conflict) {
      if (!safe!()) { pending = true; continue }
      await downloadAssets(active, remote.doc)
      if (!safe!()) { pending = true; continue }
      const applied = await apply!(() => repository!.acceptRemote(active.vaultId, id, entry?.revision ?? 0, remote, localDoc ? crypto.randomUUID() : undefined))
      if (!applied) { pending = true; continue }
      conflicts++
      continue
    }
    let result = remote
    if (!equal(merged.doc, remote.doc)) {
      try { result = await send(active, { id, revision: remote.revision, doc: merged.doc }, remote, currentSession.changes === true) }
      catch (error) {
        if (error instanceof ApiError && error.status === 409 && (error.current || error.missingAssets?.length)) { pending = true; continue }
        throw error
      }
    }
    if (equal(localDoc, result.doc)) {
      await repository!.acknowledge(active.vaultId, id, result)
    } else {
      if (!safe!()) { pending = true; continue }
      await downloadAssets(active, result.doc)
      if (!safe!()) { pending = true; continue }
      const applied = await apply!(() => repository!.acceptRemote(active.vaultId, id, entry?.revision ?? 0, result))
      if (!applied) { pending = true; continue }
    }
  }
  pending ||= generation !== localGeneration
  publish({ state: pending || conflicts ? 'offline' : 'synced', message: conflicts ? '并发修改已保留为冲突副本，将继续同步' : pending ? '等待当前编辑完成后合并更新' : '' })
  if (pending || conflicts) schedule(1000)
}
