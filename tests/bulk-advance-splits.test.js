// Bulk (catering) order: the advance can be paid with one or several methods, each with its own amount.
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { futureDate, setup } from './helpers.js'

let env, query, staff, manager, optA, seq = 0, day = 150
const mk = (extra = {}, as = staff) => as.post('/api/catering', {
  customer: { name: 'Split Cust ' + ++seq, phone: '93000' + String(10000 + seq), messageConsent: true }, serviceOptionId: optA.id, eventType: 'Party', date: futureDate(day++),
  deliveryTime: '11:00', venueName: 'Hall', deliveryAddress: '1 Main Rd', plates: 100, pricingMode: 'per_plate', pricePerPlate: 200, taxRate: 0, ...extra })
const adv = (splits, o = {}) => ({ advance: { amount: splits.reduce((s, x) => s + x.amount, 0), splits, paidOn: futureDate(0), reference: 'adv', verify: true, ...o } })
const dbSplits = async (orderId) => (await query(`SELECT p.id, p.amount AS total, p.method, p.status, p.stage, s.method AS sm, s.amount AS sa FROM payments p LEFT JOIN payment_splits s ON s.payment_id=p.id WHERE p.catering_order_id=$1 ORDER BY s.method`, [orderId])).rows

before(async () => {
  env = await setup(); ({ query } = await import('../server/db/pool.js'))
  staff = await env.client('staff').login(); manager = await env.client('manager').login()
  optA = (await staff.get('/api/catering/options')).body.options[0]
})
after(() => env.teardown())

describe('advance payment methods on a bulk order', () => {
  test('1. Cash only', async () => {
    const r = await mk(adv([{ method: 'Cash', amount: 2500 }])); assert.equal(r.status, 201, JSON.stringify(r.body))
    const rows = await dbSplits(r.body.order.id)
    assert.deepEqual(rows.map((x) => [x.sm, Number(x.sa)]), [['Cash', 2500]]); assert.equal(rows[0].method, 'Cash'); assert.equal(Number(rows[0].total), 2500)
  })
  test('2. UPI only', async () => {
    const r = await mk(adv([{ method: 'UPI', amount: 1800 }])); assert.equal(r.status, 201)
    const rows = await dbSplits(r.body.order.id); assert.deepEqual(rows.map((x) => [x.sm, Number(x.sa)]), [['UPI', 1800]]); assert.equal(rows[0].method, 'UPI')
  })
  test('3. Cash + UPI: one payment, two splits, method "Split", amounts exact', async () => {
    const r = await mk(adv([{ method: 'Cash', amount: 3000 }, { method: 'UPI', amount: 1250.5 }])); assert.equal(r.status, 201, JSON.stringify(r.body))
    const rows = await dbSplits(r.body.order.id)
    assert.equal(rows.length, 2); assert.deepEqual(new Set(rows.map((x) => x.id)).size, 1, 'a single payment row')
    assert.deepEqual(rows.map((x) => [x.sm, Number(x.sa)]).sort(), [['Cash', 3000], ['UPI', 1250.5]])
    assert.equal(rows[0].method, 'Split'); assert.equal(Number(rows[0].total), 4250.5)
    assert.equal(rows.reduce((s, x) => s + Number(x.sa), 0), Number(rows[0].total), 'splits add up to the payment')
  })
  test('4. three methods (Cash, GPay, Bank Transfer) and the full list of supported methods', async () => {
    const r = await mk(adv([{ method: 'Cash', amount: 1000 }, { method: 'GPay', amount: 2000 }, { method: 'Bank Transfer', amount: 3000 }])); assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.deepEqual((await dbSplits(r.body.order.id)).map((x) => [x.sm, Number(x.sa)]).sort(), [['Bank Transfer', 3000], ['Cash', 1000], ['GPay', 2000]])
    const all = ['Cash', 'GPay', 'UPI', 'Bank Transfer', 'Card', 'Other']
    const r2 = await mk(adv(all.map((m) => ({ method: m, amount: 100 })))); assert.equal(r2.status, 201, JSON.stringify(r2.body))
    assert.equal((await dbSplits(r2.body.order.id)).length, 6)
  })
  test('5. total is the sum of the splits and shows in the order detail, payment history and reports', async () => {
    const date = futureDate(200), month = date.slice(0, 7)
    const sumBefore = (await manager.get(`/api/reports/summary?month=${month}`)).body.catering.collected
    const r = await mk({ date, ...adv([{ method: 'Cash', amount: 700 }, { method: 'UPI', amount: 300 }, { method: 'Card', amount: 150 }]) }, manager); assert.equal(r.status, 201)
    const d = (await manager.get(`/api/catering/${r.body.order.id}`)).body.order
    const p = d.payments.find((x) => x.stage === 'advance')
    assert.equal(p.amount, 1150); assert.deepEqual(p.splits.map((s) => [s.method, s.amount]).sort(), [['Card', 150], ['Cash', 700], ['UPI', 300]])
    assert.equal(d.money.paid, 1150)
    const sumAfter = (await manager.get(`/api/reports/summary?month=${month}`)).body.catering.collected
    assert.equal(sumAfter - sumBefore, 1150, 'reports collected total includes the split advance once')
  })
  test('6. wrong splits are rejected and create nothing: mismatch, negative, zero, duplicate, unknown method, empty', async () => {
    const before = (await query('SELECT (SELECT count(*) FROM catering_orders)::int o, (SELECT count(*) FROM payments)::int p, (SELECT count(*) FROM payment_splits)::int s')).rows[0]
    const bad = [
      { amount: 3000, splits: [{ method: 'Cash', amount: 2000 }, { method: 'UPI', amount: 500 }] },     // sum 2500 != 3000
      { amount: 3000, splits: [{ method: 'Cash', amount: 3500 }, { method: 'UPI', amount: -500 }] },    // negative
      { amount: 2000, splits: [{ method: 'Cash', amount: 2000 }, { method: 'UPI', amount: 0 }] },       // zero
      { amount: 2000, splits: [{ method: 'Cash', amount: 1000 }, { method: 'Cash', amount: 1000 }] },   // duplicate method
      { amount: 1000, splits: [{ method: 'Bitcoin', amount: 1000 }] },                                   // unsupported
      { amount: 1000, splits: [] },                                                                      // empty
      { amount: -500, splits: [{ method: 'Cash', amount: -500 }] },                                      // negative total
    ]
    for (const a of bad) { const r = await mk({ advance: { ...a, paidOn: futureDate(0) } }); assert.equal(r.status, 400, JSON.stringify(a) + ' -> ' + r.status) }
    const after = (await query('SELECT (SELECT count(*) FROM catering_orders)::int o, (SELECT count(*) FROM payments)::int p, (SELECT count(*) FROM payment_splits)::int s')).rows[0]
    assert.deepEqual(after, before, 'a rejected advance leaves no order, payment or split behind')
    const m = await mk({ advance: { amount: 3000, splits: [{ method: 'Cash', amount: 2000 }, { method: 'UPI', amount: 500 }], paidOn: futureDate(0) } })
    assert.equal(m.body.error.code, 'SPLIT_MISMATCH')
  })
  test('advance larger than the order total is refused', async () => {
    const r = await mk({ plates: 10, pricePerPlate: 100, ...adv([{ method: 'Cash', amount: 900 }, { method: 'UPI', amount: 900 }]) }); assert.ok([400, 409].includes(r.status), String(r.status))
  })
  test('7. the older request format (single "method", no splits) still works and is stored as one split', async () => {
    const r = await mk({ advance: { amount: 1200, method: 'GPay', paidOn: futureDate(0), verify: true } }); assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.deepEqual((await dbSplits(r.body.order.id)).map((x) => [x.sm, Number(x.sa)]), [['GPay', 1200]])
  })
  test('8. existing payments are untouched by creating split orders', async () => {
    const old = await mk(adv([{ method: 'Cash', amount: 500 }])); const snap = async () => JSON.stringify((await dbSplits(old.body.order.id)))
    const hallPay = (await query('SELECT count(*)::int n, coalesce(sum(amount),0)::text t FROM payments WHERE booking_id IS NOT NULL')).rows[0]
    const before = await snap()
    for (let i = 0; i < 3; i++) assert.equal((await mk(adv([{ method: 'Cash', amount: 100 }, { method: 'UPI', amount: 100 }]))).status, 201)
    assert.equal(await snap(), before)
    assert.deepEqual((await query('SELECT count(*)::int n, coalesce(sum(amount),0)::text t FROM payments WHERE booking_id IS NOT NULL')).rows[0], hallPay, 'hall booking payments unchanged')
  })
  test('a split advance still needs verification by a manager when recorded by staff (verify is ignored for staff)', async () => {
    const r = await mk(adv([{ method: 'Cash', amount: 400 }, { method: 'UPI', amount: 100 }], { verify: false })); assert.equal(r.status, 201)
    const rows = await dbSplits(r.body.order.id); assert.equal(rows[0].status, 'pending')
    const pid = rows[0].id; assert.equal((await manager.post(`/api/payments/${pid}/verify`)).status, 200)
    assert.equal((await dbSplits(r.body.order.id))[0].status, 'verified')
  })
})
