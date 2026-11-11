import { DurableObject } from 'cloudflare:workers'
import { applyCanvasChanges, assetRefs, PART_SIZE, validAssetMime, validateCanvas } from '../src/sync/protocol'

interface Env {
  VAULT: DurableObjectNamespace<SeeVault>
  MEDIA: R2Bucket
  SITE: Fetcher
  USERNAME: string
  PASSWORD_HASH: string
  ALLOWED_ORIGIN?: string
}
type BoardRow = { id: string; revision: number; doc: string; updated: number }
type UploadRow = { id: string; hash: string; mime: string; size: number; created: number }
const encoder = new TextEncoder()
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
const hash = async (text: string) => hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)))
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
class HttpError extends Error { constructor(public status: number, message: string) { super(message) } }

async function bytes(request: Request, limit: number): Promise<Uint8Array> {
  if (Number(request.headers.get('Content-Length')) > limit) throw new HttpError(413, '文件过大')
  const reader = request.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let length = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.length
    if (length > limit) { await reader.cancel(); throw new HttpError(413, '文件过大') }
    chunks.push(value)
  }
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length }
  return result
}
async function body(request: Request, limit = 1024 * 1024) {
  try { return JSON.parse(new TextDecoder().decode(await bytes(request, limit))) }
  catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, '无效的请求')
  }
}

export class SeeVault extends DurableObject<Env> {
  private sql: SqlStorage
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS boards (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, doc TEXT NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS history (id TEXT NOT NULL, revision INTEGER NOT NULL, doc TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY(id, revision));
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL, password_version TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, started INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, mime TEXT NOT NULL, size INTEGER NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS parts (upload TEXT NOT NULL, part INTEGER NOT NULL, etag TEXT NOT NULL, PRIMARY KEY(upload, part));
      CREATE TABLE IF NOT EXISTS assets (hash TEXT PRIMARY KEY, mime TEXT NOT NULL, size INTEGER NOT NULL);
    `)
    this.sql.exec('INSERT OR IGNORE INTO settings VALUES (?, ?)', 'vaultId', crypto.randomUUID())
  }

  private get vaultId() { return this.sql.exec<{ value: string }>('SELECT value FROM settings WHERE key = ?', 'vaultId').one().value }
  private getBoard(id: string) {
    const row = this.sql.exec<BoardRow>('SELECT * FROM boards WHERE id = ?', id).toArray()[0]
    return row ? { id, revision: row.revision, doc: JSON.parse(row.doc) } : { id, revision: 0, doc: null }
  }
  private throttle(key: string, maximum: number) {
    const now = Date.now(), cutoff = now - 15 * 60 * 1000
    this.sql.exec('DELETE FROM attempts WHERE started < ?', cutoff)
    this.sql.exec('INSERT INTO attempts VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1', key, now)
    if (this.sql.exec<{ count: number }>('SELECT count FROM attempts WHERE key = ?', key).one().count > maximum) throw new HttpError(429, '登录尝试过多，请稍后重试')
  }
  private async login(request: Request) {
    if (!this.env.PASSWORD_HASH) throw new HttpError(503, '管理员尚未设置密码')
    this.throttle('global', 60)
    this.throttle(await hash(request.headers.get('CF-Connecting-IP') || 'local'), 10)
    const input = await body(request, 4096)
    const [algorithm, iterations, salt, expected] = this.env.PASSWORD_HASH.split(':')
    if (algorithm !== 'pbkdf2-sha256' || iterations !== '100000' || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{64}$/.test(expected)) throw new HttpError(503, '登录配置无效')
    if (typeof input.password !== 'string' || input.password.length > 512) throw new HttpError(401, '账号或密码错误')
    const key = await crypto.subtle.importKey('raw', encoder.encode(input.password), 'PBKDF2', false, ['deriveBits'])
    const actual = hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: 100000, salt: Uint8Array.from(salt.match(/../g)!, (part) => parseInt(part, 16)) }, key, 256))
    let difference = 0
    for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index)
    if (difference || input.username !== this.env.USERNAME) throw new HttpError(401, '账号或密码错误')
    const token = hex(crypto.getRandomValues(new Uint8Array(32)).buffer), expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000
    this.sql.exec('DELETE FROM sessions WHERE expires < ?', Date.now())
    this.sql.exec('INSERT INTO sessions VALUES (?, ?, ?)', await hash(token), expiresAt, await hash(this.env.PASSWORD_HASH))
    return json({ token, expiresAt, vaultId: this.vaultId, username: this.env.USERNAME })
  }
  private async authenticate(request: Request) {
    const token = request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1]
    if (!token || !this.env.PASSWORD_HASH) throw new HttpError(401, '请重新登录')
    const key = await hash(token)
    const session = this.sql.exec<{ expires: number; password_version: string }>('SELECT expires, password_version FROM sessions WHERE token = ?', key).toArray()[0]
    if (!session || session.expires < Date.now() || session.password_version !== await hash(this.env.PASSWORD_HASH)) throw new HttpError(401, '请重新登录')
    return key
  }
  private async saveBoard(request: Request, id: string) {
    const input = await body(request)
    if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) throw new HttpError(400, '无效的白板数据')
    // There are no awaits between checking the revision and committing the transaction.
    return this.ctx.storage.transactionSync(() => {
      const current = this.getBoard(id)
      if (current.revision !== input.baseRevision) return json({ error: '白板已有更新', current }, 409)
      if (request.method === 'PATCH') {
        if (!current.doc) return json({ error: '白板已删除或不存在', current }, 409)
        try { input.doc = applyCanvasChanges(current.doc, input.changes) }
        catch { throw new HttpError(400, '无效的白板修改') }
      }
      if (!validateCanvas(input.doc)) throw new HttpError(400, '无效的白板数据')
      for (const ref of assetRefs(input.doc)) {
        if (!this.sql.exec('SELECT hash FROM assets WHERE hash = ?', ref).toArray().length) throw new HttpError(409, '附件尚未上传完成')
      }
      if (current.revision && current.doc === null && input.doc !== null) return json({ error: '白板已删除，请另存副本', current }, 409)
      if (JSON.stringify(current.doc) === JSON.stringify(input.doc)) return json(current)
      const revision = current.revision + 1, updated = Date.now(), serialized = JSON.stringify(input.doc)
      this.sql.exec('INSERT INTO boards VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, doc = excluded.doc, updated = excluded.updated', id, revision, serialized, updated)
      this.sql.exec('INSERT INTO history VALUES (?, ?, ?, ?)', id, revision, serialized, updated)
      this.sql.exec('DELETE FROM history WHERE id = ? AND revision <= ?', id, revision - 50)
      return json({ id, revision, ...(request.method === 'PATCH' ? {} : { doc: input.doc }) })
    })
  }
  private async startUpload(request: Request) {
    const input = await body(request, 4096)
    if (!/^[a-f0-9]{64}$/.test(input.hash) || !validAssetMime(input.mime) || !Number.isSafeInteger(input.size) || input.size < 1 || input.size > 512 * 1024 * 1024) throw new HttpError(400, '无效的附件（最大 512 MB）')
    if (this.sql.exec('SELECT hash FROM assets WHERE hash = ?', input.hash).toArray().length) return json({ complete: true })
    let row = this.sql.exec<UploadRow>('SELECT * FROM uploads WHERE hash = ?', input.hash).toArray()[0]
    if (!row) {
      const upload = await this.env.MEDIA.createMultipartUpload(input.hash, { httpMetadata: { contentType: input.mime } })
      // Concurrent devices may have started an upload while R2 was responding.
      row = this.sql.exec<UploadRow>('SELECT * FROM uploads WHERE hash = ?', input.hash).toArray()[0]
      if (row) await upload.abort()
      else {
        row = { id: upload.uploadId, hash: input.hash, mime: input.mime, size: input.size, created: Date.now() }
        this.sql.exec('INSERT INTO uploads VALUES (?, ?, ?, ?, ?)', row.id, row.hash, row.mime, row.size, row.created)
        await this.ctx.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000)
      }
    }
    if (row.size !== input.size || row.mime !== input.mime) throw new HttpError(409, '附件信息不一致')
    return json({ uploadId: row.id, partSize: PART_SIZE, parts: this.sql.exec<{ part: number }>('SELECT part FROM parts WHERE upload = ? ORDER BY part', row.id).toArray().map((part) => part.part) })
  }
  private async uploadPart(request: Request, uploadId: string, part: number) {
    const row = this.sql.exec<UploadRow>('SELECT * FROM uploads WHERE id = ?', uploadId).toArray()[0]
    if (!row) throw new HttpError(404, '上传记录已过期，请重试')
    const count = Math.ceil(row.size / PART_SIZE)
    if (!Number.isSafeInteger(part) || part < 1 || part > count) throw new HttpError(400, '无效的分块')
    const data = await bytes(request, PART_SIZE)
    if (data.length !== (part === count ? row.size - (part - 1) * PART_SIZE : PART_SIZE)) throw new HttpError(400, '分块不完整')
    if (hex(await crypto.subtle.digest('SHA-256', data)) !== request.headers.get('X-Content-SHA256')) throw new HttpError(400, '分块校验失败')
    const saved = await this.env.MEDIA.resumeMultipartUpload(row.hash, row.id).uploadPart(part, data)
    this.sql.exec('INSERT INTO parts VALUES (?, ?, ?) ON CONFLICT(upload, part) DO UPDATE SET etag = excluded.etag', row.id, part, saved.etag)
    return json({ part })
  }
  private async finishUpload(uploadId: string) {
    const row = this.sql.exec<UploadRow>('SELECT * FROM uploads WHERE id = ?', uploadId).toArray()[0]
    if (!row) throw new HttpError(404, '上传记录已过期，请重试')
    if (this.sql.exec('SELECT hash FROM assets WHERE hash = ?', row.hash).toArray().length) return json({ complete: true })
    const parts = this.sql.exec<{ part: number; etag: string }>('SELECT part, etag FROM parts WHERE upload = ? ORDER BY part', row.id).toArray()
    if (parts.length !== Math.ceil(row.size / PART_SIZE)) throw new HttpError(409, '附件尚未上传完整')
    const existing = await this.env.MEDIA.head(row.hash)
    if (!existing) await this.env.MEDIA.resumeMultipartUpload(row.hash, row.id).complete(parts.map((part) => ({ partNumber: part.part, etag: part.etag })))
    const object = await this.env.MEDIA.get(row.hash)
    if (!object || object.size !== row.size) throw new HttpError(409, '附件大小校验失败')
    const digest = new crypto.DigestStream('SHA-256'), writer = digest.getWriter()
    await writer.write(encoder.encode(row.mime + '\0'))
    writer.releaseLock()
    await object.body.pipeTo(digest)
    if (hex(await digest.digest) !== row.hash) {
      await this.env.MEDIA.delete(row.hash)
      this.sql.exec('DELETE FROM uploads WHERE id = ?', row.id)
      this.sql.exec('DELETE FROM parts WHERE upload = ?', row.id)
      throw new HttpError(400, '附件内容校验失败，请重新上传')
    }
    this.sql.exec('INSERT OR IGNORE INTO assets VALUES (?, ?, ?)', row.hash, row.mime, row.size)
    return json({ complete: true })
  }
  private async getAsset(request: Request, ref: string) {
    if (!/^[a-f0-9]{64}$/.test(ref) || !this.sql.exec('SELECT hash FROM assets WHERE hash = ?', ref).toArray().length) throw new HttpError(404, '附件不存在')
    const object = await this.env.MEDIA.get(ref, { range: request.headers })
    if (!object) throw new HttpError(404, '附件不存在')
    const headers = new Headers({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes' })
    object.writeHttpMetadata(headers)
    headers.set('Content-Disposition', 'attachment')
    headers.set('ETag', object.httpEtag)
    let status = 200
    if (request.headers.has('Range') && object.range && 'offset' in object.range && 'length' in object.range) {
      const offset = object.range.offset!, length = object.range.length!
      headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`)
      headers.set('Content-Length', String(length)); status = 206
    } else headers.set('Content-Length', String(object.size))
    return new Response(request.method === 'HEAD' ? null : object.body, { status, headers })
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname.split('/').filter(Boolean).map(decodeURIComponent), method = request.method
      if (path[1] === 'config' && method === 'GET') return json({ available: true, configured: !!this.env.PASSWORD_HASH })
      if (path[1] === 'login' && method === 'POST') return await this.login(request)
      const token = await this.authenticate(request)
      if (path[1] === 'session' && method === 'GET') return json({ vaultId: this.vaultId, username: this.env.USERNAME, changes: true })
      if (path[1] === 'logout' && method === 'POST') { this.sql.exec('DELETE FROM sessions WHERE token = ?', token); return json({ ok: true }) }
      if (path[1] === 'boards') {
        const id = path[2]
        if (!id && method === 'GET') return json({ boards: this.sql.exec<{ id: string; revision: number }>('SELECT id, revision FROM boards ORDER BY id').toArray() })
        if (!id || id.length > 512) throw new HttpError(400, '无效的白板 ID')
        if (path[3] === 'history' && method === 'GET') {
          if (!path[4]) return json({ versions: this.sql.exec('SELECT revision, updated FROM history WHERE id = ? ORDER BY revision DESC', id).toArray() })
          const row = this.sql.exec<BoardRow>('SELECT * FROM history WHERE id = ? AND revision = ?', id, Number(path[4])).toArray()[0]
          if (!row) throw new HttpError(404, '版本不存在')
          return json({ id, revision: row.revision, doc: JSON.parse(row.doc) })
        }
        if (method === 'GET') return json(this.getBoard(id))
        if (method === 'PUT' || method === 'PATCH') return await this.saveBoard(request, id)
      }
      if (path[1] === 'uploads') {
        if (!path[2] && method === 'POST') return await this.startUpload(request)
        if (path[3] === 'complete' && method === 'POST') return await this.finishUpload(path[2])
        if (method === 'PUT') return await this.uploadPart(request, path[2], Number(path[3]))
      }
      if (path[1] === 'assets' && ['GET', 'HEAD'].includes(method)) return await this.getAsset(request, path[2])
      throw new HttpError(404, '接口不存在')
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status)
      console.error('See request failed', error instanceof Error ? error.message : 'unknown error')
      return json({ error: '服务暂时不可用，请重试；本地修改仍然保留。' }, 500)
    }
  }
  async alarm() {
    for (const row of this.sql.exec<UploadRow>('SELECT * FROM uploads WHERE created < ?', Date.now() - 24 * 60 * 60 * 1000).toArray()) {
      try { await this.env.MEDIA.resumeMultipartUpload(row.hash, row.id).abort() } catch { /* Already completed. */ }
      this.sql.exec('DELETE FROM parts WHERE upload = ?', row.id)
      this.sql.exec('DELETE FROM uploads WHERE id = ?', row.id)
    }
    this.sql.exec('DELETE FROM sessions WHERE expires < ?', Date.now())
    if (this.sql.exec('SELECT id FROM uploads LIMIT 1').toArray().length) await this.ctx.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000)
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/api/')) return env.SITE.fetch(request)
    const origin = request.headers.get('Origin')
    const allowed = !origin || origin === url.origin || origin === env.ALLOWED_ORIGIN
    if (!allowed) return json({ error: '不允许此来源访问' }, 403)
    const headers = new Headers()
    if (origin) {
      headers.set('Access-Control-Allow-Origin', origin)
      headers.set('Vary', 'Origin')
      headers.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, OPTIONS')
      headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Content-SHA256')
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    const response = await env.VAULT.getByName('personal').fetch(request)
    const result = new Response(response.body, response)
    headers.forEach((value, key) => result.headers.set(key, value))
    return result
  },
} satisfies ExportedHandler<Env>
