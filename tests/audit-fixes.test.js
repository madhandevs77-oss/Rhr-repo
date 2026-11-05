import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { bookingBody, futureDate, setup } from './helpers.js'

let env, admin, manager, staff, hall, seq = 0, day = 400
const phone = () => '96000' + String(10000 + ++seq)
const newBooking = async (extra = {}) => {
  const r = await staff.post('/api/bookings', bookingBody(hall.id, { ...extra, date: futureDate(day++), customer: { name: 'Aud ' + seq, phone: phone(), messageConsent: true } }))
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return r.body.booking
}
const pay = (b, body, c = staff) => c.post(`/api/bookings/${b.id}/payments`, { method: 'UPI', paidOn: futureDate(0), ...body })

before(async () => {
  env = await setup()
  admin = await env.client('admin').login(); manager = await env.client('manager').login(); staff = await env.client('staff').login()
  hall = (await admin.post('/api/halls', { name: 'Audit Hall', basePrice: 10000 })).body.hall
})
after(() => env.teardown())

describe('payment allocation & idempotency hardening', () => {
  test('duplicate bucket allocations are aggregated before the balance check', async () => {
    const b = await newBooking({ foodAmount: 5000 }) // hall bucket 10000 + catering 5000, so the TOTAL allows 12000
    const r = await pay(b, { amount: 12000, allocations: [{ bucket: 'hall', amount: 6000 }, { bucket: 'hall', amount: 6000 }] })
    assert.equal(r.status, 409, JSON.stringify(r.body))
    assert.equal(r.body.error?.code ?? r.body.code, 'ALLOCATION_EXCEEDS_BALANCE')
    const ok = await pay(b, { amount: 10000, allocations: [{ bucket: 'hall', amount: 4000 }, { bucket: 'hall', amount: 6000 }] })
    assert.equal(ok.status, 201, JSON.stringify(ok.body))
    assert.equal(ok.body.payment.allocations.filter((a) => a.bucket === 'hall').length, 1) // merged into one row
  })
  test('the same idempotency key on a different booking is refused, never silently reused', async () => {
    const a = await newBooking(), b = await newBooking()
    assert.equal((await pay(a, { amount: 500, idempotencyKey: 'cross-key-1' })).status, 201)
    const r = await pay(b, { amount: 500, idempotencyKey: 'cross-key-1' })
    assert.equal(r.status, 409, JSON.stringify(r.body))
  })
  test('concurrent use of one key across two bookings yields one payment and no 500', async () => {
    const a = await newBooking(), b = await newBooking()
    const rs = await Promise.all([pay(a, { amount: 500, idempotencyKey: 'race-key-1' }), pay(b, { amount: 500, idempotencyKey: 'race-key-1' })])
    assert.ok(rs.every((r) => r.status < 500), rs.map((r) => r.status).join())
    assert.equal(rs.filter((r) => r.status === 201).length, 1)
  })
  test('concurrent payments cannot overshoot the balance', async () => {
    const b = await newBooking()
    const rs = await Promise.all(Array.from({ length: 4 }, (_, i) => pay(b, { amount: 4000, idempotencyKey: 'ovr-' + i + b.id })))
    assert.equal(rs.filter((r) => r.status === 201).length, 2, rs.map((r) => r.status).join())
    const d = (await manager.get(`/api/bookings/${b.id}`)).body.booking
    assert.ok(d.money.paid + d.money.pending <= 10000)
  })
})

describe('sessions & password change', () => {
  test('changing a password invalidates every existing session', async () => {
    const u = (await admin.post('/api/users', { username: 'audpw', name: 'Aud PW', role: 'staff', password: 'Passw0rd-audpw' })).body.user
    assert.ok(u)
    const c1 = await env.client('audpw').login()
    const c2 = await env.client('audpw').login()
    assert.equal((await c2.get('/api/auth/me')).body.user?.username, 'audpw')
    const ch = await c1.post('/api/auth/change-password', { currentPassword: 'Passw0rd-audpw', newPassword: 'AuditPass-67890y' })
    assert.equal(ch.status, 200)
    assert.equal((await c2.get('/api/auth/me')).body.user, null)
    assert.equal((await c1.get('/api/auth/me')).body.user, null)
  })
})
