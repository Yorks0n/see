// Writes still use the versioned HTTP API; this connection only announces committed changes.
export function startCloudPush(endpoint: string, token: string, changed: () => void) {
  const url = new URL('/api/events', endpoint)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  let socket: WebSocket | null = null, stopped = false, retryDelay = 1000, lastMessage = 0
  let retry: ReturnType<typeof setTimeout> | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  const connect = () => {
    if (stopped) return
    retry = null
    const current = new WebSocket(url, ['see-sync', `see-auth.${token}`])
    socket = current
    current.onopen = () => {
      retryDelay = 1000; lastMessage = Date.now()
      heartbeat = setInterval(() => {
        if (Date.now() - lastMessage > 45000) current.close()
        else if (current.readyState === WebSocket.OPEN) current.send('ping')
      }, 20000)
    }
    current.onmessage = (event) => {
      lastMessage = Date.now()
      if (event.data === 'pong') return
      try {
        const message = JSON.parse(event.data)
        // "ready" also recovers changes missed while disconnected.
        if (message.type === 'changed' || message.type === 'ready') changed()
      } catch { /* Unknown messages do not change local documents. */ }
    }
    current.onerror = () => current.close()
    current.onclose = (event) => {
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = null
      if (stopped || event.code === 1008) return
      retry = setTimeout(connect, retryDelay)
      retryDelay = Math.min(retryDelay * 2, 30000)
    }
  }
  const online = () => {
    if (socket?.readyState !== WebSocket.CLOSED) return
    if (retry) clearTimeout(retry)
    connect()
  }
  window.addEventListener('online', online)
  connect()
  return () => {
    stopped = true
    window.removeEventListener('online', online)
    if (retry) clearTimeout(retry)
    if (heartbeat) clearInterval(heartbeat)
    socket?.close()
  }
}
