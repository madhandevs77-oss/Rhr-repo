import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { bookingBody, futureDate, setup } from './helpers.js'

let env, admin, manager, staff, opts, seq = 0
const phone = () => '96000' + String(10000 + ++seq)
const order = (o = {}) => ({
  customer: { name: 'Caterer ' + seq, phone: phone(), messageConsent: true }, serviceOptionId: opts.A.id, eventType: 'Birthday', date: futureDate(20 + seq),
  deliveryTime: '11:00', servingTime: '12:00', venueName: 'Community Hall', deliveryAddress: '12 Main Rd, Sulur', plates: 100, pricingMode: 'per_plate', pricePerPlate: 150, taxRate: 0, ...o,
})
const create = async (c, o) => { const r = await c.post('/api/catering', order(o)); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.order }
const get = async (o) => (await manager.get(`/api/catering/${o.id}`)).body.order
const status = (c, o, to, extra = {}) => c.post(`/api/catering/${o.id}/status`, { to, ...extra })
before(async () => {
  env = await setup()
  admin = await env.client('admin').login(); manager = await env.client('manager').login(); staff = await env.client('staff').login()
  const list = (await staff.get('/api/catering/options')).body.options
  opts = Object.fromEntries(list.map((o) => [o.code, o]))
})
after(() => env.teardown())

describe('catering service options', () => {
  test('three seeded options; admin can rename, staff cannot', async () => {
    assert.deepEqual(Object.keys(opts).sort(), ['A', 'B', 'C'])
    assert.equal(opts.C.requiresVendor, true)
    assert.equal((await staff.patch(`/api/catering/options/${opts.A.id}`, { name: 'Hacked' })).status, 403)
    assert.equal((await admin.patch(`/api/catering/options/${opts.B.id}`, { name: 'Bulk Supply (Renamed)' })).status, 200)
    assert.equal((await staff.get('/api/catering/options')).body.options.find((o) => o.code === 'B').name, 'Bulk Supply (Renamed)')
  })
})

describe('catering orders: pricing & edits', () => {
  test('per-plate total computed on the server (plates × rate + services − discount + tax)', async () => {
    const o = await create(staff, { plates: 120, pricePerPlate: 175.5, deliveryCharge: 500, staffRequired: true, staffCount: 4, staffCharge: 1200, discount: 1000, taxRate: 5 })
    // food 21060 + services 1700 = 22760 − 1000 = 21760; tax 1088 → 22848
    assert.equal(o.money.subtotal, 22760)
    assert.equal(o.money.tax, 1088)
    assert.equal(o.money.total, 22848)
    assert.match(o.reference, /^BC-\d{4}-\d+$/)
    assert.equal(o.status, 'draft')
  })
  test('client-supplied totals are ignored', async () => {
    const o = await create(staff, { total: 1, money: { total: 1 }, subtotal: 1 })
    assert.equal(o.money.total, 15000)
  })
  test('item-based pricing: quantity × unit price per item, decimals handled exactly', async () => {
    const o = await create(staff, { pricingMode: 'item_based', serviceOptionId: opts.B.id, plates: 50, items: [
      { name: 'Veg Biryani', unit: 'kg', quantity: 12.5, unitPrice: 240 }, { name: 'Raita', unit: 'litre', quantity: 8, unitPrice: 60.25 }, { name: 'Gulab Jamun', unit: 'piece', quantity: 150, unitPrice: 12 },
    ] })
    assert.equal(o.money.total, 3000 + 482 + 1800)
    assert.equal(o.items.length, 3)
  })
  test('validation: zero/negative quantity, bad delivery/serving times, staff count, excessive plates, past date', async () => {
    const bad = async (o) => assert.equal((await staff.post('/api/catering', order(o))).status, 400, JSON.stringify(o))
    await bad({ plates: 0 }); await bad({ plates: -3 }); await bad({ pricePerPlate: -1 }); await bad({ deliveryTime: '13:00', servingTime: '12:00' })
    await bad({ staffRequired: true, staffCount: 0 }); await bad({ date: '2020-01-01' }); await bad({ pricingMode: 'item_based', items: [{ name: 'X', unit: 'kg', quantity: 0, unitPrice: 1 }] })
    await bad({ customer: { name: 'A', phone: '12345' } })
  })
  test('edit before confirmation is free; after confirmation a money change needs approval + reason and keeps the old version', async () => {
    const o = await create(staff)
    const body = (v, extra = {}) => ({ ...order({ customer: { name: o.customer.name, phone: o.customer.phone, messageConsent: true }, date: o.date }), expectedVersion: v, ...extra })
    const e1 = await staff.put(`/api/catering/${o.id}`, body(o.version, { plates: 110 }))
    assert.equal(e1.status, 200, JSON.stringify(e1.body)); assert.equal(e1.body.order.money.total, 16500)
    await manager.post(`/api/catering/${o.id}/quotations`)
    assert.equal((await status(staff, o, 'confirmed')).status, 200)
    const cur = await get(o)
    const need = await staff.put(`/api/catering/${o.id}`, body(cur.version, { plates: 130 }))
    assert.ok([403, 409].includes(need.status), `${need.status} ${JSON.stringify(need.body)}`)
    const ok = await manager.put(`/api/catering/${o.id}`, body(cur.version, { plates: 130, confirm: { financial: true }, reason: 'Quantity increased' }))
    assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.order.money.total, 19500)
    const v1 = await manager.get(`/api/catering/${o.id}/versions/${cur.version}`)
    assert.equal(v1.status, 200, JSON.stringify(v1.body))
    assert.equal(JSON.stringify(v1.body).includes('16500'), true, 'previous version preserved with its old total')
    const stale = await manager.put(`/api/catering/${o.id}`, body(cur.version, { plates: 140 }))
    assert.equal(stale.status, 409)
  })
  test('quotation: generated from the current version, immutable, PDF renderable', async () => {
    const o = await create(staff)
    const q = await manager.post(`/api/catering/${o.id}/quotations`)
    assert.equal(q.status, 201, JSON.stringify(q.body))
    const pdf = await manager.get(`/api/catering/quotations/${q.body.quotation.id}/pdf`, { raw: true })
    assert.equal(pdf.status, 200); assert.equal(pdf.buf.slice(0, 5).toString(), '%PDF-')
    const { query } = await import('../server/db/pool.js')
    await assert.rejects(query(`UPDATE catering_quotations SET snapshot='{}'::jsonb WHERE id=$1`, [q.body.quotation.id]))
  })
})

describe('catering lifecycle, vendors, payment vs fulfilment', () => {
  test('state machine rejects illegal jumps; cancellation needs a reason; staff cannot cancel/complete', async () => {
    const o = await create(staff)
    assert.equal((await status(staff, o, 'delivered')).status, 409)
    assert.equal((await status(staff, o, 'preparation')).status, 409)
    assert.equal((await status(staff, o, 'cancelled', { reason: 'x' })).status, 403)
    assert.equal((await status(manager, o, 'cancelled')).status, 400)
    assert.equal((await status(manager, o, 'cancelled', { reason: 'Customer withdrew' })).status, 200)
    assert.equal((await status(manager, o, 'confirmed')).status, 409, 'cancelled is terminal')
    assert.equal((await staff.put(`/api/catering/${o.id}`, { ...order(), expectedVersion: 99 })).status >= 400, true)
  })
  test('Option A end-to-end: draft → confirmed → preparation → ready → delivered → completed; payment status independent', async () => {
    const o = await create(staff)
    for (const to of ['confirmed', 'preparation', 'ready_for_dispatch', 'delivered']) assert.equal((await status(staff, o, to)).status, 200, to)
    let d = await get(o)
    assert.equal(d.status, 'delivered'); assert.equal(d.money.state === 'paid', false, 'delivered but unpaid stays unpaid')
    assert.equal((await status(staff, o, 'completed')).status, 403)
    assert.equal((await status(manager, o, 'completed')).status, 200)
    const p = await staff.post(`/api/catering/${o.id}/payments`, { amount: 15000, method: 'Bank Transfer', paidOn: futureDate(0), stage: 'final' })
    assert.equal(p.status, 201, JSON.stringify(p.body))
    // recorded by staff => pending; not paid until verified
    assert.equal((await get(o)).money.state === 'paid', false)
    await manager.post(`/api/payments/${p.body.payment.id}/verify`)
    d = await get(o)
    assert.equal(d.money.state, 'paid'); assert.equal(d.money.balance, 0)
    const inv = (await manager.get('/api/invoices')).body.invoices.find((i) => i.cateringOrderId === o.id)
    assert.ok(inv, 'catering invoice auto-issued on full verified payment')
    assert.equal(inv.kind, 'catering')
  })
  test('Option C requires a vendor; vendor costs stay separate from customer totals', async () => {
    const o = await create(staff, { serviceOptionId: opts.C.id, pricePerPlate: 200 })
    await status(staff, o, 'confirmed')
    const blocked = await status(staff, o, 'preparation')
    assert.equal(blocked.status, 409); assert.equal(blocked.body.error.code, 'VENDOR_REQUIRED')
    assert.equal((await staff.post('/api/vendors', { name: 'X Caterers' })).status, 403)
    const v = (await manager.post('/api/vendors', { name: 'Annapoorna Caterers ' + seq, phone: '9444400000' })).body.vendor
    assert.equal((await manager.post('/api/vendors', { name: v.name })).status, 409, 'duplicate vendor name')
    const asg = await manager.post(`/api/catering/${o.id}/vendor`, { vendorId: v.id })
    assert.equal(asg.status, 200, JSON.stringify(asg.body))
    assert.equal((await status(staff, o, 'preparation')).status, 409, 'assigned but not accepted')
    assert.equal((await manager.patch(`/api/catering/${o.id}/vendor`, { status: 'accepted' })).status, 409, 'cannot skip steps')
    assert.equal((await manager.patch(`/api/catering/${o.id}/vendor`, { status: 'assigned' })).status, 400, 'agreed cost required')
    assert.equal((await manager.patch(`/api/catering/${o.id}/vendor`, { status: 'assigned', agreedCost: 12000 })).status, 200)
    assert.equal((await manager.patch(`/api/catering/${o.id}/vendor`, { status: 'accepted' })).status, 200)
    assert.equal((await status(staff, o, 'preparation')).status, 200)
    assert.equal((await status(staff, o, 'ready_for_dispatch')).status, 200)
    assert.equal((await status(staff, o, 'delivered')).status, 409, 'vendor delivery must be recorded')
    assert.equal((await manager.patch(`/api/catering/${o.id}/vendor`, { status: 'ready' })).status, 200)
    const del = await manager.patch(`/api/catering/${o.id}/vendor`, { status: 'delivered', finalCost: 12500 })
    assert.equal(del.status, 200, JSON.stringify(del.body))
    assert.equal((await status(staff, o, 'delivered')).status, 200)
    const d = await get(o)
    assert.equal(d.money.total, 20000, 'customer total is unaffected by vendor cost')
    assert.equal(d.vendor.finalCost, 12500)
    // staff must not see vendor-only management actions
    assert.equal((await staff.patch(`/api/catering/${o.id}/vendor`, { status: 'failed' })).status, 403)
  })
  test('exception state needs a reason and can resume', async () => {
    const o = await create(staff)
    await status(staff, o, 'confirmed'); await status(staff, o, 'preparation')
    assert.equal((await status(staff, o, 'exception')).status, 400)
    assert.equal((await status(staff, o, 'exception', { reason: 'Delivery vehicle breakdown' })).status, 200)
    assert.equal((await get(o)).exceptionReason, 'Delivery vehicle breakdown')
    assert.equal((await status(staff, o, 'preparation')).status, 200)
    assert.equal((await get(o)).exceptionReason, null)
  })
  test('cancelling a paid order requires confirmation; payment history survives; invoice voided not deleted', async () => {
    const o = await create(staff)
    const p = (await manager.post(`/api/catering/${o.id}/payments`, { amount: 15000, method: 'UPI', paidOn: futureDate(0), verify: true })).body.payment
    assert.equal(p.status, 'verified')
    const need = await status(manager, o, 'cancelled', { reason: 'Event cancelled' })
    assert.equal(need.status, 409); assert.equal(need.body.error.code, 'CONFIRMATION_REQUIRED')
    assert.equal((await status(manager, o, 'cancelled', { reason: 'Event cancelled', confirm: true })).status, 200)
    const inv = (await manager.get('/api/invoices')).body.invoices.find((i) => i.cateringOrderId === o.id)
    assert.ok(inv); assert.equal(inv.status, 'void')
    assert.equal((await get(o)).money.paid, 15000)
  })
  test('standalone order can be linked to a hall booking; cancelled bookings cannot be linked', async () => {
    const hall = (await admin.post('/api/halls', { name: 'Link Hall', basePrice: 10000 })).body.hall
    const b = (await staff.post('/api/bookings', bookingBody(hall.id, { date: futureDate(200) }))).body.booking
    const o = await create(staff, { bookingId: b.id })
    assert.equal(o.bookingReference, b.reference)
    assert.equal(((await manager.get(`/api/bookings/${b.id}`)).body.booking.linkedCatering || []).length, 1)
    await manager.post(`/api/bookings/${b.id}/cancel`, { reason: 'x', confirm: true })
    assert.equal((await staff.post('/api/catering', order({ bookingId: b.id }))).status, 409)
  })
  test('list supports search and filters', async () => {
    const o = await create(staff, { customer: { name: 'Zainab Fathima', phone: phone() } })
    assert.ok((await staff.get('/api/catering?q=Zainab')).body.orders.some((x) => x.id === o.id))
    assert.ok((await staff.get('/api/catering?status=draft')).body.orders.every((x) => x.status === 'draft'))
    assert.ok((await staff.get(`/api/catering?serviceOptionId=${opts.A.id}`)).body.orders.every((x) => x.serviceOption.code === 'A'))
  })
})

describe('menu management', () => {
  test('manager manages the menu; staff read-only; duplicates blocked', async () => {
    assert.equal((await staff.post('/api/menu', { name: 'Paneer Tikka', category: 'Starters', unitPrice: 220 })).status, 403)
    const m = await manager.post('/api/menu', { name: 'Paneer Tikka', category: 'Starters', unitPrice: 220 })
    assert.equal(m.status, 201, JSON.stringify(m.body))
    assert.equal((await manager.post('/api/menu', { name: 'paneer tikka', category: 'Starters', unitPrice: 1 })).status, 409)
    const o = await create(staff, { pricingMode: 'item_based', items: [{ menuItemId: m.body.item.id, quantity: 10 }], plates: 10 })
    assert.equal(o.money.total, 2200, 'unit price resolved from the menu on the server')
    assert.equal((await staff.get('/api/menu')).body.items.length >= 1, true)
  })
})
