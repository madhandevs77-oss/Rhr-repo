import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { bookingBody, futureDate, setup } from './helpers.js'

let env, query, admin, manager, staff, anon, hall, seq = 0, day = 300
const phone = () => '95000' + String(10000 + ++seq)
const body = (o = {}) => bookingBody(hall.id, { date: futureDate(day++), hallCharge: undefined, taxRate: undefined, customer: { name: 'Int ' + seq, phone: phone(), messageConsent: true }, ...o })
before(async () => {
  env = await setup(); ({ query } = await import('../server/db/pool.js'))
  admin = await env.client('admin').login(); manager = await env.client('manager').login(); staff = await env.client('staff').login(); anon = env.client()
  hall = (await admin.post('/api/halls', { name: 'Integrity Hall', basePrice: 10000 })).body.hall
})
after(() => env.teardown())

describe('booking input and reference integrity', () => {
  test('unknown, malformed and deactivated hall references are rejected without creating anything', async () => {
    const before = (await query('SELECT count(*)::int n FROM bookings')).rows[0].n
    const unknown = await staff.post('/api/bookings', body({ hallId: '00000000-0000-4000-8000-000000000000' }))
    assert.ok([400, 404, 409].includes(unknown.status), `unknown hall: ${unknown.status} ${JSON.stringify(unknown.body)}`)
    assert.equal((await staff.post('/api/bookings', body({ hallId: 'not-a-uuid' }))).status, 400)
    assert.equal((await staff.post('/api/bookings', body({ hallId: "x'; DROP TABLE bookings;--" }))).status, 400)
    const off = (await admin.post('/api/halls', { name: 'Closed Hall', basePrice: 1000 })).body.hall
    assert.equal((await admin.patch(`/api/halls/${off.id}`, { active: false })).status, 200)
    const closed = await staff.post('/api/bookings', body({ hallId: off.id }))
    assert.ok([400, 404, 409].includes(closed.status), `deactivated hall: ${closed.status}`)
    assert.equal((await query('SELECT count(*)::int n FROM bookings')).rows[0].n, before)
  })
  test('invalid dates and times are rejected (impossible date, wrong format, end before start, zero length)', async () => {
    for (const o of [{ date: '2027-02-30' }, { date: '31/12/2027' }, { date: '' }, { startTime: '25:00' }, { startTime: '14:00', endTime: '10:00' }, { startTime: '10:00', endTime: '10:00' }]) {
      const r = await staff.post('/api/bookings', body(o)); assert.equal(r.status, 400, `${JSON.stringify(o)} -> ${r.status}`)
    }
  })
  test('blackout dates refuse a booking', async () => {
    const date = futureDate(day++)
    assert.equal((await admin.post(`/api/halls/${hall.id}/blackouts`, { startDate: date, endDate: date, reason: 'Maintenance' })).status < 300, true)
    const r = await staff.post('/api/bookings', body({ date })); assert.ok([400, 409].includes(r.status), String(r.status))
  })
  test('anonymous callers cannot create, edit or cancel bookings', async () => {
    const b = (await staff.post('/api/bookings', body())).body.booking
    assert.equal((await anon.post('/api/bookings', body())).status, 401)
    assert.equal((await anon.put(`/api/bookings/${b.id}`, { ...body(), expectedVersion: b.version })).status, 401)
    assert.equal((await anon.post(`/api/bookings/${b.id}/cancel`, { reason: 'x' })).status, 401)
  })
})

describe('editing and cancelling never corrupts the payment ledger', () => {
  test('payment rows are untouched by a booking edit; balance follows the new total; cancel/restore keeps payments', async () => {
    const created = await manager.post('/api/bookings', body({ hallCharge: 10000, taxRate: 0 }))
    assert.equal(created.status, 201, JSON.stringify(created.body)); const b = created.body.booking
    const p = await manager.post(`/api/bookings/${b.id}/payments`, { amount: 4000, method: 'Cash', paidOn: futureDate(0), stage: 'advance', verify: true })
    assert.equal(p.status, 201, JSON.stringify(p.body))
    const ledger = async () => (await query('SELECT id, amount, status, booking_id FROM payments WHERE booking_id=$1 ORDER BY id', [b.id])).rows
    const before = await ledger()
    const v = (await manager.get(`/api/bookings/${b.id}`)).body.booking.version
    const edit = await manager.put(`/api/bookings/${b.id}`, { ...body({ date: b.date, hallCharge: 15000, taxRate: 0, customer: { name: b.customer.name, phone: b.customer.phone } }), expectedVersion: v, confirm: { financial: true }, reason: 'Upgrade' })
    assert.equal(edit.status, 200, JSON.stringify(edit.body))
    assert.deepEqual(await ledger(), before, 'payment rows identical after the edit')
    const d = (await manager.get(`/api/bookings/${b.id}`)).body.booking
    assert.equal(d.money.total, 15000); assert.equal(d.money.paid, 4000); assert.equal(d.money.balance, 11000)
    const refused = await manager.post(`/api/bookings/${b.id}/cancel`, { reason: 'Customer cancelled' })
    assert.equal(refused.status, 409); assert.equal(refused.body.error.code, 'CONFIRMATION_REQUIRED', 'cancelling a paid booking needs explicit confirmation')
    assert.deepEqual(await ledger(), before)
    const c = await manager.post(`/api/bookings/${b.id}/cancel`, { reason: 'Customer cancelled', confirm: true })
    assert.equal(c.status, 200, JSON.stringify(c.body))
    assert.deepEqual(await ledger(), before, 'cancel keeps payments (refund is a separate, audited step)')
    const r = await manager.post(`/api/bookings/${b.id}/restore`, {})
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(await ledger(), before)
    assert.equal((await manager.get(`/api/bookings/${b.id}`)).body.booking.money.balance, 11000)
  })
})
