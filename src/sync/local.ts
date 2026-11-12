import type { LocalRepository } from '../storage/local'

// IndexedDB is shared by these windows; messages only invalidate their in-memory view.
export function startLocalSync(repo: LocalRepository, refresh: () => Promise<boolean>, onError: (error: unknown) => void) {
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('see-local-sync-v1')
  let pending = false, running = false, stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const schedule = (delay = 0) => {
    pending = true
    if (!stopped && !running && !timer) timer = setTimeout(() => { timer = null; void flush() }, delay)
  }
  const flush = async () => {
    if (stopped || running || !pending) return
    running = true; pending = false
    try {
      if (!await refresh()) pending = true
    } catch (error) {
      pending = true
      onError(error)
    } finally {
      running = false
      if (pending && !stopped) schedule(250)
    }
  }
  if (channel) channel.onmessage = (event) => { if (event.data?.type === 'changed') schedule() }
  const unsubscribe = repo.subscribeWrites(() => channel?.postMessage({ type: 'changed' }))
  const focus = () => schedule()
  const visible = () => { if (document.visibilityState === 'visible') schedule() }
  window.addEventListener('focus', focus)
  document.addEventListener('visibilitychange', visible)
  // Also catches writes committed between the initial load and opening this channel.
  schedule()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    unsubscribe(); channel?.close()
    window.removeEventListener('focus', focus)
    document.removeEventListener('visibilitychange', visible)
  }
}
