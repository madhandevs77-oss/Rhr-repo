// Object storage for hall photos. Two drivers behind one interface (put / remove / publicUrl / thumbKey):
//   local    – files on disk (development, or a Docker volume)          STORAGE_DRIVER=local (default)
//   supabase – Supabase Storage via its REST API (free-tier cloud)      STORAGE_DRIVER=supabase
// Storage keys are identical in both drivers, so the database never needs to change when switching.
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'

const KEY_RE = /^[a-z]+\/[0-9a-f-]{36}(_t)?\.webp$/ // only keys the server itself generates
const checkKey = (key) => {
  if (!KEY_RE.test(key)) throw new Error('Invalid storage key')
  return key
}

// ---------- local disk ----------
const base = () => config.uploadDir
function resolveKey(key) {
  checkKey(key)
  const full = path.resolve(base(), key)
  if (!full.startsWith(path.resolve(base()) + path.sep)) throw new Error('Path traversal blocked')
  return full
}
const local = {
  async put(key, buffer) {
    const full = resolveKey(key)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, buffer, { flag: 'wx' }) // never overwrite
  },
  async remove(key) {
    try {
      await fs.unlink(resolveKey(key))
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
  },
  publicUrl: (key) => `/uploads/${key}`,
}

// ---------- Supabase Storage (REST; no extra dependency) ----------
const sb = () => config.supabase
const objectUrl = (key) => `${sb().url}/storage/v1/object/${encodeURIComponent(sb().bucket)}/${checkKey(key)}`
const authHeaders = () => ({ Authorization: `Bearer ${sb().serviceKey}`, apikey: sb().serviceKey })
async function sbFetch(url, init) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) }).catch((e) => {
    throw new Error(`Supabase Storage unreachable: ${e.message}`)
  })
  return r
}
async function sbError(r, what) {
  let detail = ''
  try { detail = (await r.text()).slice(0, 300) } catch {}
  return new Error(`Supabase Storage ${what} failed (${r.status}) ${detail}`.trim())
}
const supabase = {
  async put(key, buffer) {
    const r = await sbFetch(objectUrl(key), { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'image/webp', 'x-upsert': 'false', 'Cache-Control': 'max-age=2592000' }, body: buffer })
    if (!r.ok) throw await sbError(r, 'upload')
  },
  async remove(key) {
    const r = await sbFetch(objectUrl(key), { method: 'DELETE', headers: authHeaders() })
    if (r.ok) return
    const t = await r.text().catch(() => '')
    if (r.status === 404 || /not.?found/i.test(t)) return // already gone: removing is idempotent
    throw new Error(`Supabase Storage delete failed (${r.status}) ${t.slice(0, 300)}`.trim())
  },
  publicUrl: (key) => `${sb().url}/storage/v1/object/public/${encodeURIComponent(sb().bucket)}/${checkKey(key)}`,
}

// ---------- Amazon S3 (private bucket; the app streams images to browsers) ----------
// Credentials come from the AWS default provider chain (ECS/EC2 task role, SSO, env) — nothing is configured here.
let s3Client, s3Sdk
async function s3() {
  if (!s3Client) {
    s3Sdk = await import('@aws-sdk/client-s3')
    s3Client = new s3Sdk.S3Client({
      region: config.s3.region,
      ...(config.s3.endpoint ? { endpoint: config.s3.endpoint, forcePathStyle: true } : {}),
      maxAttempts: 3,
      requestHandler: { requestTimeout: 20000, connectionTimeout: 5000 },
    })
  }
  return { client: s3Client, sdk: s3Sdk }
}
const s3Driver = {
  async put(key, buffer) {
    const { client, sdk } = await s3()
    try {
      await client.send(new sdk.PutObjectCommand({ Bucket: config.s3.bucket, Key: checkKey(key), Body: buffer, ContentType: 'image/webp', CacheControl: 'public, max-age=2592000, immutable', IfNoneMatch: '*' })) // never overwrite
    } catch (e) {
      throw new Error(`S3 upload failed (${e.name}${e.$metadata?.httpStatusCode ? ' ' + e.$metadata.httpStatusCode : ''}): ${e.message}`)
    }
  },
  async remove(key) {
    const { client, sdk } = await s3()
    try {
      await client.send(new sdk.DeleteObjectCommand({ Bucket: config.s3.bucket, Key: checkKey(key) })) // S3 treats a missing key as success
    } catch (e) {
      if (e.$metadata?.httpStatusCode === 404 || e.name === 'NoSuchKey') return
      throw new Error(`S3 delete failed (${e.name}): ${e.message}`)
    }
  },
  publicUrl: (key) => `/uploads/${checkKey(key)}`,
}
/** Stream one stored image: { body (Readable), contentType, length } or null when it does not exist. Only the s3 driver needs this. */
export async function readObject(key) {
  checkKey(key)
  const { client, sdk } = await s3()
  try {
    const r = await client.send(new sdk.GetObjectCommand({ Bucket: config.s3.bucket, Key: key }))
    return { body: r.Body, contentType: r.ContentType || 'image/webp', length: r.ContentLength }
  } catch (e) {
    if (e.$metadata?.httpStatusCode === 404 || e.name === 'NoSuchKey') return null
    throw e
  }
}

const driver = () => (config.storageDriver === 'supabase' ? supabase : config.storageDriver === 's3' ? s3Driver : local)
export const put = (key, buffer) => driver().put(key, buffer)
export const remove = (key) => driver().remove(key)
export const publicUrl = (key) => driver().publicUrl(key)
export const thumbKey = (key) => key.replace(/\.webp$/, '_t.webp')
/** Origin the browser loads photos from when they are not served by this app (used for the CSP img-src). */
export const externalImageOrigin = () => (config.storageDriver === 'supabase' ? new URL(config.supabase.url).origin : null)
