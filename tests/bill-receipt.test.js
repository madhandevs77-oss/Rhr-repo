// Customer bill (with payment history) and per-payment receipt (split by method); no GST anywhere.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { bookingBody, futureDate, setup } from './helpers.js'

let env, admin, manager, staff, hall, bk
const text = (buf) => { const f = path.join(os.tmpdir(), `br-${process.pid}-${Math.random()}.pdf`); fs.writeFileSync(f, buf); const t = execFileSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' }); fs.rmSync(f); return t }
before(async () => {
  env = await setup()
  admin = await env.client('admin').login(); manager = await env.client('manager').login(); staff = await env.client('staff').login()
  hall = (await admin.post('/api/halls', { name: 'Rcpt Hall', basePrice: 10000 })).body.hall
  bk = (await staff.post('/api/bookings', bookingBody(hall.id, { date: futureDate(40), extraAmount: 500 }))).body.booking
})
after(() => env.teardown())

describe('bill and receipts', () => {
  test('extra amount is in the total, no GST', () => {
    assert.equal(bk.money.total, 10500); assert.equal(bk.money.tax, 0)
  })
  test('advance receipt shows the Cash/Card/GPay split; pending payments have no receipt', async () => {
    const p = (await staff.post(`/api/bookings/${bk.id}/payments`, { amount: 3000, stage: 'advance', paidOn: futureDate(0), splits: [{ method: 'Cash', amount: 1000 }, { method: 'Card', amount: 1000 }, { method: 'GPay', amount: 1000 }] })).body.payment
    assert.equal((await staff.get(`/api/payments/${p.id}/receipt.pdf`, { raw: true })).status, 409)
    await manager.post(`/api/payments/${p.id}/verify`)
    const r = await staff.get(`/api/payments/${p.id}/receipt.pdf`, { raw: true })
    assert.equal(r.status, 200); assert.match(r.res.headers.get('content-type'), /pdf/)
    const t = text(r.buf)
    for (const need of ['ADVANCE RECEIPT', 'Cash', 'Card', 'GPay', 'Amount received', 'Paid so far', 'Balance due', '7,500']) assert.ok(t.includes(need), `receipt missing ${need}`)
    assert.ok(!/GST/.test(t))
  })
  test('customer bill lists advance and final payments with methods, balance, no kitchen-only data', async () => {
    const p2 = (await staff.post(`/api/bookings/${bk.id}/payments`, { amount: 7500, stage: 'final', paidOn: futureDate(0), splits: [{ method: 'UPI', amount: 7500 }] })).body.payment
    await manager.post(`/api/payments/${p2.id}/verify`)
    const r = await staff.get(`/api/bookings/${bk.id}/bill.pdf`, { raw: true })
    assert.equal(r.status, 200)
    const t = text(r.buf)
    for (const need of ['BILL', 'Extra amount', 'Advance', 'Final payment', 'Cash', 'GPay', 'UPI', 'Total paid', 'Balance due', '10,500']) assert.ok(t.includes(need), `bill missing ${need}`)
    assert.ok(!/GST/.test(t))
    assert.equal((await staff.get('/api/bookings/00000000-0000-0000-0000-000000000000/bill.pdf', { raw: true })).status, 404)
  })
})
