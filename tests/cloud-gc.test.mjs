import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, pbkdf2Sync } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'vite'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'

const retention = 7 * 24 * 60 * 60 * 1000
let runtime, vault, bucket, token, temporary
const initialTime = Date.now()

before(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'see-cloud-gc-'))
  // Only this test worker exposes storage inspection and a controllable clock.
  // Production fetch routes and R2/SQLite operations run unchanged.
  const entry = join(temporary, 'worker.ts')
  await writeFile(entry, `
    import worker, { SeeVault } from ${JSON.stringify(new URL('../worker/index.ts', import.meta.url).pathname)}
    export default worker
    export class TestVault extends SeeVault {
      async runAlarm(now) {
        const original = Date.now
        Date.now = () => now
        try {
          this.sql.exec('UPDATE sessions SET expires = ?', now + ${retention})
          await this.ctx.storage.deleteAlarm()
          await this.alarm()
        } catch (error) { return error.message
        } finally { Date.now = original }
      }
      inspect() {
        return {
          gc: this.sql.exec('SELECT * FROM asset_gc ORDER BY hash').toArray(),
          assets: this.sql.exec('SELECT * FROM assets ORDER BY hash').toArray(),
          history: this.sql.exec('SELECT id, revision, doc FROM history').toArray(),
        }
      }
      async alarmTime() { return this.ctx.storage.getAlarm() }
      seed(hash, expires, deleting = 0) {
        this.sql.exec('INSERT INTO assets VALUES (?, ?, ?)', hash, 'image/png', 5)
        if (expires !== null) this.sql.exec('INSERT INTO asset_gc VALUES (?, ?, ?)', hash, expires, deleting)
      }
      failDeletion() {
        const media = this.env.MEDIA
        this.env.MEDIA = {
          ...media,
          delete: async () => { throw new Error('R2 temporarily unavailable') },
        }
        this.originalMedia = media
      }
      resumeDeletion() { this.env.MEDIA = this.originalMedia }
      async holdDeletion() {
        const media = this.env.MEDIA
        this.env.MEDIA = {
          ...media,
          delete: async (key) => {
            await new Promise(resolve => { this.releaseDelete = resolve })
            await media.delete(key)
          },
        }
        this.originalMedia = media
      }
      releaseDeletion() { this.releaseDelete(); this.env.MEDIA = this.originalMedia }
    }
  `)
  await build({
    configFile: false, logLevel: 'error',
    build: {
      outDir: join(temporary, 'dist'), minify: false,
      lib: { entry, formats: ['es'], fileName: () => 'worker.mjs' },
      rollupOptions: { external: ['cloudflare:workers'] },
    },
  })
  const salt = '0'.repeat(32)
  const passwordHash = `pbkdf2-sha256:100000:${salt}:${pbkdf2Sync('test-password', Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex')}`
  runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: await readFile(join(temporary, 'dist/worker.mjs'), 'utf8'),
    compatibilityDate: '2026-11-10',
    durableObjects: { VAULT: { className: 'TestVault', useSQLite: true } },
    r2Buckets: ['MEDIA'],
    bindings: { USERNAME: 'owner', PASSWORD_HASH: passwordHash },
  }))
  const namespace = await runtime.getDurableObjectNamespace('VAULT')
  vault = namespace.getByName('personal')
  bucket = await runtime.getR2Bucket('MEDIA')
  const response = await request('login', { username: 'owner', password: 'test-password' })
  assert.equal(response.status, 200)
  token = (await response.json()).token
})

after(async () => {
  await runtime?.dispose()
  if (temporary) await rm(temporary, { recursive: true, force: true })
})

function request(path, body, method = body === undefined ? 'GET' : 'POST') {
  return runtime.dispatchFetch(`https://see.test/api/${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
const doc = (hash) => ({
  nodes: hash ? [{ id: 'image', type: 'image', x: 0, y: 0, width: 50, height: 50, url: `see-asset:${hash}` }] : [],
  edges: [],
})
const save = (id, revision, value) => request(`boards/${id}`, { baseRevision: revision, doc: value }, 'PUT')
async function upload(text) {
  const bytes = new TextEncoder().encode(text), mime = 'image/png'
  const hash = createHash('sha256').update(mime + '\0').update(bytes).digest('hex')
  const start = await request('uploads', { hash, mime, size: bytes.length })
  assert.equal(start.status, 200, await start.clone().text())
  const { uploadId, complete } = await start.json()
  if (!complete) {
    const part = await runtime.dispatchFetch(`https://see.test/api/uploads/${encodeURIComponent(uploadId)}/1`, {
      method: 'PUT', body: bytes,
      headers: { Authorization: `Bearer ${token}`, 'X-Content-SHA256': createHash('sha256').update(bytes).digest('hex') },
    })
    assert.equal(part.status, 200)
    const finish = await request(`uploads/${encodeURIComponent(uploadId)}/complete`, {})
    assert.equal(finish.status, 200, await finish.clone().text())
  }
  return hash
}

test('cloud GC retains shared attachments, expires at seven days and removes dependent history', async () => {
  const hash = await upload('shared image')
  assert.equal((await save('first', 0, doc(hash))).status, 200)
  assert.equal((await save('second', 0, doc(hash))).status, 200)
  assert.equal((await save('first', 1, null)).status, 200)
  assert.equal((await vault.inspect()).gc.some((row) => row.hash === hash), false)
  assert.equal((await save('second', 1, doc())).status, 200)
  const [{ expires }] = (await vault.inspect()).gc.filter((row) => row.hash === hash)
  assert.ok(expires >= initialTime + retention)
  assert.ok(await vault.alarmTime() <= expires, 'attachment GC must share the existing upload alarm without postponing it')
  await vault.runAlarm(expires - 1)
  assert.ok(await bucket.head(hash))
  assert.equal(await vault.alarmTime(), expires)
  await vault.runAlarm(expires)
  assert.equal(await bucket.head(hash), null)
  const state = await vault.inspect()
  assert.equal(state.assets.some((row) => row.hash === hash), false)
  assert.equal(state.gc.some((row) => row.hash === hash), false)
  assert.equal(state.history.some((row) => row.doc.includes(hash)), false)
  assert.equal((await request('boards/first/history/1')).status, 404)
  assert.equal((await request('boards/second/history/2')).status, 200)
  // A collected hash must start a new upload rather than resume completed parts.
  assert.equal(await upload('shared image'), hash)
})

test('cloud GC cancels expiry on reuse and starts a new grace period on the next deletion', async () => {
  const hash = await upload('restored image')
  assert.equal((await save('restore', 0, doc(hash))).status, 200)
  assert.equal((await save('restore', 1, doc())).status, 200)
  const previous = (await vault.inspect()).gc.find((row) => row.hash === hash).expires
  assert.equal((await save('restore', 2, doc(hash))).status, 200)
  await vault.runAlarm(previous)
  assert.ok(await bucket.head(hash))
  assert.equal((await vault.inspect()).gc.some((row) => row.hash === hash), false)
  assert.equal((await save('restore', 3, null)).status, 200)
  const deadline = (await vault.inspect()).gc.find((row) => row.hash === hash).expires
  assert.ok(deadline >= initialTime + retention)
})

test('unreferenced uploads and older untracked attachments are reclaimed without deleting live images', async () => {
  const live = await upload('live forever')
  assert.equal((await save('live', 0, doc(live))).status, 200)
  const orphan = await upload('never committed')
  const legacy = 'b'.repeat(64)
  await bucket.put(legacy, 'hello')
  await vault.seed(legacy, null)
  const first = Date.now()
  await vault.runAlarm(first)
  const state = await vault.inspect()
  const orphanExpiry = state.gc.find((row) => row.hash === orphan).expires
  const legacyExpiry = state.gc.find((row) => row.hash === legacy).expires
  assert.equal(legacyExpiry, first + retention)
  await vault.runAlarm(Math.max(orphanExpiry, legacyExpiry))
  assert.equal(await bucket.head(orphan), null)
  assert.equal(await bucket.head(legacy), null)
  assert.ok(await bucket.head(live))
  assert.equal((await request(`assets/${orphan}`)).status, 404)
})

test('R2 failures persist deletion claims and retry alarms across garbage collection attempts', async () => {
  const hash = 'c'.repeat(64), deadline = Date.now()
  await bucket.put(hash, 'hello')
  await vault.seed(hash, deadline)
  await vault.failDeletion()
  try {
    assert.equal(await vault.runAlarm(deadline), 'R2 temporarily unavailable')
    const claim = (await vault.inspect()).gc.find((row) => row.hash === hash)
    assert.equal(claim.deleting, 1)
    assert.ok(await vault.alarmTime() <= deadline + 60000)
    assert.equal((await save('failed-gc', 0, doc(hash))).status, 409)
  } finally { await vault.resumeDeletion() }
  await vault.runAlarm(deadline + 60000)
  assert.equal(await bucket.head(hash), null)
  assert.equal((await vault.inspect()).gc.some((row) => row.hash === hash), false)
})

test('an attachment cannot be committed or reused while its R2 deletion is in flight', async () => {
  const hash = 'd'.repeat(64), deadline = Date.now()
  await bucket.put(hash, 'hello')
  await vault.seed(hash, deadline)
  await vault.holdDeletion()
  const collecting = vault.runAlarm(deadline)
  try {
    // The inspect RPC runs while collectAssets awaits R2, without blocking the object.
    assert.equal((await vault.inspect()).gc.find((row) => row.hash === hash).deleting, 1)
    const response = await save('racing', 0, doc(hash))
    assert.equal(response.status, 409)
    assert.deepEqual((await response.json()).missingAssets, [hash])
    assert.equal((await request('uploads', { hash, mime: 'image/png', size: 5 })).status, 409)
    assert.equal((await request(`assets/${hash}`)).status, 404)
  } finally { await vault.releaseDeletion(); await collecting }
  assert.equal(await bucket.head(hash), null)
  assert.equal((await request('boards/racing')).status, 200)
  assert.equal((await (await request('boards/racing')).json()).revision, 0)
})
