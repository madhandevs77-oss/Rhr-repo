// Endpoints that no other suite exercises, plus a sweep proving every protected route refuses anonymous callers.
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { bookingBody, futureDate, setup } from './helpers.js'

let env, admin, manager, staff, anon, day = 800, seq = 0
const NIL = '00000000-0000-0000-0000-000000000000'
const phone = () => '96001' + String(10000 + ++seq)
before(async () => {
  env = await setup()
  admin = await env.client('admin').login(); manager = await env.client('manager').login(); staff = await env.client('staff').login()
  anon = env.client('admin') // never logged in
})
after(() => env.teardown())
const code = (r) => r.body?.error?.code ?? r.body?.code

describe('every protected API route refuses anonymous requests', () => {
  test('no route answers 2xx or 5xx without a session', async () => {
    const { createApp } = await import('../server/app.js')
    const app = createApp()
    const routes = []
    const walk = (stack, prefix) => {
      for (const l of stack) {
        if (l.route) for (const m of Object.keys(l.route.methods)) routes.push([m.toUpperCase(), prefix + l.route.path])
        else if (l.name === 'router' && l.handle.stack) {
          const src = l.regexp.source.replace('^\\/?(?=\\/|$)', '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/^\^/, '').replace(/\\\//g, '/')
          walk(l.handle.stack, prefix + src)
        }
      }
    }
    walk(app._router.stack, '')
    const PUBLIC = /^(GET \/api\/health|GET \/healthz|POST \/api\/auth\/login|.* \/api\/webhooks\/.*|POST \/api\/integrations\/payment-events|GET \/api\/auth\/me|POST \/api\/auth\/logout)$/
    const api = routes.filter(([m, p]) => p.startsWith('/api') && !PUBLIC.test(`${m} ${p}`))
    assert.ok(api.length > 80, `expected the full route list, found ${api.length}`)
    const bad = []
    for (const [m, p] of api) {
      const url = p.replace(/\/$/, '').replace(/:[A-Za-z]+/g, NIL)
      const r = await anon.req(m, url, m === 'GET' || m === 'DELETE' ? undefined : {})
      if (r.status !== 401 && r.status !== 403) bad.push(`${m} ${p} -> ${r.status}`)
    }
    assert.deepEqual(bad, [])
  })
  test('health probes are public and reveal nothing sensitive', async () => {
    const h = await anon.get('/healthz')
    assert.equal(h.status, 200)
    assert.deepEqual(h.body, { ok: true })
    const d = await anon.get('/api/health')
    assert.ok(d.status === 200 || d.status === 503)
    assert.ok(!/postgres|password|secret/i.test(JSON.stringify(d.body)))
  })
})

describe('webhooks', () => {
  test('whatsapp verification refuses a request without the right token', async () => {
    assert.equal((await anon.get('/api/webhooks/whatsapp')).status, 403)
    assert.equal((await anon.get('/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1')).status, 403)
  })
})

describe('hall blackouts', () => {
  test('create, validate, authorise and delete', async () => {
    const hall = (await admin.post('/api/halls', { name: 'Blackout Hall', basePrice: 1000 })).body.hall
    const url = `/api/halls/${hall.id}/blackouts`
    assert.equal((await staff.post(url, { startDate: futureDate(5), endDate: futureDate(6) })).status, 403)
    assert.equal((await admin.post(url, { startDate: futureDate(6), endDate: futureDate(5) })).status, 400)
    assert.equal((await admin.post(url, { startDate: 'bad', endDate: futureDate(5) })).status, 400)
    assert.equal((await admin.post(`/api/halls/${NIL}/blackouts`, { startDate: futureDate(5), endDate: futureDate(6) })).status, 404)
    const ok = await admin.post(url, { startDate: futureDate(5), endDate: futureDate(6), reason: 'Painting' })
    assert.equal(ok.status, 201, JSON.stringify(ok.body))
    const h = (await admin.get('/api/halls')).body.halls.find((x) => x.id === hall.id)
    assert.equal(h.blackouts.length, 1)
    const blocked = await staff.post('/api/bookings', bookingBody(hall.id, { date: futureDate(5), hallCharge: undefined, taxRate: undefined, customer: { name: 'Blk', phone: phone(), messageConsent: true } }))
    assert.ok(blocked.status === 409 || blocked.status === 400, `booking on a blackout date must be refused, got ${blocked.status}`)
    assert.equal((await staff.del(`${url}/${ok.body.id}`)).status, 403)
    assert.equal((await admin.del(`${url}/${ok.body.id}`)).status, 200)
    assert.equal((await admin.del(`${url}/${ok.body.id}`)).status, 404)
  })
})

describe('booking food status', () => {
  test('toggle, stale version, bad value, missing booking', async () => {
    const hall = (await admin.post('/api/halls', { name: 'Food Hall', basePrice: 1000 })).body.hall
    const mk = await staff.post('/api/bookings', bookingBody(hall.id, { date: futureDate(day++), hallCharge: undefined, taxRate: undefined, customer: { name: 'Food', phone: phone(), messageConsent: true } }))
    assert.equal(mk.status, 201, JSON.stringify(mk.body))
    const b = mk.body.booking
    assert.equal((await staff.patch(`/api/bookings/${b.id}/food`, { foodStatus: 'maybe', expectedVersion: b.version })).status, 400)
    const ok = await staff.patch(`/api/bookings/${b.id}/food`, { foodStatus: 'confirmed', expectedVersion: b.version })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    const stale = await staff.patch(`/api/bookings/${b.id}/food`, { foodStatus: 'pending', expectedVersion: b.version })
    assert.equal(stale.status, 409)
    assert.equal(code(stale), 'STALE_VERSION')
    assert.equal((await staff.patch(`/api/bookings/${NIL}/food`, { foodStatus: 'pending', expectedVersion: 1 })).status, 404)
  })
})

describe('customers, vendors, menu', () => {
  test('customers list requires login and supports search', async () => {
    assert.equal((await manager.get('/api/customers')).status, 200)
    const r = await manager.get('/api/customers?q=zzzz-no-such-customer')
    assert.equal(r.status, 200)
    assert.equal(r.body.customers.length, 0)
  })
  test('vendors: create, duplicate, update, list; staff cannot manage', async () => {
    const v = await manager.post('/api/vendors', { name: 'Gap Vendor', phone: '9000000099' })
    assert.equal(v.status, 201, JSON.stringify(v.body))
    assert.equal(code(await manager.post('/api/vendors', { name: 'Gap Vendor' })), 'DUPLICATE')
    assert.equal((await staff.post('/api/vendors', { name: 'Nope vendor' })).status, 403)
    assert.equal((await manager.patch(`/api/vendors/${NIL}`, { name: 'zz' })).status, 404)
    const up = await manager.patch(`/api/vendors/${v.body.vendor.id}`, { active: false })
    assert.equal(up.status, 200)
    assert.equal(up.body.vendor.active, false)
    assert.ok((await manager.get('/api/vendors')).body.vendors.some((x) => x.name === 'Gap Vendor'))
  })
  test('legacy menu: patch, delete, 404, permission', async () => {
    const it = await manager.post('/api/menu', { name: 'Gap Dish', category: 'Gap', unitPrice: 50 })
    assert.equal(it.status, 201, JSON.stringify(it.body))
    const id = it.body.item.id
    assert.equal((await staff.patch(`/api/menu/${id}`, { unitPrice: 1 })).status, 403)
    const up = await manager.patch(`/api/menu/${id}`, { unitPrice: 75 })
    assert.equal(up.status, 200)
    assert.equal(up.body.item.unitPrice, 75)
    assert.equal((await manager.patch(`/api/menu/${NIL}`, { name: 'x' })).status, 404)
    assert.equal((await manager.patch(`/api/menu/${id}`, { unit: 'bucket' })).status, 400)
    assert.equal((await staff.del(`/api/menu/${id}`)).status, 403)
    assert.equal((await manager.del(`/api/menu/${id}`)).status, 200)
    assert.equal((await manager.del(`/api/menu/${id}`)).status, 404)
  })
})

describe('catering order extras', () => {
  const order = async (o = {}) => {
    const opts = (await staff.get('/api/catering/options')).body.options
    const r = await staff.post('/api/catering', { customer: { name: 'Gap ' + ++seq, phone: phone(), messageConsent: true }, serviceOptionId: opts[0].id, eventType: 'Birthday', date: futureDate(day++), deliveryTime: '11:00', servingTime: '12:00', venueName: 'V', deliveryAddress: 'A', plates: 10, pricingMode: 'per_plate', pricePerPlate: 100, taxRate: 0, ...o })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    return r.body.order
  }
  test('quotation can be read back; unknown id is 404', async () => {
    const o = await order()
    const q = await manager.post(`/api/catering/${o.id}/quotations`)
    assert.equal(q.status, 201)
    const got = await manager.get(`/api/catering/quotations/${q.body.quotation.id}`)
    assert.equal(got.status, 200)
    assert.equal(got.body.quotation.id, q.body.quotation.id)
    assert.equal((await manager.get(`/api/catering/quotations/${NIL}`)).status, 404)
  })
  test('after delivery and full verified payment: a second thank-you is refused as a duplicate and invoice issue succeeds', async () => {
    const o = await order({ plates: 10, pricePerPlate: 100 }) // total 1000
    for (const to of ['confirmed', 'preparation', 'ready_for_dispatch', 'delivered']) assert.equal((await staff.post(`/api/catering/${o.id}/status`, { to })).status, 200, to)
    // delivery already queued the automatic thank-you, so a manual one is refused (duplicate-notification protection)
    const ty = await admin.post(`/api/catering/${o.id}/thank-you`, {})
    assert.equal(ty.status, 409, JSON.stringify(ty.body))
    assert.equal(code(ty), 'ALREADY_SENDING')
    const p = await manager.post(`/api/catering/${o.id}/payments`, { amount: 1000, method: 'UPI', paidOn: futureDate(0), verify: true })
    assert.equal(p.status, 201, JSON.stringify(p.body))
    const inv = await admin.post(`/api/catering/${o.id}/invoices/issue`, {})
    assert.equal(inv.status, 200, JSON.stringify(inv.body))
    assert.ok(Array.isArray(inv.body.invoices))
  })
  test('invoice cannot be issued until fully paid; thank-you only after delivery', async () => {
    const o = await order()
    const inv = await admin.post(`/api/catering/${o.id}/invoices/issue`, {})
    assert.equal(inv.status, 409)
    assert.equal(code(inv), 'NOT_FULLY_PAID')
    const ty = await admin.post(`/api/catering/${o.id}/thank-you`, {})
    assert.equal(ty.status, 409)
    assert.equal(code(ty), 'BAD_STATE')
    assert.equal((await staff.post(`/api/catering/${o.id}/invoices/issue`, {})).status, 403)
  })
})

describe('notifications & provider status (mock providers only — nothing is sent)', () => {
  test('list, run the queue, provider status; staff is refused where required', async () => {
    assert.equal((await manager.get('/api/notifications')).status, 200)
    const run = await admin.post('/api/notifications/run', {})
    assert.equal(run.status, 200)
    assert.ok(Array.isArray(run.body.results))
    assert.equal((await staff.post('/api/notifications/run', {})).status, 403)
    const st = await admin.get('/api/settings/providers/status')
    assert.equal(st.status, 200)
    assert.ok(!JSON.stringify(st.body).match(/sk_|token|secret|password/i) || typeof st.body.providers.twilioSms === 'boolean')
    assert.equal((await staff.get('/api/settings/providers/status')).status, 403)
  })
})

describe('reports edge cases', () => {
  test('bad month is a 400; an empty month reports zeros, not errors or nulls', async () => {
    assert.equal((await manager.get('/api/reports/summary?month=2026-13x')).status, 400)
    const r = await manager.get('/api/reports/summary?month=2031-02')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.halls.count, 0)
    assert.equal(r.body.halls.billed, 0)
    assert.equal(r.body.halls.outstanding, 0)
    assert.equal(r.body.catering.count, 0)
    assert.equal(r.body.catering.vendor.margin, 0)
  })
})

describe('success paths that were only tested for refusals', () => {
  test('cancel then restore succeeds when the slot is still free, and blocks the slot again', async () => {
    const hall = (await admin.post('/api/halls', { name: 'Restore Hall', basePrice: 1000 })).body.hall
    const body = (n) => bookingBody(hall.id, { date: futureDate(950), hallCharge: undefined, taxRate: undefined, customer: { name: n, phone: phone(), messageConsent: true } })
    const b = (await staff.post('/api/bookings', body('Restore Me'))).body.booking
    assert.equal((await manager.post(`/api/bookings/${b.id}/cancel`, { reason: 'Changed mind', confirm: true })).status, 200)
    const rs = await manager.post(`/api/bookings/${b.id}/restore`)
    assert.equal(rs.status, 200, JSON.stringify(rs.body))
    assert.notEqual(rs.body.booking.status, 'cancelled')
    assert.equal((await staff.post('/api/bookings', body('Late Comer'))).status, 409) // slot is taken again
    assert.equal((await staff.post(`/api/bookings/${b.id}/restore`)).status, 403)
    assert.equal((await manager.post(`/api/bookings/${NIL}/restore`)).status, 404)
  })
  test('an unused hall can be deleted (with its photos); a hall with bookings cannot', async () => {
    const free = (await admin.post('/api/halls', { name: 'Delete Me', basePrice: 1000 })).body.hall
    assert.equal((await staff.del(`/api/halls/${free.id}`)).status, 403)
    assert.equal((await admin.del(`/api/halls/${free.id}`)).status, 200)
    assert.equal((await admin.del(`/api/halls/${free.id}`)).status, 404)
    const used = (await admin.post('/api/halls', { name: 'Keep Me', basePrice: 1000 })).body.hall
    await staff.post('/api/bookings', bookingBody(used.id, { date: futureDate(960), hallCharge: undefined, taxRate: undefined, customer: { name: 'Keep', phone: phone(), messageConsent: true } }))
    const r = await admin.del(`/api/halls/${used.id}`)
    assert.equal(r.status, 409)
    assert.equal(code(r), 'HALL_IN_USE')
  })
  test('pending payments list shows an unverified payment to a verifier and is refused to staff', async () => {
    const hall = (await admin.post('/api/halls', { name: 'Pending Hall', basePrice: 1000 })).body.hall
    const b = (await staff.post('/api/bookings', bookingBody(hall.id, { date: futureDate(970), hallCharge: undefined, taxRate: undefined, customer: { name: 'Pend', phone: phone(), messageConsent: true } }))).body.booking
    const p = await staff.post(`/api/bookings/${b.id}/payments`, { amount: 300, method: 'UPI', paidOn: futureDate(0), idempotencyKey: 'pend-' + b.id })
    assert.equal(p.status, 201, JSON.stringify(p.body))
    const list = await manager.get('/api/payments/pending')
    assert.equal(list.status, 200)
    assert.ok(JSON.stringify(list.body).includes(p.body.payment.id))
    assert.equal((await staff.get('/api/payments/pending')).status, 403)
  })
})
