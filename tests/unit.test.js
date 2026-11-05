// Pure unit tests (no DB): money parsing and the authoritative pricing/settlement maths.
import test from 'node:test'
import assert from 'node:assert/strict'
import { toPaise, fromPaise, mulQty, pct, MAX_PAISE } from '../server/lib/money.js'
import { bookingTotals, settlement } from '../server/services/pricing.js'

test('toPaise parses exactly and rejects bad input', () => {
  assert.equal(toPaise('1234.50'), 123450)
  assert.equal(toPaise('0.30'), 30)
  assert.equal(toPaise(''), 0)
  assert.equal(toPaise('-5.25'), -525)
  for (const bad of ['1.234', 'abc', '1e5', '12,5', NaN, String(MAX_PAISE)]) assert.throws(() => toPaise(bad), `should reject ${bad}`)
  assert.equal(fromPaise(123450), 1234.5)
})

test('quantity and percentage rounding is integer-safe', () => {
  assert.equal(mulQty(3, 3333), 9999)
  assert.equal(mulQty(2.5, 1000), 2500)
  assert.equal(pct(100000, 5), 5000)
  assert.equal(pct(333, 18), 60)
})

test('booking totals: hall + catering + extras − discount + tax; buckets sum to total', () => {
  const t = bookingTotals(
    { hall_charge: '10000', catering_plates: 100, catering_price_per_plate: '250.50', discount: '1000', tax_rate: 18 },
    [{ description: 'Decoration', quantity: 2, unit_price: '1500' }],
    'Celebration Hall',
  )
  assert.equal(t.subtotal, 1000000 + 2505000 + 300000)
  assert.equal(t.taxable, t.subtotal - 100000)
  assert.equal(t.total, t.taxable + t.tax)
  assert.equal(t.buckets.hall + t.buckets.catering, t.total)
})

test('discount larger than subtotal is rejected', () => {
  assert.throws(() => bookingTotals({ hall_charge: '100', discount: '200', tax_rate: 0 }), /Discount/)
})

test('settlement counts only verified money; refunds subtract; pending is separate', () => {
  const totals = { total: 100000 }
  const pay = (amount, status, kind = 'payment') => ({ amount, status, kind, allocations: status === 'verified' ? [{ bucket: 'hall', amount }] : [] })
  assert.equal(settlement(totals, []).state, 'unpaid')
  let s = settlement(totals, [pay('400', 'verified'), pay('300', 'pending')])
  assert.deepEqual([s.paidTotal, s.pending, s.balance, s.state], [40000, 30000, 60000, 'partial'])
  s = settlement(totals, [pay('1000', 'verified')])
  assert.deepEqual([s.balance, s.state], [0, 'paid'])
  s = settlement(totals, [pay('1000', 'verified'), pay('200', 'verified', 'refund')])
  assert.deepEqual([s.balance, s.state], [20000, 'partial'])
  s = settlement(totals, [pay('1000', 'rejected'), pay('1000', 'reversed')])
  assert.equal(s.state, 'unpaid')
  assert.equal(settlement({ total: 0 }, []).state, 'none')
})
