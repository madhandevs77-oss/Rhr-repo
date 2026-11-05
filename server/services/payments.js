// Payments: verified money is the only money that counts. Pending / rejected / failed payments never
// close a balance, issue an invoice, or trigger a confirmation message.
import { can } from '../lib/auth.js'
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js'
import { fromPaise, inr, toPaise } from '../lib/money.js'
import { normalizeSplits } from '../lib/splits.js'
import { docHandler } from './docs.js'
import { audit } from './support.js'

const BUCKETS = ['hall', 'catering', 'other']

export async function loadPayments(db, kind, id) {
  const col = kind === 'booking' ? 'booking_id' : 'catering_order_id'
  const r = await db.query(
    `SELECT p.*, ru.name AS recorded_by_name, vu.name AS verified_by_name,
       COALESCE((SELECT json_agg(json_build_object('bucket', a.bucket, 'amount', a.amount) ORDER BY a.bucket)
                 FROM payment_allocations a WHERE a.payment_id = p.id), '[]') AS allocations,
       COALESCE((SELECT json_agg(json_build_object('method', s.method, 'amount', s.amount) ORDER BY s.method)
                 FROM payment_splits s WHERE s.payment_id = p.id), '[]') AS splits
     FROM payments p LEFT JOIN users ru ON ru.id = p.recorded_by LEFT JOIN users vu ON vu.id = p.verified_by
     WHERE p.${col} = $1 ORDER BY p.paid_on, p.recorded_at`,
    [id],
  )
  return r.rows
}

export const paymentView = (p) => ({
  id: p.id, kind: p.kind, refundOf: p.refund_of, amount: Number(p.amount), method: p.method, stage: p.stage, paidOn: p.paid_on,
  reference: p.reference, notes: p.notes, status: p.status, statusReason: p.status_reason, source: p.source,
  recordedBy: p.recorded_by_name || null, recordedAt: p.recorded_at, verifiedBy: p.verified_by_name || null, verifiedAt: p.verified_at,
  allocations: (p.allocations || []).map((a) => ({ bucket: a.bucket, amount: Number(a.amount) })),
  splits: (p.splits || []).map((a) => ({ method: a.method, amount: Number(a.amount) })),
})

/** Amount already "committed" per bucket: verified + pending payments, minus verified refunds. */
function committed(payments) {
  const c = { hall: 0, catering: 0, other: 0 }
  for (const p of payments) {
    const active = p.status === 'verified' || (p.status === 'pending' && p.kind === 'payment')
    if (!active) continue
    const sign = p.kind === 'refund' ? -1 : 1
    for (const a of p.allocations || []) c[a.bucket] += sign * toPaise(a.amount)
  }
  return c
}

function allocate(amountP, doc, input) {
  const remaining = {}
  const cm = committed(doc.payments)
  for (const b of BUCKETS) remaining[b] = Math.max(0, (doc.totals.buckets[b] || 0) - cm[b])
  const totalRemaining = remaining.hall + remaining.catering + remaining.other
  if (amountP > totalRemaining) {
    throw conflict(`Payment of ${inr(amountP)} exceeds the outstanding balance of ${inr(totalRemaining)}`, 'PAYMENT_EXCEEDS_BALANCE', { outstanding: fromPaise(totalRemaining) })
  }
  const out = []
  if (Array.isArray(input.allocations) && input.allocations.length) {
    let sum = 0
    const perBucket = {}
    for (const a of input.allocations) {
      const p = toPaise(a.amount, 'allocation')
      if (!BUCKETS.includes(a.bucket) || p <= 0) throw badRequest('Invalid allocation')
      perBucket[a.bucket] = (perBucket[a.bucket] || 0) + p // aggregate duplicates before checking the balance
      sum += p
    }
    for (const [bucket, p] of Object.entries(perBucket)) {
      if (p > remaining[bucket]) throw conflict(`${bucket} allocation exceeds its balance`, 'ALLOCATION_EXCEEDS_BALANCE')
      out.push({ bucket, paise: p })
    }
    if (sum !== amountP) throw badRequest('Allocations must add up to the payment amount')
    return out
  }
  const order = input.bucket && BUCKETS.includes(input.bucket) ? [input.bucket] : ['hall', 'catering', 'other']
  let left = amountP
  for (const b of order) {
    const take = Math.min(left, remaining[b])
    if (take > 0) out.push({ bucket: b, paise: take })
    left -= take
  }
  if (left > 0) throw conflict(`Amount exceeds the ${input.bucket} balance of ${inr(remaining[input.bucket] || 0)}`, 'ALLOCATION_EXCEEDS_BALANCE')
  return out
}

/**
 * Record a payment against a booking or catering order.
 * Idempotent: the same idempotencyKey or the same (provider, externalRef) returns the original payment untouched.
 */
export async function recordPayment(db, ctx, kind, targetId, input) {
  const handler = docHandler(kind)
  const doc = await handler.load(db, targetId, { lock: true })
  if (!doc) throw notFound(kind === 'booking' ? 'Booking' : 'Catering order')

  // idempotency
  const dup = await db.query(
    `SELECT id FROM payments WHERE ($1::text IS NOT NULL AND idempotency_key = $1)
       OR ($2::text IS NOT NULL AND provider = $2 AND external_ref = $3)`,
    [input.idempotencyKey || null, input.provider || null, input.externalRef || null],
  )
  if (dup.rows[0]) {
    const existing = (await loadPayments(db, kind, targetId)).find((p) => p.id === dup.rows[0].id)
    if (existing) return { payment: existing, duplicate: true }
    throw conflict('That payment reference was already used for a different record', 'DUPLICATE_REFERENCE')
  }

  if (doc.cancelled) throw conflict('Cannot record a payment on a cancelled record', 'CANCELLED')
  const amountP = toPaise(input.amount, 'amount')
  if (amountP <= 0) throw badRequest('Amount must be greater than zero')
  const alloc = allocate(amountP, doc, input)
  const { method, splits } = normalizeSplits(amountP, input)

  const gateway = input.source === 'gateway'
  const verified = gateway || (input.verify !== false && can(ctx.user, 'payments.verify'))
  const ins = await db.query(
    `INSERT INTO payments (booking_id, catering_order_id, kind, amount, method, stage, paid_on, reference, notes, status, source, provider,
       external_ref, idempotency_key, recorded_by, verified_by, verified_at)
     VALUES ($1,$2,'payment',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
    [kind === 'booking' ? targetId : null, kind === 'catering' ? targetId : null, fromPaise(amountP), method, input.stage || 'part', input.paidOn,
     input.reference || '', input.notes || '', verified ? 'verified' : 'pending', gateway ? 'gateway' : 'manual', input.provider || null,
     input.externalRef || null, input.idempotencyKey || null, ctx.user?.id || null, verified ? ctx.user?.id || null : null, verified ? new Date() : null],
  )
  const id = ins.rows[0].id
  for (const a of alloc) await db.query('INSERT INTO payment_allocations (payment_id, bucket, amount) VALUES ($1,$2,$3)', [id, a.bucket, fromPaise(a.paise)])
  for (const sp of splits) await db.query('INSERT INTO payment_splits (payment_id, method, amount) VALUES ($1,$2,$3)', [id, sp.method, fromPaise(sp.paise)])
  await audit(db, ctx, {
    action: verified ? 'Payment Recorded & Verified' : 'Payment Recorded (pending verification)', entityType: kind, entityId: targetId,
    summary: `${inr(amountP)} via ${splits.map((x) => `${x.method} ${inr(x.paise)}`).join(' + ')}`, details: { paymentId: id, reference: input.reference || null },
  })
  if (verified) await handler.afterMoney(db, ctx, targetId, { paymentId: id, event: 'payment_verified' })
  const payment = (await loadPayments(db, kind, targetId)).find((p) => p.id === id)
  return { payment, duplicate: false }
}

async function lockPayment(db, paymentId) {
  const p = (await db.query('SELECT * FROM payments WHERE id=$1', [paymentId])).rows[0]
  if (!p) throw notFound('Payment')
  const kind = p.booking_id ? 'booking' : 'catering'
  const targetId = p.booking_id || p.catering_order_id
  const handler = docHandler(kind)
  await handler.load(db, targetId, { lock: true }) // take the document lock first (consistent lock order)
  const cur = (await db.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE', [paymentId])).rows[0]
  return { p: cur, kind, targetId, handler }
}

export async function verifyPayment(db, ctx, paymentId) {
  const { p, kind, targetId, handler } = await lockPayment(db, paymentId)
  if (p.status === 'verified') return { payment: (await loadPayments(db, kind, targetId)).find((x) => x.id === p.id), already: true } // idempotent
  if (p.status !== 'pending') throw conflict(`Payment is ${p.status} and cannot be verified`, 'BAD_STATE')
  if (p.recorded_by && p.recorded_by === ctx.user.id && ctx.user.role !== 'admin') {
    throw forbidden('A different manager must verify a payment you recorded')
  }
  await db.query(`UPDATE payments SET status='verified', verified_by=$2, verified_at=now() WHERE id=$1`, [p.id, ctx.user.id])
  await audit(db, ctx, { action: 'Payment Verified', entityType: kind, entityId: targetId, summary: inr(toPaise(p.amount)), details: { paymentId: p.id } })
  await handler.afterMoney(db, ctx, targetId, { paymentId: p.id, event: 'payment_verified' })
  return { payment: (await loadPayments(db, kind, targetId)).find((x) => x.id === p.id), already: false }
}

export async function rejectPayment(db, ctx, paymentId, reason) {
  const { p, kind, targetId } = await lockPayment(db, paymentId)
  if (p.status !== 'pending') throw conflict(`Only pending payments can be rejected (this one is ${p.status})`, 'BAD_STATE')
  await db.query(`UPDATE payments SET status='rejected', status_reason=$2, verified_by=$3, verified_at=now() WHERE id=$1`, [p.id, reason, ctx.user.id])
  await audit(db, ctx, { action: 'Payment Rejected', entityType: kind, entityId: targetId, summary: `${inr(toPaise(p.amount))}: ${reason}`, details: { paymentId: p.id } })
  return { ok: true }
}

/** Admin-only correction of a wrongly recorded payment. The row is kept; it simply stops counting. */
export async function reversePayment(db, ctx, paymentId, reason) {
  const { p, kind, targetId, handler } = await lockPayment(db, paymentId)
  if (p.kind !== 'payment') throw badRequest('Refunds cannot be reversed here')
  if (!['pending', 'verified'].includes(p.status)) throw conflict(`Payment is already ${p.status}`, 'BAD_STATE')
  const refunds = await db.query(`SELECT 1 FROM payments WHERE refund_of=$1 AND status IN ('verified','pending')`, [p.id])
  if (refunds.rowCount) throw conflict('This payment has refunds against it and cannot be reversed', 'HAS_REFUNDS')
  const wasVerified = p.status === 'verified'
  await db.query(`UPDATE payments SET status='reversed', status_reason=$2 WHERE id=$1`, [p.id, reason])
  await audit(db, ctx, { action: 'Payment Reversed', entityType: kind, entityId: targetId, summary: `${inr(toPaise(p.amount))}: ${reason}`, details: { paymentId: p.id } })
  if (wasVerified) await handler.afterMoney(db, ctx, targetId, { paymentId: p.id, event: 'payment_reversed' })
  return { ok: true }
}

export async function refundPayment(db, ctx, paymentId, { amount, reason, method, paidOn, reference }) {
  const { p, kind, targetId, handler } = await lockPayment(db, paymentId)
  if (p.kind !== 'payment' || p.status !== 'verified') throw conflict('Only verified payments can be refunded', 'BAD_STATE')
  const amountP = toPaise(amount, 'refund amount')
  if (amountP <= 0) throw badRequest('Refund must be greater than zero')
  const all = await loadPayments(db, kind, targetId)
  const orig = all.find((x) => x.id === p.id)
  const refunded = all.filter((x) => x.refund_of === p.id && x.status === 'verified')
  // per-bucket refundable = original allocation - already refunded allocation
  const refundable = { hall: 0, catering: 0, other: 0 }
  for (const a of orig.allocations) refundable[a.bucket] += toPaise(a.amount)
  for (const r of refunded) for (const a of r.allocations) refundable[a.bucket] -= toPaise(a.amount)
  const totalRefundable = refundable.hall + refundable.catering + refundable.other
  if (amountP > totalRefundable) throw conflict(`Only ${inr(totalRefundable)} of this payment can still be refunded`, 'REFUND_EXCEEDS_PAYMENT', { refundable: fromPaise(totalRefundable) })
  const alloc = []
  let left = amountP
  for (const b of ['catering', 'other', 'hall']) {
    const take = Math.min(left, refundable[b])
    if (take > 0) alloc.push({ bucket: b, paise: take })
    left -= take
  }
  const ins = await db.query(
    `INSERT INTO payments (booking_id, catering_order_id, kind, refund_of, amount, method, stage, paid_on, reference, notes, status, recorded_by, verified_by, verified_at)
     VALUES ($1,$2,'refund',$3,$4,$5,'refund',$6,$7,$8,'verified',$9,$9,now()) RETURNING id`,
    [p.booking_id, p.catering_order_id, p.id, fromPaise(amountP), method || (p.method === 'Split' ? 'Cash' : p.method), paidOn, reference || '', reason || '', ctx.user.id],
  )
  for (const a of alloc) await db.query('INSERT INTO payment_allocations (payment_id, bucket, amount) VALUES ($1,$2,$3)', [ins.rows[0].id, a.bucket, fromPaise(a.paise)])
  const refundMethod = method || (p.method === 'Split' ? 'Cash' : p.method)
  await db.query('INSERT INTO payment_splits (payment_id, method, amount) VALUES ($1,$2,$3)', [ins.rows[0].id, refundMethod, fromPaise(amountP)])
  await audit(db, ctx, { action: 'Refund Recorded', entityType: kind, entityId: targetId, summary: `${inr(amountP)}: ${reason || ''}`, details: { paymentId: ins.rows[0].id, refundOf: p.id } })
  await handler.afterMoney(db, ctx, targetId, { paymentId: ins.rows[0].id, event: 'refund' })
  return { payment: (await loadPayments(db, kind, targetId)).find((x) => x.id === ins.rows[0].id) }
}
