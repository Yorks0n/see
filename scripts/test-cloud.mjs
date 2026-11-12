import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

// Run only against a local Wrangler instance; no production data is touched.
const origin = 'http://127.0.0.1:8787'
const password = (await readFile(process.argv[2] || '/tmp/see-cloud-test-password', 'utf8')).trim()
async function request(path, { token, body, ...init } = {}) {
  return fetch(origin + '/api/' + path, {
    ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body && typeof body !== 'string' && !(body instanceof Uint8Array) ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    body: body && typeof body !== 'string' && !(body instanceof Uint8Array) ? JSON.stringify(body) : body,
  })
}
assert.equal((await request('boards')).status, 401)
assert.equal((await request('events')).status, 401)
assert.equal((await request('assets/' + 'a'.repeat(64))).status, 401)
assert.equal((await request('login', { method: 'POST', body: { username: 'owner', password: 'wrong-password' } })).status, 401)
assert.equal((await request('login', { method: 'POST', headers: { Origin: 'https://untrusted.invalid' }, body: { username: 'owner', password } })).status, 403)
const login = await request('login', { method: 'POST', body: { username: 'owner', password } })
assert.equal(login.status, 200, await login.clone().text())
const { token, vaultId } = await login.json()
assert.ok(token && vaultId)
assert.equal((await request('session', { token })).status, 200)
assert.equal((await (await request('session', { token })).json()).changes, true)
assert.equal((await (await request('session', { token })).json()).push, true)
assert.equal((await request('events', { token })).status, 426)

function subscribe(credential) {
  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/api/events', ['see-sync', `see-auth.${credential}`])
  const messages = [], waiting = []
  socket.addEventListener('message', (event) => {
    const value = event.data === 'pong' ? 'pong' : JSON.parse(event.data)
    const resolve = waiting.shift()
    if (resolve) resolve(value)
    else messages.push(value)
  })
  return {
    socket,
    next: () => Promise.race([
      messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve) => waiting.push(resolve)),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('push message timed out')), 3000); timer.unref() }),
    ]),
  }
}
const firstDevice = subscribe(token), secondDevice = subscribe(token)
assert.deepEqual(await firstDevice.next(), { type: 'ready' })
assert.deepEqual(await secondDevice.next(), { type: 'ready' })
assert.equal(firstDevice.socket.protocol, 'see-sync')
const expectChange = async (revision) => {
  for (const device of [firstDevice, secondDevice]) assert.deepEqual(await device.next(), { type: 'changed', id, revision })
}

const id = 'integration-' + randomUUID()
const doc = { nodes: [{ id: 'text', type: 'text', text: 'hello', x: 0, y: 0, width: 100, height: 50 }], edges: [], meta: { name: id } }
const save = (revision, value) => request(`boards/${id}`, { method: 'PUT', token, body: { baseRevision: revision, doc: value } })
assert.equal((await save(0, doc)).status, 200)
await expectChange(1)
const racing = await Promise.all([save(1, { ...doc, meta: { name: 'left' } }), save(1, { ...doc, meta: { name: 'right' } })])
assert.deepEqual(racing.map((response) => response.status).sort(), [200, 409])
const current = await (await request(`boards/${id}`, { token })).json()
assert.equal(current.revision, 2)
await expectChange(2)
assert.equal((await save(0, doc)).status, 409)
assert.equal((await request(`boards/${id}/history`, { token })).status, 200)
assert.deepEqual((await (await request(`boards/${id}/history/1`, { token })).json()).doc, doc)

const data = new Uint8Array(8 * 1024 * 1024 + 128).fill(42)
const mime = 'video/mp4'
const digest = createHash('sha256').update(mime + '\0').update(data).digest('hex')
const start = () => request('uploads', { method: 'POST', token, body: { hash: digest, mime, size: data.length } })
const begun = await start()
assert.equal(begun.status, 200, await begun.clone().text())
const upload = await begun.json()
if (!upload.complete) {
  const first = data.slice(0, 8 * 1024 * 1024)
  assert.equal((await request(`uploads/${encodeURIComponent(upload.uploadId)}/1`, { method: 'PUT', token, body: first, headers: { 'X-Content-SHA256': 'bad' } })).status, 400)
  for (let part = 1; part <= 2; part++) {
    const chunk = data.slice((part - 1) * 8 * 1024 * 1024, part * 8 * 1024 * 1024)
    const response = await request(`uploads/${encodeURIComponent(upload.uploadId)}/${part}`, { method: 'PUT', token, body: chunk, headers: { 'X-Content-SHA256': createHash('sha256').update(chunk).digest('hex') } })
    assert.equal(response.status, 200, await response.clone().text())
    if (part === 1) {
      const resumed = await (await start()).json()
      assert.equal(resumed.uploadId, upload.uploadId)
      assert.deepEqual(resumed.parts, [1])
      assert.equal((await request(`uploads/${encodeURIComponent(upload.uploadId)}/complete`, { method: 'POST', token })).status, 409)
    }
  }
  const complete = await request(`uploads/${encodeURIComponent(upload.uploadId)}/complete`, { method: 'POST', token })
  assert.equal(complete.status, 200, await complete.clone().text())
}
assert.equal((await (await start()).json()).complete, true)
const downloaded = await request(`assets/${digest}`, { token })
assert.equal(downloaded.status, 200)
assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), data)
const range = await request(`assets/${digest}`, { token, headers: { Range: 'bytes=0-9' } })
assert.equal(range.status, 206)
assert.equal((await range.arrayBuffer()).byteLength, 10)
const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>')
const svgMime = 'image/svg+xml;charset=utf-8'
const svgHash = createHash('sha256').update(svgMime + '\0').update(svg).digest('hex')
const svgStart = await request('uploads', { method: 'POST', token, body: { hash: svgHash, mime: svgMime, size: svg.length } })
assert.equal(svgStart.status, 200, await svgStart.clone().text())
const svgUpload = await svgStart.json()
if (!svgUpload.complete) {
  assert.equal((await request(`uploads/${encodeURIComponent(svgUpload.uploadId)}/1`, { method: 'PUT', token, body: svg, headers: { 'X-Content-SHA256': createHash('sha256').update(svg).digest('hex') } })).status, 200)
  const complete = await request(`uploads/${encodeURIComponent(svgUpload.uploadId)}/complete`, { method: 'POST', token })
  assert.equal(complete.status, 200, await complete.clone().text())
}
assert.deepEqual(new Uint8Array(await (await request(`assets/${svgHash}`, { token })).arrayBuffer()), svg)
const mediaDoc = { ...doc, nodes: [...doc.nodes, { id: 'image', type: 'image', x: 0, y: 0, width: 10, height: 10, url: `see-asset:${digest}` }] }
assert.equal((await save(2, mediaDoc)).status, 200)
await expectChange(3)
const changes = { nodes: { upsert: [{ ...mediaDoc.nodes[1], x: 20 }], remove: [] }, edges: { upsert: [], remove: [] } }
const patch = (revision, value) => request(`boards/${id}`, { method: 'PATCH', token, body: { baseRevision: revision, changes: value } })
const patched = await patch(3, changes)
assert.equal(patched.status, 200, await patched.clone().text())
assert.deepEqual(await patched.json(), { id, revision: 4 })
await expectChange(4)
assert.deepEqual((await (await request(`boards/${id}`, { token })).json()).doc, { ...mediaDoc, nodes: [mediaDoc.nodes[0], { ...mediaDoc.nodes[1], x: 20 }] })
assert.equal((await patch(3, changes)).status, 409)
assert.equal((await patch(4, { ...changes, nodes: { ...changes.nodes, order: ['image'] } })).status, 400)
assert.equal((await patch(4, { ...changes, nodes: { upsert: [{ ...mediaDoc.nodes[1], url: `see-asset:${svgHash}` }], remove: [] } })).status, 200)
await expectChange(5)
assert.equal((await save(5, null)).status, 200)
await expectChange(6)
assert.equal((await patch(6, changes)).status, 409)
assert.equal((await save(6, mediaDoc)).status, 409)
for (const device of [firstDevice, secondDevice]) {
  device.socket.send('ping')
  assert.equal(await device.next(), 'pong', 'failed writes must not emit changes')
}
const closed = [firstDevice, secondDevice].map(({ socket }) => new Promise((resolve) => socket.addEventListener('close', resolve, { once: true })))
assert.equal((await request('logout', { method: 'POST', token })).status, 200)
for (const event of await Promise.all(closed)) assert.equal(event.code, 1008)
assert.equal((await request('session', { token })).status, 401)
console.log('Cloud runtime passed: auth, origin checks, WebSocket push to two devices, CAS, incremental changes, history, resumable multipart, parameterized SVG MIME, integrity, range reads, tombstones, logout and socket revocation.')
