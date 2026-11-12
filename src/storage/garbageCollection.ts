import type { LocalRepository } from './local'

export function startAssetGarbageCollection(repository: LocalRepository, onError: (error: unknown) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let running = false
  let pending = false
  const collect = async () => {
    if (stopped) return
    if (running) { pending = true; return }
    running = true
    clearTimeout(timer)
    try {
      const next = await repository.collectGarbage()
      if (!stopped && next !== null) timer = setTimeout(() => { void collect() }, Math.max(0, next - Date.now()))
    } catch (error) {
      onError(error)
      if (!stopped) timer = setTimeout(() => { void collect() }, 60000)
    } finally {
      running = false
      if (pending && !stopped) { pending = false; void collect() }
    }
  }
  const wake = () => { void collect() }
  const unsubscribe = repository.subscribeWrites(wake)
  window.addEventListener('focus', wake)
  document.addEventListener('visibilitychange', wake)
  wake()
  return () => {
    stopped = true
    clearTimeout(timer)
    unsubscribe()
    window.removeEventListener('focus', wake)
    document.removeEventListener('visibilitychange', wake)
  }
}
