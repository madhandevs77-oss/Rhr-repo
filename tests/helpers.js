// Test harness: a throw-away PostgreSQL database per test file, the real Express app on an ephemeral port, mock messaging provider.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import sharp from 'sharp'

const adminUrl = process.env.TEST_ADMIN_DATABASE_URL || 'postgres://rhr:rhr_dev_pw@127.0.0.1:5432/postgres'
export const dbName = `rhr_test_${process.pid}_${crypto.randomBytes(3).toString('hex')}`
const base = new URL(adminUrl)
base.pathname = `/${dbName}`
process.env.DATABASE_URL = base.toString()
process.env.NODE_ENV = 'test'
process.env.NOTIFY_WORKER = 'false'
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rhr-up-'))
process.env.BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rhr-bk-'))
process.env.PAYMENT_WEBHOOK_SECRET = 'whsec_test'
process.env.TWILIO_AUTH_TOKEN = 'tw_test_token'
process.env.WHATSAPP_APP_SECRET = 'meta_test_secret'

export async function setup() {
  const admin = new pg.Client({ connectionString: adminUrl })
  await admin.connect()
  await admin.query(`CREATE DATABASE ${dbName}`)
  await admin.end()
  const { getPool } = await import('../server/db/pool.js')
  const { migrate } = await import('../server/db/migrate.js')
  await migrate(getPool())
  const { createApp } = await import('../server/app.js')
  const server = await new Promise((res) => { const s = createApp().listen(0, '127.0.0.1', () => res(s)) })
  const url = `http://127.0.0.1:${server.address().port}`
  const { hashPassword } = await import('../server/lib/auth.js')
  const { query } = await import('../server/db/pool.js')
  for (const [u, role] of [['admin', 'admin'], ['manager', 'manager'], ['staff', 'staff'], ['staff2', 'staff']]) {
    await query('INSERT INTO users (username,name,role,password_hash) VALUES ($1,$2,$3,$4)', [u, u[0].toUpperCase() + u.slice(1), role, await hashPassword('Passw0rd-' + u)])
  }
  const teardown = async () => {
    server.close()
    const { closePool } = await import('../server/db/pool.js')
    await closePool()
    const a = new pg.Client({ connectionString: adminUrl })
    await a.connect()
    await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
    await a.end()
    fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true })
    fs.rmSync(process.env.BACKUP_DIR, { recursive: true, force: true })
  }
  return { url, teardown, client: (u) => new Client(url, u) }
}

export class Client {
  constructor(url, user) { this.url = url; this.user = user; this.cookie = '' }
  async login(user = this.user) {
    const r = await this.req('POST', '/api/auth/login', { username: user, password: 'Passw0rd-' + user })
    if (r.status !== 200) throw new Error('login failed ' + JSON.stringify(r.body))
    return this
  }
  async req(method, p, body, { raw = false, headers = {}, csrf = true } = {}) {
    const h = { ...headers }
    if (csrf) h['X-Requested-With'] = 'rhr'
    if (this.cookie) h.Cookie = this.cookie
    let payload
    if (body instanceof FormData) payload = body
    else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body) }
    const res = await fetch(this.url + p, { method, headers: h, body: payload })
    const sc = res.headers.get('set-cookie')
    if (sc) { const c = sc.split(';')[0]; this.cookie = c.endsWith('=') ? '' : c }
    if (raw) return { status: res.status, res, buf: Buffer.from(await res.arrayBuffer()) }
    const text = await res.text()
    let json; try { json = JSON.parse(text) } catch { json = text }
    return { status: res.status, body: json, headers: res.headers }
  }
  get(p, o) { return this.req('GET', p, undefined, o) }
  post(p, b, o) { return this.req('POST', p, b ?? {}, o) }
  put(p, b, o) { return this.req('PUT', p, b, o) }
  patch(p, b, o) { return this.req('PATCH', p, b, o) }
  del(p, o) { return this.req('DELETE', p, undefined, o) }
}

export const png = (w = 800, h = 600, color = '#a33') => sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer()
export function form(files, field = 'images') {
  const f = new FormData()
  for (const [name, buf, type] of files) f.append(field, new Blob([buf], { type }), name)
  return f
}
export const futureDate = (days) => {
  const d = new Date(Date.now() + (5.5 * 3600 + days * 86400) * 1000)
  return d.toISOString().slice(0, 10)
}
export const bookingBody = (hallId, o = {}) => ({
  customer: { name: 'Test Customer', phone: '9876543210', messageConsent: true, ...(o.customer || {}) },
  hallId, eventType: 'Wedding', date: futureDate(30), startTime: '10:00', endTime: '14:00', hallCharge: 10000, discount: 0, taxRate: 0,
  charges: [], catering: null, foodItems: [], ...Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'customer')),
})
