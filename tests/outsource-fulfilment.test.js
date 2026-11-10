import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { bookingBody, futureDate, setup } from './helpers.js'

let env, admin, staff, out, hall, day = 600, seq = 0
before(async () => {
  env = await setup()
  admin = await env.client('admin').login(); staff = await env.client('staff').login()
  const halls = (await admin.get('/api/halls')).body.halls
  out = halls.find((h) => h.kind === 'outsource')
  hall = (await admin.post('/api/halls', { name: 'Plain Hall', basePrice: 1000 })).body.hall
})
after(() => env.teardown())
const body = (hallId, extra = {}) => bookingBody(hallId, { date: futureDate(day++), customer: { name: 'Ful ' + ++seq, phone: '9700' + String(100000 + seq), messageConsent: true }, hallCharge: undefined, taxRate: undefined, ...extra })

describe('outsource delivery / takeaway', () => {
  test('outsource booking defaults to takeaway and stores no address', async () => {
    const r = await staff.post('/api/bookings', body(out.id))
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(r.body.booking.fulfilment, 'takeaway')
    assert.equal(r.body.booking.deliveryAddress, '')
  })
  test('delivery needs an address', async () => {
    const r = await staff.post('/api/bookings', body(out.id, { fulfilment: 'delivery', deliveryAddress: '  ' }))
    assert.equal(r.status, 400, JSON.stringify(r.body))
    assert.equal(r.body.error?.code ?? r.body.code, 'DELIVERY_ADDRESS_REQUIRED')
  })
  test('delivery with address is saved, shown on the calendar day view, and can be switched to takeaway', async () => {
    const b = body(out.id, { fulfilment: 'delivery', deliveryAddress: '12 Gandhi Nagar, Sulur' })
    const r = await staff.post('/api/bookings', b)
    assert.equal(r.status, 201, JSON.stringify(r.body))
    const cal = (await staff.get(`/api/calendar/day?date=${b.date}&group=outsource`)).body
    const row = cal.sections.flatMap((s) => s.bookings).find((x) => x.id === r.body.booking.id)
    assert.equal(row.fulfilment, 'delivery')
    assert.equal(row.deliveryAddress, '12 Gandhi Nagar, Sulur')
    const m = (await staff.get(`/api/calendar?month=${b.date.slice(0, 7)}&group=outsource`)).body
    assert.ok(m.days[b.date] >= 1)
    const upd = await staff.put(`/api/bookings/${r.body.booking.id}`, { ...b, fulfilment: 'takeaway', deliveryAddress: 'ignored', expectedVersion: r.body.booking.version })
    assert.equal(upd.status, 200, JSON.stringify(upd.body))
    assert.equal(upd.body.booking.fulfilment, 'takeaway')
    assert.equal(upd.body.booking.deliveryAddress, '')
  })
  test('a normal hall never stores delivery details', async () => {
    const r = await staff.post('/api/bookings', body(hall.id, { fulfilment: 'delivery', deliveryAddress: 'x' }))
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(r.body.booking.fulfilment, null)
    assert.equal(r.body.booking.deliveryAddress, '')
  })
})
