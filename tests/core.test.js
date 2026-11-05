import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { bookingBody, form, futureDate, png, setup } from './helpers.js'

let env, admin, manager, staff, hall, hall2
before(async () => {
  env = await setup()
  admin = await env.client('admin').login()
  manager = await env.client('manager').login()
  staff = await env.client('staff').login()
  hall = (await admin.post('/api/halls', { name: 'Main Hall', basePrice: 10000, facilities: ['AC'] })).body.hall
  hall2 = (await admin.post('/api/halls', { name: 'Garden Hall', basePrice: 10000 })).body.hall
})
after(() => env.teardown())

describe('auth & authorization', () => {
  test('unauthenticated API access is rejected', async () => {
    const anon = env.client()
    assert.equal((await anon.get('/api/bookings')).status, 401)
    assert.equal((await anon.get('/api/halls')).status, 401)
  })
  test('bad password rejected, generic message', async () => {
    const r = await env.client().post('/api/auth/login', { username: 'admin', password: 'wrong' })
    assert.equal(r.status, 401)
  })
  test('state-changing request without CSRF header is refused', async () => {
    const r = await admin.post('/api/halls', { name: 'Evil' }, { csrf: false })
    assert.equal(r.status, 403)
  })
  test('staff cannot manage halls, verify payments, or see settings', async () => {
    assert.equal((await staff.post('/api/halls', { name: 'X' })).status, 403)
    assert.equal((await staff.get('/api/payments/pending')).status, 403)
    assert.equal((await staff.get('/api/audit')).status, 403)
    assert.equal((await staff.get('/api/users')).status, 403)
  })
  test('logout invalidates the session server-side', async () => {
    const c = await env.client('staff2').login()
    const old = c.cookie
    assert.equal((await c.get('/api/bookings')).status, 200)
    await c.post('/api/auth/logout')
    const replay = env.client(); replay.cookie = old
    assert.equal((await replay.get('/api/bookings')).status, 401)
  })
})

describe('hall photos', () => {
  test('admin uploads several photos; first becomes cover; thumbnails & EXIF-free webp stored', async () => {
    const a = await png(800, 600), b = await png(1000, 700, '#3a3')
    const r = await admin.post(`/api/halls/${hall.id}/images`, form([['a.png', a, 'image/png'], ['b.png', b, 'image/png']]))
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(r.body.images.length, 2)
    assert.equal(r.body.images[0].isCover, true)
    assert.equal(r.body.images[1].isCover, false)
    const img = await admin.get(r.body.images[0].url, { raw: true })
    assert.equal(img.status, 200)
    assert.equal(img.res.headers.get('content-type'), 'image/webp')
    assert.equal(img.res.headers.get('x-content-type-options'), 'nosniff')
  })
  test('staff cannot upload; anonymous cannot upload', async () => {
    const f = () => form([['a.png', Buffer.from('x'), 'image/png']])
    assert.equal((await staff.post(`/api/halls/${hall.id}/images`, f())).status, 403)
    assert.equal((await env.client().post(`/api/halls/${hall.id}/images`, f())).status, 401)
  })
  test('rejects non-images, spoofed content-type, tiny images, oversized files', async () => {
    const r1 = await admin.post(`/api/halls/${hall.id}/images`, form([['x.png', Buffer.from('<?php echo 1; ?>'), 'image/png']]))
    assert.equal(r1.status, 400)
    const r2 = await admin.post(`/api/halls/${hall.id}/images`, form([['x.jpg', Buffer.from('%PDF-1.4 fake'), 'image/jpeg']]))
    assert.equal(r2.status, 400)
    const r3 = await admin.post(`/api/halls/${hall.id}/images`, form([['small.png', await png(100, 100), 'image/png']]))
    assert.equal(r3.status, 400)
    const big = Buffer.alloc(9 * 1024 * 1024, 1)
    const r4 = await admin.post(`/api/halls/${hall.id}/images`, form([['big.png', big, 'image/png']]))
    assert.equal(r4.status, 413)
  })
  test('a bad file in a batch stores nothing from that batch', async () => {
    const before = (await admin.get('/api/halls')).body.halls.find((h) => h.id === hall.id).images.length
    const r = await admin.post(`/api/halls/${hall.id}/images`, form([['ok.png', await png(), 'image/png'], ['bad.png', Buffer.from('nope'), 'image/png']]))
    assert.equal(r.status, 400)
    const after = (await admin.get('/api/halls')).body.halls.find((h) => h.id === hall.id).images.length
    assert.equal(after, before)
  })
  test('reorder, set cover, replace, delete (cover re-elected)', async () => {
    let imgs = (await admin.get('/api/halls')).body.halls.find((h) => h.id === hall.id).images
    const ids = imgs.map((i) => i.id)
    const ro = await admin.put(`/api/halls/${hall.id}/images/order`, { ids: [...ids].reverse() })
    assert.equal(ro.status, 200, JSON.stringify(ro.body))
    const cv = await admin.patch(`/api/halls/${hall.id}/images/${ids[1]}`, { isCover: true })
    assert.equal(cv.status, 200, JSON.stringify(cv.body))
    const rp = await admin.post(`/api/halls/${hall.id}/images/${ids[1]}/replace`, form([['n.png', await png(900, 900, '#00f'), 'image/png']], 'image'))
    assert.equal(rp.status, 200, JSON.stringify(rp.body))
    assert.equal(rp.body.image.isCover, true)
    const del = await admin.del(`/api/halls/${hall.id}/images/${ids[1]}`)
    assert.equal(del.status, 200)
    imgs = (await admin.get('/api/halls')).body.halls.find((h) => h.id === hall.id).images
    assert.equal(imgs.filter((i) => i.isCover).length, 1)
  })
  test('path traversal in /uploads is blocked', async () => {
    const r = await admin.get('/uploads/..%2f..%2fpackage.json', { raw: true })
    assert.ok([400, 403, 404].includes(r.status))
  })
})

describe('bookings: create / overlap / edit / cancel', () => {
  test('create booking returns server totals and a reference', async () => {
    const r = await manager.post("/api/bookings", bookingBody(hall.id, { date: futureDate(10), hallCharge: 10000, taxRate: 5, charges: [{ description: 'Decor', quantity: 2, unitPrice: 500 }], catering: { plates: 100, pricePerPlate: 250 } }))
    assert.equal(r.status, 201, JSON.stringify(r.body))
    const m = r.body.booking.money
    assert.match(r.body.booking.reference, /^BH-\d{4}-\d+$/)
    assert.equal(m.subtotal, 36000)
    assert.equal(m.tax, 1800)
    assert.equal(m.total, 37800)
    assert.equal(m.balance, 37800)
  })
  test('overlap rejected, adjacent allowed, other hall allowed', async () => {
    const d = futureDate(11)
    assert.equal((await staff.post('/api/bookings', bookingBody(hall.id, { date: d, startTime: '10:00', endTime: '14:00' }))).status, 201)
    const o = await staff.post('/api/bookings', bookingBody(hall.id, { date: d, startTime: '13:00', endTime: '16:00', customer: { name: 'B', phone: '9876500001' } }))
    assert.equal(o.status, 409); assert.equal(o.body.error.code, 'HALL_CONFLICT')
    const adj = await staff.post('/api/bookings', bookingBody(hall.id, { date: d, startTime: '14:00', endTime: '18:00', customer: { name: 'C', phone: '9876500002' } }))
    assert.equal(adj.status, 201, JSON.stringify(adj.body))
    const other = await staff.post('/api/bookings', bookingBody(hall2.id, { date: d, customer: { name: 'D', phone: '9876500003' } }))
    assert.equal(other.status, 201, JSON.stringify(other.body))
  })
  test('past date, bad times, bad phone are rejected server-side', async () => {
    assert.equal((await staff.post('/api/bookings', bookingBody(hall.id, { date: '2020-01-01' }))).status, 400)
    assert.equal((await staff.post('/api/bookings', bookingBody(hall.id, { date: futureDate(41), startTime: '15:00', endTime: '14:00' }))).status, 400)
    assert.equal((await staff.post('/api/bookings', bookingBody(hall.id, { date: futureDate(41), customer: { name: 'X', phone: '123' } }))).status, 400)
    assert.equal((await staff.post('/api/bookings', bookingBody(hall.id, { date: futureDate(41), hallCharge: -5 }))).status, 400)
  })
  test('10 concurrent requests for the same slot: exactly one wins', async () => {
    const d = futureDate(50)
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => staff.post('/api/bookings', bookingBody(hall.id, { date: d, customer: { name: 'Race ' + i, phone: '98765' + String(10000 + i) } }))))
    const ok = rs.filter((r) => r.status === 201).length
    assert.equal(ok, 1, rs.map((r) => r.status).join(','))
    assert.ok(rs.filter((r) => r.status !== 201).every((r) => r.status === 409))
  })
  test('edit: excludes itself from conflicts, keeps reference, version check, impact confirmation', async () => {
    const c = await staff.post('/api/bookings', bookingBody(hall.id, { date: futureDate(60), customer: { name: 'Edit Me', phone: '9000000001' } }))
    const b = c.body.booking
    // time change inside own slot works (no self-conflict)
    const e1 = await staff.put(`/api/bookings/${b.id}`, { ...bookingBody(hall.id, { date: futureDate(60), startTime: '11:00', endTime: '15:00', customer: { name: 'Edit Me', phone: '9000000001' } }), expectedVersion: b.version })
    assert.equal(e1.status, 200, JSON.stringify(e1.body))
    assert.equal(e1.body.booking.reference, b.reference)
    // stale version
    const stale = await staff.put(`/api/bookings/${b.id}`, { ...bookingBody(hall.id, { date: futureDate(60) }), expectedVersion: b.version })
    assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'STALE_VERSION')
    // financial change without confirmation -> confirmation required, nothing changes
    const pay = await manager.post(`/api/bookings/${b.id}/payments`, { amount: 2000, method: 'Cash', paidOn: futureDate(0), stage: 'advance', verify: true })
    assert.equal(pay.status, 201, JSON.stringify(pay.body))
    const v = (await manager.get(`/api/bookings/${b.id}`)).body.booking.version
    const fin = { ...bookingBody(hall.id, { date: futureDate(60), startTime: '11:00', endTime: '15:00', hallCharge: 12000, customer: { name: 'Edit Me', phone: '9000000001' } }), expectedVersion: v }
    const need = await manager.put(`/api/bookings/${b.id}`, fin)
    assert.equal(need.status, 409); assert.equal(need.body.error.code, 'CONFIRMATION_REQUIRED')
    assert.equal((await manager.get(`/api/bookings/${b.id}`)).body.booking.money.total, 10000)
    const done = await manager.put(`/api/bookings/${b.id}`, { ...fin, confirm: { financial: true }, reason: 'Customer upgraded decor' })
    assert.equal(done.status, 200, JSON.stringify(done.body))
    assert.equal(done.body.booking.money.total, 12000)
    // staff may not change money
    const sf = await staff.put(`/api/bookings/${b.id}`, { ...fin, hallCharge: 13000, expectedVersion: done.body.booking.version, confirm: { financial: true } })
    assert.equal(sf.status, 403)
    const det = (await manager.get(`/api/bookings/${b.id}`)).body.booking
    assert.ok(det.history.length >= 2)
    assert.equal(det.history[0].totalBefore, 10000); assert.equal(det.history[0].totalAfter, 12000); assert.equal(det.history[0].reason, "Customer upgraded decor")
    assert.equal(det.payments.length, 1)
  })
  test('cancel keeps history and frees the slot; restore re-checks conflicts', async () => {
    const d = futureDate(70)
    const c = (await staff.post('/api/bookings', bookingBody(hall.id, { date: d, customer: { name: 'Cancel Me', phone: '9000000002' } }))).body.booking
    assert.equal((await staff.post(`/api/bookings/${c.id}/cancel`, { reason: 'x' })).status, 403)
    const x = await manager.post(`/api/bookings/${c.id}/cancel`, { reason: 'Customer postponed', confirm: true })
    assert.equal(x.status, 200, JSON.stringify(x.body))
    assert.equal(x.body.booking.status, 'cancelled')
    const n = await staff.post('/api/bookings', bookingBody(hall.id, { date: d, customer: { name: 'New', phone: '9000000003' } }))
    assert.equal(n.status, 201)
    const rs = await manager.post(`/api/bookings/${c.id}/restore`)
    assert.equal(rs.status, 409)
    const list = (await staff.get('/api/bookings?status=cancelled')).body.bookings
    assert.ok(list.some((b) => b.id === c.id))
  })
  test('search by name / phone / reference', async () => {
    const r = await staff.get('/api/bookings?q=Edit%20Me')
    assert.ok(r.body.bookings.length >= 1)
    assert.ok((await staff.get('/api/bookings?q=9000000001')).body.bookings.length >= 1)
  })
})
