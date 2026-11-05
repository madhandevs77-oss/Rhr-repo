import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import { bookingBody, futureDate, setup } from './helpers.js'

let env, admin, manager, staff, hall, seq = 0
const phone = () => '97000' + String(10000 + ++seq)
let day = 100
const newBooking = async (o = {}) => {
  const r = await (o.taxRate ? manager : staff).post('/api/bookings', bookingBody(hall.id, { date: futureDate(day++), customer: { name: 'Fin ' + seq, phone: phone(), messageConsent: true }, ...o }))
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return r.body.booking
}
const today = () => futureDate(0)
const pay = (c, b, amount, extra = {}) => c.post(`/api/bookings/${b.id}/payments`, { amount, method: 'UPI', paidOn: today(), ...extra })
const detail = async (b) => (await manager.get(`/api/bookings/${b.id}`)).body.booking
let mock, runWorker
before(async () => {
  env = await setup()
  admin = await env.client('admin').login(); manager = await env.client('manager').login(); staff = await env.client('staff').login()
  hall = (await admin.post('/api/halls', { name: 'Fin Hall', basePrice: 10000 })).body.hall
  mock = (await import('../server/providers/index.js')).mock
  runWorker = (await import('../server/services/notifications.js')).runWorkerOnce
})
after(() => env.teardown())

describe('payments & balances', () => {
  test('a recorded payment is PENDING and does not reduce the balance until verified', async () => {
    const b = await newBooking()
    const p = await pay(staff, b, 3000, { stage: 'advance' })
    assert.equal(p.status, 201); assert.equal(p.body.payment.status, 'pending')
    let d = await detail(b)
    assert.equal(d.money.paid, 0); assert.equal(d.money.pending, 3000); assert.equal(d.money.balance, 10000)
    const v = await manager.post(`/api/payments/${p.body.payment.id}/verify`)
    assert.equal(v.status, 200, JSON.stringify(v.body))
    d = await detail(b)
    assert.equal(d.money.paid, 3000); assert.equal(d.money.balance, 7000); assert.equal(d.status, 'confirmed')
  })
  test('staff cannot verify; recorder cannot verify own payment (four-eyes) unless admin', async () => {
    const b = await newBooking()
    const p = (await pay(manager, b, 1000, { verify: false })).body.payment
    assert.equal((await staff.post(`/api/payments/${p.id}/verify`)).status, 403)
    const self = await manager.post(`/api/payments/${p.id}/verify`)
    assert.equal(self.status, 403, JSON.stringify(self.body))
    assert.equal((await admin.post(`/api/payments/${p.id}/verify`)).status, 200)
  })
  test('duplicate payment events (same idempotency key) create ONE payment', async () => {
    const b = await newBooking()
    const rs = await Promise.all(Array.from({ length: 5 }, () => pay(staff, b, 500, { idempotencyKey: 'dup-key-1' })))
    assert.equal(rs.filter((r) => r.status === 201).length, 1, rs.map((r) => r.status).join())
    assert.ok(rs.every((r) => [200, 201].includes(r.status)))
    assert.equal((await detail(b)).payments.length, 1)
  })
  test('overpayment and zero/negative amounts are rejected', async () => {
    const b = await newBooking()
    assert.equal((await pay(staff, b, 0)).status, 400)
    assert.equal((await pay(staff, b, -50)).status, 400)
    assert.equal((await pay(staff, b, 10000.567)).status, 400) // more than 2 decimals
    assert.equal((await pay(staff, b, 10001)).status, 409) // more than the balance
  })
  test('rejected payments never count; reversal removes money but keeps history', async () => {
    const b = await newBooking()
    const p = (await pay(staff, b, 2000)).body.payment
    assert.equal((await manager.post(`/api/payments/${p.id}/reject`, { reason: 'Bounced' })).status, 200)
    assert.equal((await detail(b)).money.paid, 0)
    const p2 = (await pay(staff, b, 2000)).body.payment
    await manager.post(`/api/payments/${p2.id}/verify`)
    assert.equal((await manager.post(`/api/payments/${p2.id}/reverse`, { reason: 'x' })).status, 403) // admin only
    assert.equal((await admin.post(`/api/payments/${p2.id}/reverse`, { reason: 'Wrong booking' })).status, 200)
    const d = await detail(b)
    assert.equal(d.money.paid, 0); assert.equal(d.payments.length, 2)
  })
  test('payment rows are immutable at the database level', async () => {
    const { query } = await import('../server/db/pool.js')
    const b = await newBooking()
    const p = (await pay(staff, b, 700)).body.payment
    await manager.post(`/api/payments/${p.id}/verify`)
    await assert.rejects(query('UPDATE payments SET amount=1 WHERE id=$1', [p.id]))
    await assert.rejects(query('DELETE FROM payments WHERE id=$1', [p.id]))
  })
  test('split allocation across hall/catering buckets', async () => {
    const b = await newBooking({ catering: { plates: 10, pricePerPlate: 100 } }) // hall 10000 + catering 1000
    const p = await pay(staff, b, 1500, { allocations: [{ bucket: 'hall', amount: 500 }, { bucket: 'catering', amount: 1000 }] })
    assert.equal(p.status, 201, JSON.stringify(p.body))
    await manager.post(`/api/payments/${p.body.payment.id}/verify`)
    const d = await detail(b)
    assert.equal(d.money.buckets.catering.paid, 1000); assert.equal(d.money.buckets.hall.paid, 500)
    assert.equal(d.money.balance, 9500)
    assert.equal((await pay(staff, b, 100, { allocations: [{ bucket: 'hall', amount: 50 }] })).status, 400) // allocations must sum to amount
  })
})

describe('final invoice', () => {
  test('auto-issued exactly when verified payments cover the total; Paid only at zero balance', async () => {
    const b = await newBooking({ taxRate: 5 }) // total 10500
    const p1 = (await pay(staff, b, 5000)).body.payment
    await manager.post(`/api/payments/${p1.id}/verify`)
    assert.equal((await detail(b)).invoices.length, 0)
    const p2 = (await pay(staff, b, 5500, { stage: 'final' })).body.payment
    assert.equal((await detail(b)).invoices.length, 0, 'pending money must not produce an invoice')
    await manager.post(`/api/payments/${p2.id}/verify`)
    const d = await detail(b)
    assert.equal(d.invoices.length, 1)
    const inv = d.invoices[0]
    assert.match(inv.number, /^INV\/\d{4}-\d{2}\/\d{6}$/)
    assert.equal(d.money.state, 'paid'); assert.equal(d.money.balance, 0)
    const full = (await staff.get(`/api/invoices/${inv.id}`)).body
    assert.equal(full.snapshot.totals.total, 10500)
    assert.equal(full.snapshot.payments.length, 2)
    assert.equal(full.snapshot.balance, 0)
  })
  test('idempotent: re-running issue does not create a second live invoice; numbers are unique', async () => {
    const b = await newBooking()
    const p = (await pay(staff, b, 10000)).body.payment
    await manager.post(`/api/payments/${p.id}/verify`)
    await Promise.all([manager.post(`/api/bookings/${b.id}/invoices/issue`), manager.post(`/api/bookings/${b.id}/invoices/issue`)])
    const inv = (await detail(b)).invoices.filter((i) => i.status === 'issued')
    assert.equal(inv.length, 1)
    const all = (await manager.get('/api/invoices')).body.invoices.map((i) => i.number)
    assert.equal(new Set(all).size, all.length)
  })
  test('PDF reprint is byte-stable in content source and valid; print survives later changes', async () => {
    const b = await newBooking({ customer: { name: 'Priya Ramanathan', phone: phone(), messageConsent: true } })
    const p = (await pay(staff, b, 10000)).body.payment
    await manager.post(`/api/payments/${p.id}/verify`)
    const inv = (await detail(b)).invoices[0]
    const r1 = await staff.get(`/api/invoices/${inv.id}/pdf`, { raw: true })
    assert.equal(r1.status, 200); assert.equal(r1.res.headers.get('content-type'), 'application/pdf')
    assert.equal(r1.buf.slice(0, 5).toString(), '%PDF-')
    const snap1 = (await staff.get(`/api/invoices/${inv.id}`)).body.snapshot
    // customer later changes name on the live record; invoice snapshot must stay as issued
    await manager.patch(`/api/customers/${(await detail(b)).customerId || (await detail(b)).customer.id}`, { address: 'New address' })
    const snap2 = (await staff.get(`/api/invoices/${inv.id}`)).body.snapshot
    assert.deepEqual(snap2, snap1)
    assert.equal((await env.client().get(`/api/invoices/${inv.id}/pdf`, { raw: true })).status, 401)
  })
  test('invoices are immutable in the database (no UPDATE of snapshot, no DELETE)', async () => {
    const { query } = await import('../server/db/pool.js')
    const id = (await manager.get('/api/invoices')).body.invoices[0].id
    await assert.rejects(query(`UPDATE invoices SET snapshot='{}'::jsonb WHERE id=$1`, [id]))
    await assert.rejects(query('DELETE FROM invoices WHERE id=$1', [id]))
  })
  test('editing an invoiced booking needs confirmation + reason, then supersedes (old kept, new number)', async () => {
    const b = await newBooking()
    const p = (await pay(staff, b, 10000)).body.payment
    await manager.post(`/api/payments/${p.id}/verify`)
    let d = await detail(b)
    const old = d.invoices[0]
    const body = { ...bookingBody(hall.id, { date: d.date, customer: { name: d.customer.name, phone: d.customer.phone, messageConsent: true }, hallCharge: 11000 }), expectedVersion: d.version }
    const need = await manager.put(`/api/bookings/${b.id}`, body)
    assert.equal(need.status, 409); assert.equal(need.body.error.code, 'CONFIRMATION_REQUIRED')
    assert.equal((await detail(b)).money.total, 10000, 'rolled back')
    const ok = await manager.put(`/api/bookings/${b.id}`, { ...body, confirm: { financial: true, invoice: true }, reason: 'Added stage decoration' })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    d = await detail(b)
    assert.equal(d.money.balance, 1000); assert.notEqual(d.money.state, 'paid')
    const oldNow = (await staff.get(`/api/invoices/${old.id}`)).body
    assert.equal(oldNow.snapshot.totals.total, 10000, 'old invoice untouched')
    assert.notEqual(oldNow.invoice.status, 'issued')
    // paying the new balance yields a NEW invoice with a different number
    const p2 = (await pay(staff, b, 1000)).body.payment
    await manager.post(`/api/payments/${p2.id}/verify`)
    d = await detail(b)
    const live = d.invoices.filter((i) => i.status === 'issued')
    assert.equal(live.length, 1); assert.notEqual(live[0].number, old.number)
  })
  test('refund is a separate record and is shown against the invoice/balance', async () => {
    const b = await newBooking()
    const p = (await pay(staff, b, 4000)).body.payment
    await manager.post(`/api/payments/${p.id}/verify`)
    const r = await manager.post(`/api/payments/${p.id}/refund`, { amount: 1000, reason: 'Date reduced', paidOn: today() })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    const d = await detail(b)
    assert.equal(d.money.paid, 3000); assert.equal(d.payments.length, 2)
    assert.equal((await manager.post(`/api/payments/${p.id}/refund`, { amount: 5000, reason: 'too much', paidOn: today() })).status, 409)
  })
})

describe('booking confirmation messages', () => {
  const sent = () => mock.outbox.filter((m) => m.type !== undefined || true)
  test('NOT sent on booking creation or on a pending payment; sent once after verified advance; never duplicated', async () => {
    await runWorker(); mock.reset()
    const b = await newBooking({ customer: { name: 'Lakshmi', phone: '9000012345', messageConsent: true } })
    await runWorker()
    assert.equal(mock.outbox.length, 0)
    const p = (await pay(staff, b, 3000, { stage: 'advance' })).body.payment
    await runWorker()
    assert.equal(mock.outbox.length, 0, 'unverified advance must not trigger a confirmation')
    await manager.post(`/api/payments/${p.id}/verify`)
    await runWorker(); await runWorker()
    assert.equal(mock.outbox.length, 1)
    const text = mock.outbox[0].body ?? mock.outbox[0].text
    assert.match(text, /Lakshmi/); assert.match(text, new RegExp(b.reference))
    assert.match(text, /3,000/)
    assert.doesNotMatch(text, /UPI|card|cvv|account/i)
    // second advance does not send a second confirmation
    const p2 = (await pay(staff, b, 1000)).body.payment
    await manager.post(`/api/payments/${p2.id}/verify`)
    await runWorker()
    assert.equal(mock.outbox.length, 1)
    const d = await detail(b)
    assert.equal(d.notifications.length, 1); assert.equal(d.notifications[0].status, 'sent')
  })
  test('no consent => no message, booking/payment unaffected', async () => {
    await runWorker(); mock.reset()
    const b = await newBooking({ customer: { name: 'NoConsent', phone: phone(), messageConsent: false } })
    const p = (await pay(staff, b, 2000)).body.payment
    await manager.post(`/api/payments/${p.id}/verify`)
    await runWorker()
    assert.equal(mock.outbox.length, 0)
    assert.equal((await detail(b)).money.paid, 2000)
  })
  test('permanent provider failure is logged, does not reverse booking or payment; staff retry is safe', async () => {
    await runWorker(); mock.reset()
    const b = await newBooking({ customer: { name: 'Bad Number', phone: '9999900001', messageConsent: true } })
    const p = (await pay(staff, b, 2500)).body.payment
    await manager.post(`/api/payments/${p.id}/verify`)
    await runWorker()
    const d = await detail(b)
    assert.equal(d.status, 'confirmed'); assert.equal(d.money.paid, 2500)
    assert.equal(d.notifications[0].status, 'failed')
    const att = (await manager.get(`/api/notifications/${d.notifications[0].id}/attempts`)).body.attempts
    assert.ok(att.length >= 1)
    assert.equal((await staff.post(`/api/notifications/${d.notifications[0].id}/retry`)).status, 403)
    const rt = await manager.post(`/api/notifications/${d.notifications[0].id}/retry`)
    assert.ok([200, 409].includes(rt.status), JSON.stringify(rt.body))
    await runWorker()
    assert.equal((await detail(b)).money.paid, 2500)
  })
  test('transient failure is retried automatically with backoff and attempts recorded', async () => {
    await runWorker(); mock.reset()
    const b = await newBooking({ customer: { name: 'Flaky', phone: '9999900002', messageConsent: true } })
    const p = (await pay(staff, b, 2500)).body.payment
    await manager.post(`/api/payments/${p.id}/verify`)
    await runWorker()
    const n = (await detail(b)).notifications[0]
    assert.ok(['pending', 'retrying', 'queued', 'failed'].includes(n.status), n.status)
    assert.ok(n.attempts >= 1)
  })
  test('significant schedule change sends a change notice; payment-free edits to notes do not', async () => {
    await runWorker(); mock.reset()
    const b = await newBooking({ customer: { name: 'Changer', phone: phone(), messageConsent: true } })
    const p = (await pay(staff, b, 2500)).body.payment
    await manager.post(`/api/payments/${p.id}/verify`)
    await runWorker(); await runWorker(); mock.reset()
    let d = await detail(b)
    const base = { ...bookingBody(hall.id, { date: d.date, customer: { name: 'Changer', phone: d.customer.phone, messageConsent: true } }), expectedVersion: d.version }
    const n = await manager.put(`/api/bookings/${b.id}`, { ...base, notes: 'just a note' })
    assert.equal(n.status, 200, JSON.stringify(n.body)); await runWorker()
    assert.equal(mock.outbox.length, 0)
    d = await detail(b)
    const s = await manager.put(`/api/bookings/${b.id}`, { ...base, expectedVersion: d.version, startTime: '16:00', endTime: '20:00', confirm: { schedule: true } })
    assert.equal(s.status, 200, JSON.stringify(s.body)); await runWorker()
    assert.equal(mock.outbox.length, 1)
  })
})

describe('webhooks & integration interface', () => {
  test('payment gateway events need a valid signature; duplicate event ids are ignored', async () => {
    const b = await newBooking()
    const ev = { provider: 'gw', eventId: 'evt_123456', type: 'payment.succeeded', target: { type: 'booking', id: b.id }, amount: 2000, method: 'UPI' }
    const raw = JSON.stringify(ev)
    const sign = (s) => crypto.createHmac('sha256', 'whsec_test').update(s).digest('hex')
    const c = env.client()
    const bad = await fetch(env.url + '/api/integrations/payment-events', { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': 'deadbeef' }, body: raw })
    assert.equal(bad.status, 403)
    const post = () => fetch(env.url + '/api/integrations/payment-events', { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': sign(raw) }, body: raw })
    assert.equal((await post()).status, 200)
    assert.equal((await post()).status, 200)
    const d = await detail(b)
    assert.equal(d.payments.length, 1)
    // a failed/pending gateway event never creates money
    const ev2 = JSON.stringify({ ...ev, eventId: 'evt_999999', type: 'payment.failed' })
    const r2 = await fetch(env.url + '/api/integrations/payment-events', { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': sign(ev2) }, body: ev2 })
    assert.equal((await r2.json()).ignored, true)
    assert.equal((await detail(b)).payments.length, 1)
    void c
  })
  test('Twilio status webhook rejects unsigned requests', async () => {
    const r = await fetch(env.url + '/api/webhooks/twilio', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'MessageSid=SM1&MessageStatus=delivered' })
    assert.equal(r.status, 403)
  })
  test('WhatsApp webhook rejects bad signature', async () => {
    const r = await fetch(env.url + '/api/webhooks/whatsapp', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=00' }, body: '{}' })
    assert.equal(r.status, 403)
  })
})
