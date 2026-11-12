import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IDBFactory } from 'fake-indexeddb'
import { LocalRepository } from '../src/storage/local'
import type { CanvasFile } from '../src/types'
import { applyCanvasChanges } from '../src/sync/protocol'

test('client persists offline edits, merges after reconnect, retries races and preserves conflicting versions', async () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: Object.assign(new EventTarget(), { visibilityState: 'visible' }) })
  const originalFetch = globalThis.fetch
  let connected = true, race = false, sessionError = false
  const remote = new Map<string, { id: string; revision: number; doc: CanvasFile | null }>()
  globalThis.fetch = async (input, init) => {
    if (!connected) throw new TypeError('network disconnected')
    const path = new URL(String(input)).pathname.replace('/api/', '')
    if (path === 'login') return Response.json({ token: 'a'.repeat(64), vaultId: 'vault', username: 'owner' })
    if (path === 'session') return sessionError ? Response.json({ error: '服务器拒绝同步' }, { status: 503 }) : Response.json({ vaultId: 'vault' })
    if (path === 'boards') return Response.json({ boards: [...remote.values()].map(({ id, revision }) => ({ id, revision })) })
    const id = decodeURIComponent(path.slice('boards/'.length))
    const current = remote.get(id) ?? { id, revision: 0, doc: null }
    if (init?.method !== 'PUT') return Response.json(current)
    const body = JSON.parse(init.body as string)
    if (race) {
      race = false
      current.revision++
      current.doc = { ...current.doc, meta: { name: 'racing server edit' } }
      remote.set(id, current)
    }
    if (body.baseRevision !== current.revision) return Response.json({ current, error: 'conflict' }, { status: 409 })
    const result = { id, revision: current.revision + 1, doc: body.doc }
    remote.set(id, result)
    return Response.json(result)
  }
  const cloud = await import('../src/sync/cloud')
  const repo = new LocalRepository()
  const original: CanvasFile = { nodes: [{ id: 'a', type: 'text', text: 'original', x: 10, y: 20, width: 100, height: 50 }], edges: [], meta: { name: 'original' } }
  await repo.save('board', original)
  const stop = cloud.startCloudSync(repo, () => true, async (action) => { await action(); return true })
  try {
    await cloud.loginCloud('https://see.example', 'owner', 'test password')
    await cloud.syncNow()
    assert.equal(remote.get('board')!.revision, 1)
    assert.equal(cloud.cloudStore.getSnapshot().state, 'synced')
    sessionError = true
    await cloud.syncNow()
    assert.equal(cloud.cloudStore.getSnapshot().state, 'error')
    assert.equal(cloud.cloudStore.getSnapshot().message, '服务器拒绝同步')
    sessionError = false
    await cloud.syncNow()
    assert.equal(cloud.cloudStore.getSnapshot().state, 'synced')
    const view = structuredClone(original)
    view.meta!.camera = { x: 120, y: -80, zoom: 2 }
    await repo.save('board', view)
    assert.equal(cloud.cloudStore.getSnapshot().state, 'synced')
    const checkStates: string[] = []
    const unsubscribe = cloud.cloudStore.subscribe(() => checkStates.push(cloud.cloudStore.getSnapshot().state))
    try { await cloud.syncNow() } finally { unsubscribe() }
    assert.deepEqual(checkStates, ['synced'])
    assert.equal(remote.get('board')!.revision, 1)
    assert.equal(remote.get('board')!.doc!.meta!.camera, undefined)
    assert.deepEqual((await repo.load('board'))!.meta!.camera, view.meta!.camera)
    connected = false
    const offline = structuredClone(view)
    offline.nodes![0].x = 80
    await repo.save('board', offline)
    await cloud.syncNow()
    assert.equal(cloud.cloudStore.getSnapshot().state, 'offline')
    assert.equal((await new LocalRepository().load('board'))!.nodes![0].x, 80)
    remote.set('board', { id: 'board', revision: 2, doc: { ...original, meta: { name: 'renamed remotely' } } })
    connected = true
    await cloud.syncNow()
    assert.equal(remote.get('board')!.doc!.nodes![0].x, 80)
    assert.equal((await repo.load('board'))!.meta!.name, 'renamed remotely')
    assert.deepEqual((await repo.load('board'))!.meta!.camera, view.meta!.camera)
    connected = false
    const competing = (await repo.load('board'))!
    competing.meta = { name: 'offline name' }
    await repo.save('board', competing)
    remote.set('board', { id: 'board', revision: 4, doc: { ...remote.get('board')!.doc!, meta: { name: 'other device name' } } })
    connected = true
    await cloud.syncNow()
    await cloud.syncNow()
    assert.ok([...remote.values()].some((board) => board.doc?.meta?.name === 'offline name（冲突副本）'))
    assert.equal((await repo.load('board'))!.meta!.name, 'other device name')
    const after = (await repo.load('board'))!
    after.nodes![0].color = '3'
    await repo.save('board', after)
    race = true
    await cloud.syncNow()
    await cloud.syncNow()
    assert.equal(remote.get('board')!.doc!.nodes![0].color, '3')
    assert.equal((await repo.load('board'))!.meta!.name, 'racing server edit')
    assert.equal(cloud.cloudStore.getSnapshot().state, 'synced')

    const annotated = (await repo.load('board'))!
    annotated.nodes!.push(
      { id: 'z-card', type: 'text', text: 'annotated card', x: 0, y: 0, width: 200, height: 100 },
      ...['stroke-c', 'stroke-a', 'stroke-b'].map((id) => ({
        id, type: 'draw' as const, x: 10, y: 10, width: 50, height: 50,
        points: [{ x: 0, y: 0 }, { x: 50, y: 50 }], strokeWidth: 4,
      })),
    )
    await repo.save('board', annotated)
    const current = remote.get('board')!
    remote.set('board', { ...current, revision: current.revision + 1, doc: { ...current.doc!, meta: { name: 'renamed during drawing' } } })
    await cloud.syncNow()
    const expectedOrder = annotated.nodes!.map((node) => node.id)
    assert.deepEqual(remote.get('board')!.doc!.nodes!.map((node) => node.id), expectedOrder)
    assert.deepEqual((await repo.load('board'))!.nodes!.map((node) => node.id), expectedOrder)
    assert.equal((await repo.load('board'))!.meta!.name, 'renamed during drawing')
    assert.equal(cloud.cloudStore.getSnapshot().state, 'synced')
  } finally { stop(); globalThis.fetch = originalFetch }
})

test('image-heavy sync uploads concurrently, resumes failures and sends only changed records afterwards', async () => {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } })
  const originalFetch = globalThis.fetch
  const repo = new LocalRepository()
  const nodes: CanvasFile['nodes'] = Array.from({ length: 6 }, (_, i) => ({
    id: `image-${i}`, type: 'image', x: i * 100, y: 0, width: 80, height: 60,
    url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg"><text>${i}</text></svg>`)}`,
  }))
  await repo.save('media-board', { nodes, edges: [], meta: { name: 'media' } })
  const remote = new Map<string, { id: string; revision: number; doc: CanvasFile | null }>()
  const uploads = new Map<string, { parts: number[]; complete: boolean }>()
  const writes: { method: string; body: any }[] = []
  let inFlight = 0, maximum = 0, startRequests = 0, partRequests = 0, failOnce = true, race = false
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname.replace('/api/', '')
    if (path === 'login') return Response.json({ token: 'b'.repeat(64), vaultId: 'media-vault', username: 'owner' })
    if (path === 'session') return Response.json({ vaultId: 'media-vault', changes: true })
    if (path === 'boards') return Response.json({ boards: [...remote.values()].map(({ id, revision }) => ({ id, revision })) })
    if (path === 'uploads') {
      startRequests++
      const { hash, mime } = JSON.parse(init!.body as string)
      assert.equal(mime, 'image/svg+xml;charset=utf-8')
      const upload = uploads.get(hash) ?? { parts: [], complete: false }
      uploads.set(hash, upload)
      return Response.json(upload.complete ? { complete: true } : { uploadId: hash, parts: upload.parts })
    }
    if (path.startsWith('uploads/')) {
      const [, id, part] = path.split('/'), upload = uploads.get(id)!
      if (part === 'complete') {
        if (failOnce) { failOnce = false; return Response.json({ error: 'temporary failure' }, { status: 503 }) }
        upload.complete = true
        return Response.json({ complete: true })
      }
      partRequests++; inFlight++; maximum = Math.max(maximum, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight--; upload.parts.push(Number(part))
      return Response.json({ part: Number(part) })
    }
    const id = decodeURIComponent(path.slice('boards/'.length))
    const current = remote.get(id) ?? { id, revision: 0, doc: null }
    if (!['PUT', 'PATCH'].includes(init?.method ?? '')) return Response.json(current)
    const body = JSON.parse(init!.body as string)
    writes.push({ method: init!.method!, body })
    if (race) {
      race = false
      current.revision++
      current.doc = { ...current.doc, meta: { name: 'renamed remotely' } }
      remote.set(id, current)
    }
    if (body.baseRevision !== current.revision) return Response.json({ error: 'conflict', current }, { status: 409 })
    const doc = init?.method === 'PATCH' ? applyCanvasChanges(current.doc!, body.changes) : body.doc
    const result = { id, revision: current.revision + 1, doc }
    remote.set(id, result)
    return Response.json(init?.method === 'PATCH' ? { id, revision: result.revision } : result)
  }
  const cloud = await import('../src/sync/cloud')
  await cloud.loginCloud('https://see.example', 'owner', 'test password')
  const stop = cloud.startCloudSync(repo, () => true, async (action) => { await action(); return true })
  try {
    await cloud.syncNow()
    assert.equal(cloud.cloudStore.getSnapshot().state, 'error')
    assert.equal(remote.has('media-board'), false, 'board must wait until every attachment is complete')
    await cloud.syncNow()
    assert.equal(cloud.cloudStore.getSnapshot().state, 'synced')
    assert.ok(maximum > 1 && maximum <= 3)
    assert.equal(partRequests, 6, 'completed parts are not uploaded again after retry')
    assert.equal(startRequests, 7, 'only the failed upload is checked again')
    assert.equal(writes[0].method, 'PUT')
    const edited = (await repo.load('media-board'))!
    edited.nodes![0].x += 20
    await repo.save('media-board', edited)
    await cloud.syncNow()
    assert.equal(startRequests, 7, 'moving a card must not check or upload existing images')
    assert.equal(writes.at(-1)!.method, 'PATCH')
    assert.deepEqual(writes.at(-1)!.body.changes.nodes.upsert.map((n: any) => n.id), ['image-0'])
    assert.equal(writes.at(-1)!.body.doc, undefined)
    edited.nodes![1].y += 20
    await repo.save('media-board', edited)
    race = true
    await cloud.syncNow()
    await cloud.syncNow()
    assert.equal(remote.get('media-board')!.doc!.meta!.name, 'renamed remotely')
    assert.equal(remote.get('media-board')!.doc!.nodes![1].y, 20)
    assert.equal(cloud.cloudStore.getSnapshot().state, 'synced')
  } finally { stop(); globalThis.fetch = originalFetch }
})

test('server push refreshes an open device, retains changes arriving during a sync and catches up after reconnect', async () => {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() })
  const originalFetch = globalThis.fetch, originalSocket = globalThis.WebSocket
  class Socket {
    static OPEN = 1
    static CLOSED = 3
    static instances: Socket[] = []
    readyState = 0
    onopen: (() => void) | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    onclose: ((event: { code: number }) => void) | null = null
    onerror: (() => void) | null = null
    constructor(readonly url: URL, readonly protocols: string[]) {
      Socket.instances.push(this)
      queueMicrotask(() => {
        if (this.readyState === Socket.CLOSED) return
        this.readyState = Socket.OPEN
        this.onopen?.()
        this.message({ type: 'ready' })
      })
    }
    message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
    send(value: string) { if (value === 'ping') this.onmessage?.({ data: 'pong' }) }
    close() { this.readyState = Socket.CLOSED; this.onclose?.({ code: 1000 }) }
  }
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: Socket })
  const repo = new LocalRepository()
  const doc: CanvasFile = { nodes: [], edges: [], meta: { name: 'initial' } }
  await repo.save('push-board', doc)
  let remote = { id: 'push-board', revision: 1, doc }
  let name = 'initial', blocked = false, hold = false, release: (() => void) | null = null
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 3000
    while (!check()) {
      assert.ok(Date.now() < deadline, 'expected push to update the device without polling')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname.replace('/api/', '')
    if (path === 'login') return Response.json({ token: 'c'.repeat(64), vaultId: 'push-vault', username: 'owner' })
    if (path === 'session') return Response.json({ vaultId: 'push-vault', changes: true, push: true })
    if (path === 'boards') {
      const listing = { boards: [{ id: remote.id, revision: remote.revision }] }
      if (hold) { hold = false; await new Promise<void>((resolve) => { release = resolve }) }
      return Response.json(listing)
    }
    return Response.json(remote)
  }
  const cloud = await import('../src/sync/cloud')
  await cloud.loginCloud('https://see.example', 'owner', 'password')
  const stop = cloud.startCloudSync(repo, () => !blocked, async (action) => {
    if (blocked) return false
    await action()
    name = (await repo.load('push-board'))!.meta!.name!
    return true
  })
  const change = (next: string) => {
    remote = { ...remote, revision: remote.revision + 1, doc: { ...doc, meta: { name: next } } }
    Socket.instances.at(-1)!.message({ type: 'changed', id: remote.id, revision: remote.revision })
  }
  try {
    await cloud.syncNow()
    await until(() => Socket.instances.length === 1)
    assert.equal(Socket.instances[0].url.href, 'wss://see.example/api/events')
    assert.deepEqual(Socket.instances[0].protocols, ['see-sync', `see-auth.${'c'.repeat(64)}`])
    change('pushed')
    await until(() => name === 'pushed')
    // Deliberately return a stale listing while a notification is already in flight.
    hold = true
    const syncing = cloud.syncNow()
    await until(() => release !== null)
    change('arrived during sync')
    release!()
    await syncing
    await until(() => name === 'arrived during sync')
    blocked = true
    change('wait for editing')
    await cloud.syncNow()
    assert.equal(name, 'arrived during sync')
    blocked = false
    window.dispatchEvent(new Event('focus'))
    await until(() => name === 'wait for editing')
    Socket.instances[0].close()
    remote = { ...remote, revision: remote.revision + 1, doc: { ...doc, meta: { name: 'missed while disconnected' } } }
    await until(() => Socket.instances.length === 2 && name === 'missed while disconnected')
    assert.equal(Socket.instances[1].readyState, Socket.OPEN)
    assert.equal(cloud.cloudStore.getSnapshot().state, 'synced')
  } finally {
    stop()
    assert.ok(Socket.instances.every((socket) => socket.readyState === Socket.CLOSED))
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: originalSocket })
  }
})
