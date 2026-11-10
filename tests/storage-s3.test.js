// Amazon S3 storage driver, run with the real AWS SDK against an in-process S3-compatible HTTP server (path-style).
import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, describe, test } from 'node:test'
import sharp from 'sharp'
import { setup } from './helpers.js'

let env, admin, fake, objects, putCount = 0, failPutNumber = 0, down = false, config, storage, hall
const BUCKET = 'rhr-test-bucket'
const KEY = 'halls/11111111-2222-3333-4444-555555555555.webp'

before(async () => {
  process.env.AWS_ACCESS_KEY_ID = 'AKIATESTONLYNOTREAL'
  process.env.AWS_SECRET_ACCESS_KEY = 'test-only-not-a-real-secret'
  objects = new Map()
  fake = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      if (down) { res.writeHead(503); return res.end('<Error><Code>ServiceUnavailable</Code></Error>') }
      const m = req.url.split('?')[0].match(new RegExp(`^/${BUCKET}/(.+)$`))
      if (!m) { res.writeHead(404); return res.end('<Error><Code>NoSuchBucket</Code></Error>') }
      const key = decodeURIComponent(m[1])
      if (req.method === 'PUT') {
        putCount++
        if (failPutNumber && putCount >= failPutNumber && putCount < failPutNumber + 3) { res.writeHead(500); return res.end('<Error><Code>InternalError</Code></Error>') }
        if (req.headers['if-none-match'] === '*' && objects.has(key)) { res.writeHead(412); return res.end('<Error><Code>PreconditionFailed</Code></Error>') }
        objects.set(key, { body: Buffer.concat(chunks), type: req.headers['content-type'] }); res.writeHead(200, { ETag: '"x"' }); return res.end()
      }
      if (req.method === 'GET') {
        const o = objects.get(key)
        if (!o) { res.writeHead(404, { 'Content-Type': 'application/xml' }); return res.end('<Error><Code>NoSuchKey</Code></Error>') }
        res.writeHead(200, { 'Content-Type': o.type, 'Content-Length': o.body.length }); return res.end(o.body)
      }
      if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); return res.end() }
      res.writeHead(405); res.end()
    })
  })
  await new Promise((r) => fake.listen(0, '127.0.0.1', r))
  env = await setup()
  admin = await env.client('admin').login()
  config = (await import('../server/config.js')).config
  storage = await import('../server/lib/storage.js')
  Object.assign(config, { storageDriver: 's3' })
  Object.assign(config.s3, { bucket: BUCKET, region: 'ap-south-1', endpoint: `http://127.0.0.1:${fake.address().port}` })
  hall = (await admin.post('/api/halls', { name: 'S3 Hall', basePrice: 1000 })).body.hall
})
after(async () => {
  config.storageDriver = 'local'
  await env.teardown()
  await new Promise((r) => fake.close(r))
})
const png = () => sharp({ create: { width: 800, height: 600, channels: 3, background: '#37a' } }).png().toBuffer()
const form = async () => { const fd = new FormData(); fd.append('images', new Blob([await png()], { type: 'image/png' }), 'a.png'); return fd }

describe('S3 storage driver', () => {
  test('put, never overwrite, read back, remove (idempotent)', async () => {
    await storage.put(KEY, Buffer.from('hello'))
    assert.equal(objects.get(KEY).type, 'image/webp')
    await assert.rejects(() => storage.put(KEY, Buffer.from('other')), /S3 upload failed/)
    const r = await storage.readObject(KEY)
    assert.equal(r.contentType, 'image/webp')
    const chunks = []; for await (const c of r.body) chunks.push(c)
    assert.equal(Buffer.concat(chunks).toString(), 'hello')
    await storage.remove(KEY); await storage.remove(KEY)
    assert.equal(await storage.readObject(KEY), null)
  })
  test('refuses keys the server did not generate', async () => {
    await assert.rejects(() => storage.put('../x.webp', Buffer.from('x')), /Invalid storage key/)
    await assert.rejects(() => storage.readObject('halls/../../etc/passwd'), /Invalid storage key/)
  })
  test('upload stores main + thumbnail in the bucket; images are served by the app from the private bucket', async () => {
    const r = await admin.post(`/api/halls/${hall.id}/images`, await form())
    assert.equal(r.status, 201, JSON.stringify(r.body))
    const img = r.body.images[0]
    assert.match(img.url, /^\/uploads\/halls\//)
    assert.equal(objects.size, 2)
    const res = await fetch(env.url + img.url)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'image/webp')
    assert.match(res.headers.get('cache-control'), /immutable/)
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.ok((await res.arrayBuffer()).byteLength > 100)
    const th = await fetch(env.url + img.thumbUrl)
    assert.equal(th.status, 200)
  })
  test('unknown or malformed image paths are 404, not errors', async () => {
    assert.equal((await fetch(env.url + '/uploads/halls/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.webp')).status, 404)
    assert.equal((await fetch(env.url + '/uploads/..%2f..%2fetc%2fpasswd')).status, 404)
  })
  test('thumbnail upload failure leaves no orphan object and no DB row', async () => {
    const before = objects.size
    putCount = 0; failPutNumber = 2
    const r = await admin.post(`/api/halls/${hall.id}/images`, await form())
    failPutNumber = 0
    assert.ok(r.status >= 500, String(r.status))
    assert.equal(objects.size, before)
    assert.equal((await admin.get('/api/halls')).body.halls.find((h) => h.id === hall.id).images.length, 1)
  })
  test('replace swaps the objects; delete removes both', async () => {
    const old = (await admin.get('/api/halls')).body.halls.find((x) => x.id === hall.id).images[0]
    const fd = new FormData(); fd.append('image', new Blob([await png()], { type: 'image/png' }), 'b.png')
    const rep = await admin.post(`/api/halls/${hall.id}/images/${old.id}/replace`, fd)
    assert.equal(rep.status, 200, JSON.stringify(rep.body))
    assert.equal(objects.size, 2)
    assert.equal((await fetch(env.url + old.url)).status, 404)
    assert.equal((await admin.del(`/api/halls/${hall.id}/images/${rep.body.image.id}`)).status, 200)
    assert.equal(objects.size, 0)
  })
  test('when S3 is unreachable, reading answers 502 without internals and uploading fails cleanly', async () => {
    const ok = await admin.post(`/api/halls/${hall.id}/images`, await form())
    assert.equal(ok.status, 201)
    down = true
    try {
      const res = await fetch(env.url + ok.body.images[0].url)
      assert.equal(res.status, 502)
      assert.ok(!/s3|aws|amazon|127\.0\.0\.1/i.test(await res.text()))
      const up = await admin.post(`/api/halls/${hall.id}/images`, await form())
      assert.ok(up.status >= 500)
    } finally { down = false }
  })
})
