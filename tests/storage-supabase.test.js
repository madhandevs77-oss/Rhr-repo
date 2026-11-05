// Supabase Storage driver, exercised over real HTTP against a small in-process server that speaks the same REST routes.
import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, describe, test } from 'node:test'
import sharp from 'sharp'
import { setup } from './helpers.js'

let env, admin, fake, objects, failPutNumber = 0, putCount = 0, config, storage, hall
const KEY = 'halls/11111111-2222-3333-4444-555555555555.webp'

before(async () => {
  objects = new Map()
  fake = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const m = req.url.match(/^\/storage\/v1\/object\/hall-test\/(.+)$/)
      if (req.headers.authorization !== 'Bearer svc-test-key' || !m) { res.writeHead(401); return res.end('{"message":"bad auth"}') }
      const key = decodeURIComponent(m[1])
      if (req.method === 'POST') {
        putCount++
        if (failPutNumber && putCount === failPutNumber) { res.writeHead(500); return res.end('{"message":"boom"}') }
        if (objects.has(key)) { res.writeHead(409); return res.end('{"message":"The resource already exists"}') }
        objects.set(key, Buffer.concat(chunks)); res.writeHead(200); return res.end('{"Key":"ok"}')
      }
      if (req.method === 'DELETE') {
        if (!objects.has(key)) { res.writeHead(404); return res.end('{"message":"Object not found"}') }
        objects.delete(key); res.writeHead(200); return res.end('{}')
      }
      res.writeHead(405); res.end()
    })
  })
  await new Promise((r) => fake.listen(0, '127.0.0.1', r))
  env = await setup()
  admin = await env.client('admin').login()
  config = (await import('../server/config.js')).config
  storage = await import('../server/lib/storage.js')
  Object.assign(config, { storageDriver: 'supabase' })
  Object.assign(config.supabase, { url: `http://127.0.0.1:${fake.address().port}`, serviceKey: 'svc-test-key', bucket: 'hall-test' })
  hall = (await admin.post('/api/halls', { name: 'Cloud Hall', basePrice: 1000 })).body.hall
})
after(async () => {
  config.storageDriver = 'local'
  await env.teardown()
  await new Promise((r) => fake.close(r))
})

const png = (w = 800, h = 600) => sharp({ create: { width: w, height: h, channels: 3, background: '#3a7' } }).png().toBuffer()
const form = async () => { const fd = new FormData(); fd.append('images', new Blob([await png()], { type: 'image/png' }), 'a.png'); return fd }

describe('Supabase storage driver', () => {
  test('put / publicUrl / remove, and remove is idempotent', async () => {
    await storage.put(KEY, Buffer.from('x'))
    assert.ok(objects.has(KEY))
    assert.equal(storage.publicUrl(KEY), `${config.supabase.url}/storage/v1/object/public/hall-test/${KEY}`)
    await assert.rejects(() => storage.put(KEY, Buffer.from('y')), /409/) // never overwrite
    await storage.remove(KEY)
    await storage.remove(KEY) // already gone: no error
    assert.equal(objects.size, 0)
  })
  test('rejects keys the server did not generate', async () => {
    await assert.rejects(() => storage.put('../../etc/passwd', Buffer.from('x')), /Invalid storage key/)
  })
  test('a wrong service key surfaces as an error, not silent success', async () => {
    const k = config.supabase.serviceKey
    config.supabase.serviceKey = 'wrong'
    try { await assert.rejects(() => storage.put(KEY, Buffer.from('x')), /401/) } finally { config.supabase.serviceKey = k }
  })
  test('hall upload stores main + thumbnail in cloud storage and returns cloud URLs', async () => {
    const r = await admin.post(`/api/halls/${hall.id}/images`, await form())
    assert.equal(r.status, 201, JSON.stringify(r.body))
    const img = r.body.images[0]
    assert.ok(img.url.startsWith(config.supabase.url), img.url)
    assert.equal(objects.size, 2)
    assert.ok(objects.has(img.url.split('/hall-test/')[1]))
    assert.ok(objects.has(img.thumbUrl.split('/hall-test/')[1]))
  })
  test('thumbnail upload failure leaves no orphan object and no DB row', async () => {
    const before = objects.size
    putCount = 0; failPutNumber = 2 // main succeeds, thumbnail fails
    const r = await admin.post(`/api/halls/${hall.id}/images`, await form())
    failPutNumber = 0
    assert.ok(r.status >= 500, String(r.status))
    assert.equal(objects.size, before)
    assert.equal((await admin.get('/api/halls')).body.halls.find((h) => h.id === hall.id).images.length, 1)
  })
  test('replace swaps files and deletes the old ones; delete removes both', async () => {
    const h = (await admin.get('/api/halls')).body.halls.find((x) => x.id === hall.id)
    const old = h.images[0]
    const r = await admin.post(`/api/halls/${hall.id}/images/${old.id}/replace`, (() => { const fd = new FormData(); return fd })())
    assert.equal(r.status, 400) // no file -> clean validation error
    const fd = new FormData(); fd.append('image', new Blob([await png(900, 700)], { type: 'image/png' }), 'b.png')
    const rep = await admin.post(`/api/halls/${hall.id}/images/${old.id}/replace`, fd)
    assert.equal(rep.status, 200, JSON.stringify(rep.body))
    assert.equal(objects.size, 2)
    assert.ok(!objects.has(old.url.split('/hall-test/')[1]))
    const del = await admin.del(`/api/halls/${hall.id}/images/${rep.body.image.id}`)
    assert.equal(del.status, 200, JSON.stringify(del.body))
    assert.equal(objects.size, 0)
  })
})
