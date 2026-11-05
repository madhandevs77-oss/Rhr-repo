import { Router } from 'express'
import { query, tx } from '../db/pool.js'
import { requirePerm } from '../lib/auth.js'
import { conflict, notFound } from '../lib/errors.js'
import { methodEnum, splitsIn } from '../lib/splits.js'
import { isoDate, money, parse, uuid, z } from '../lib/validate.js'
import { billSnapshot, receiptSnapshot, bookingDetail, bookingView, cancelBooking, createBooking, issueInvoiceNow, listBookings, loadBookingState, restoreBooking, updateBooking } from '../services/bookings.js'
import { getInvoice, invoiceView, voidInvoice } from '../services/invoices.js'
import { enqueueBill, enqueueThanks, eventView } from '../services/notifications.js'
import { paymentView, recordPayment, refundPayment, rejectPayment, reversePayment, verifyPayment } from '../services/payments.js'
import { consumeDraft } from './drafts.js'
import { renderPdf, renderReceipt } from '../services/pdf.js'
import { audit, serializeCustomer } from '../services/support.js'

const ctxOf = (req) => ({ user: req.user, ip: req.ip })

// ================= bookings =================
export const bookingsRouter = Router()
const listQuery = z.object({
  from: isoDate.optional(), to: isoDate.optional(), q: z.string().max(100).optional(), status: z.enum(['tentative', 'confirmed', 'cancelled', 'completed']).optional(),
  hallId: uuid.optional(), customerId: uuid.optional(), payment: z.enum(['pending', 'unverified']).optional(),
})

bookingsRouter.get('/', requirePerm('bookings.view'), async (req, res) => {
  res.json({ bookings: await listBookings({ query }, parse(listQuery, req.query)) })
})
bookingsRouter.post('/', requirePerm('bookings.create'), async (req, res) => {
  const st = await tx(async (c) => { const r = await createBooking(c, ctxOf(req), req.body); await consumeDraft(c, ctxOf(req), req.body?.draftId, 'booking'); return r })
  res.status(201).json({ booking: bookingView(st) })
})
bookingsRouter.get('/:id', requirePerm('bookings.view'), async (req, res) => {
  res.json({ booking: await bookingDetail({ query }, req.params.id) })
})
bookingsRouter.put('/:id', requirePerm('bookings.edit'), async (req, res) => {
  const out = await tx((c) => updateBooking(c, ctxOf(req), req.params.id, req.body))
  res.json({ booking: bookingView(out.state), impact: out.impact })
})
bookingsRouter.patch('/:id/food', requirePerm('bookings.edit'), async (req, res) => {
  const b = parse(z.object({ foodStatus: z.enum(['pending', 'confirmed']), expectedVersion: z.coerce.number().int() }), req.body)
  const st = await tx(async (c) => {
    const cur = await loadBookingState(c, req.params.id, { lock: true })
    if (!cur) throw notFound('Booking')
    if (cur.row.status === 'cancelled') throw conflict('Booking is cancelled', 'CANCELLED')
    if (cur.row.version !== b.expectedVersion) throw conflict('This booking was changed by someone else. Reload it and try again.', 'STALE_VERSION')
    await c.query('UPDATE bookings SET food_status=$2, version=version+1, updated_at=now() WHERE id=$1', [cur.id, b.foodStatus])
    await audit(c, ctxOf(req), { action: 'Food Status Changed', entityType: 'booking', entityId: cur.id, summary: `${cur.row.reference}: ${b.foodStatus}` })
    return loadBookingState(c, cur.id)
  })
  res.json({ booking: bookingView(st) })
})
bookingsRouter.post('/:id/cancel', requirePerm('bookings.cancel'), async (req, res) => {
  const b = parse(z.object({ reason: z.string().trim().max(500).optional(), confirm: z.boolean().optional(), expectedVersion: z.coerce.number().int().optional() }), req.body)
  const st = await tx((c) => cancelBooking(c, ctxOf(req), req.params.id, b))
  res.json({ booking: bookingView(st) })
})
bookingsRouter.post('/:id/restore', requirePerm('bookings.cancel'), async (req, res) => {
  const st = await tx((c) => restoreBooking(c, ctxOf(req), req.params.id))
  res.json({ booking: bookingView(st) })
})

const paymentIn = z.object({
  amount: money, method: methodEnum.default('Cash'), splits: splitsIn, paidOn: isoDate, stage: z.enum(['advance', 'part', 'final']).default('part'),
  reference: z.string().trim().max(100).default(''), notes: z.string().trim().max(300).default(''), bucket: z.enum(['hall', 'catering', 'other']).optional(),
  allocations: z.array(z.object({ bucket: z.enum(['hall', 'catering', 'other']), amount: money })).max(3).optional(),
  idempotencyKey: z.string().trim().max(100).optional(), verify: z.boolean().optional(),
})
export const paymentResponse = (r, res) => res.status(r.duplicate ? 200 : 201).json({ payment: paymentView(r.payment), duplicate: r.duplicate })

bookingsRouter.post('/:id/payments', requirePerm('payments.record'), async (req, res) => {
  const b = parse(paymentIn, req.body)
  const r = await tx((c) => recordPayment(c, ctxOf(req), 'booking', req.params.id, b))
  paymentResponse(r, res)
})
bookingsRouter.get('/:id/bill.pdf', requirePerm('bookings.view'), async (req, res) => {
  const snap = await billSnapshot({ query }, req.params.id)
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="bill-${snap.reference}.pdf"`)
  res.setHeader('Cache-Control', 'private, max-age=0, no-store')
  renderPdf(snap, { kind: 'bill' }).pipe(res)
})
bookingsRouter.post('/:id/invoices/issue', requirePerm('invoices.issue'), async (req, res) => {
  const invoices = await tx((c) => issueInvoiceNow(c, ctxOf(req), req.params.id))
  res.json({ invoices })
})

// ================= payments =================
export const paymentsRouter = Router()
paymentsRouter.get('/pending', requirePerm('payments.verify'), async (_req, res) => {
  const r = await query(
    `SELECT p.*, b.reference AS b_ref, o.reference AS o_ref, COALESCE(c1.name, c2.name) AS customer, u.name AS recorded_by_name
     FROM payments p LEFT JOIN bookings b ON b.id=p.booking_id LEFT JOIN customers c1 ON c1.id=b.customer_id
       LEFT JOIN catering_orders o ON o.id=p.catering_order_id LEFT JOIN customers c2 ON c2.id=o.customer_id LEFT JOIN users u ON u.id=p.recorded_by
     WHERE p.status='pending' ORDER BY p.recorded_at`)
  res.json({ payments: r.rows.map((p) => ({ ...paymentView({ ...p, allocations: [] }), reference2: p.b_ref || p.o_ref, bookingId: p.booking_id, cateringOrderId: p.catering_order_id, customer: p.customer })) })
})
paymentsRouter.get('/:id/receipt.pdf', requirePerm('bookings.view'), async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw notFound('Payment')
  const snap = await receiptSnapshot({ query }, req.params.id)
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="receipt-${snap.number}.pdf"`)
  res.setHeader('Cache-Control', 'private, max-age=0, no-store')
  renderReceipt(snap).pipe(res)
})
paymentsRouter.post('/:id/verify', requirePerm('payments.verify'), async (req, res) => {
  const r = await tx((c) => verifyPayment(c, ctxOf(req), req.params.id))
  res.json({ payment: paymentView(r.payment), already: r.already })
})
paymentsRouter.post('/:id/reject', requirePerm('payments.verify'), async (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body)
  await tx((c) => rejectPayment(c, ctxOf(req), req.params.id, reason))
  res.json({ ok: true })
})
paymentsRouter.post('/:id/reverse', requirePerm('payments.reverse'), async (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body)
  await tx((c) => reversePayment(c, ctxOf(req), req.params.id, reason))
  res.json({ ok: true })
})
paymentsRouter.post('/:id/refund', requirePerm('payments.refund'), async (req, res) => {
  const b = parse(z.object({ amount: money, reason: z.string().trim().min(3).max(300), method: methodEnum.optional(), paidOn: isoDate, reference: z.string().max(100).optional() }), req.body)
  const r = await tx((c) => refundPayment(c, ctxOf(req), req.params.id, b))
  res.status(201).json({ payment: paymentView(r.payment) })
})

// ================= invoices =================
export const invoicesRouter = Router()
invoicesRouter.get('/', requirePerm('invoices.view'), async (req, res) => {
  const q = String(req.query.q || '').trim()
  const params = []
  let where = ''
  if (q) { params.push(`%${q.replace(/[%_\\]/g, '')}%`); where = `WHERE i.invoice_number ILIKE $1 OR i.snapshot->'customer'->>'name' ILIKE $1 OR i.snapshot->>'reference' ILIKE $1` }
  const r = await query(`SELECT i.* FROM invoices i ${where} ORDER BY i.issued_at DESC LIMIT 300`, params)
  res.json({ invoices: r.rows.map((i) => ({ ...invoiceView(i), customer: i.snapshot.customer.name, reference: i.snapshot.reference, kind: i.booking_id ? 'booking' : 'catering' })) })
})
invoicesRouter.get('/:id', requirePerm('invoices.view'), async (req, res) => {
  const inv = await getInvoice({ query }, req.params.id)
  res.json({ invoice: invoiceView(inv), snapshot: inv.snapshot })
})
invoicesRouter.get('/:id/pdf', requirePerm('invoices.view'), async (req, res) => {
  const inv = await getInvoice({ query }, req.params.id)
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${inv.invoice_number.replace(/[^\w.-]+/g, '_')}.pdf"`)
  res.setHeader('Cache-Control', 'private, max-age=0, no-store')
  renderPdf(inv.snapshot, { kind: 'invoice' }).pipe(res) // always rendered from the FROZEN snapshot
})
const sendIn = z.object({ channels: z.array(z.enum(['email', 'phone', 'sms', 'whatsapp'])).min(1).optional() })
invoicesRouter.post('/:id/send', requirePerm('invoices.send'), async (req, res) => {
  const b = parse(sendIn, req.body || {})
  const events = await tx(async (c) => {
    const inv = (await c.query('SELECT * FROM invoices WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0]
    if (!inv) throw notFound('Invoice')
    if (inv.status !== 'issued') throw conflict(`This invoice is ${inv.status}. Only a current invoice can be sent to the customer.`, 'INVOICE_NOT_LIVE')
    const ev = await enqueueBill(c, ctxOf(req), inv, { auto: false, channels: b.channels })
    await audit(c, ctxOf(req), { action: 'Bill Sent To Customer', entityType: 'invoice', entityId: inv.id, summary: `${inv.invoice_number} (${ev.map((e) => e.channel).join(', ') || 'nothing queued'})` })
    return ev
  })
  res.status(201).json({ notifications: events.map(eventView) })
})
bookingsRouter.post('/:id/thank-you', requirePerm('messages.send'), async (req, res) => {
  const b = parse(sendIn, req.body || {})
  const events = await tx((c) => enqueueThanks(c, ctxOf(req), 'booking', req.params.id, { auto: false, channels: b.channels }))
  res.status(201).json({ notifications: events.map(eventView) })
})
invoicesRouter.post('/:id/void', requirePerm('invoices.void'), async (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body)
  await tx((c) => voidInvoice(c, ctxOf(req), req.params.id, reason))
  res.json({ ok: true })
})

// ================= customers =================
export const customersRouter = Router()
customersRouter.get('/', requirePerm('customers.view'), async (req, res) => {
  const q = String(req.query.q || '').trim()
  const params = []
  let where = ''
  if (q) {
    params.push(`%${q.replace(/[%_\\]/g, '')}%`)
    where = `WHERE c.name ILIKE $1`
    const d = q.replace(/\D/g, '')
    if (d) { params.push(`%${d}%`); where += ` OR c.phone LIKE $2` }
  }
  const r = await query(
    `SELECT c.*, (SELECT count(*)::int FROM bookings b WHERE b.customer_id=c.id AND b.status<>'cancelled') AS bookings,
       (SELECT count(*)::int FROM catering_orders o WHERE o.customer_id=c.id AND o.status<>'cancelled') AS orders
     FROM customers c ${where} ORDER BY c.name LIMIT 500`, params)
  res.json({ customers: r.rows.map((c) => ({ ...serializeCustomer(c), bookings: c.bookings, cateringOrders: c.orders })) })
})
customersRouter.patch('/:id', requirePerm('customers.edit'), async (req, res) => {
  const b = parse(z.object({ messageConsent: z.boolean().optional(), language: z.enum(['en', 'ta']).optional(), email: z.string().email().max(120).or(z.literal('')).optional(), address: z.string().max(500).optional(),
    billingName: z.string().max(150).optional(), billingAddress: z.string().max(500).optional(), billingTaxId: z.string().max(40).optional() }), req.body)
  const r = await tx(async (c) => {
    const cur = (await c.query('SELECT * FROM customers WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0]
    if (!cur) throw notFound('Customer')
    const consentChanged = b.messageConsent !== undefined && b.messageConsent !== cur.message_consent
    const u = (await c.query(
      `UPDATE customers SET message_consent=COALESCE($2,message_consent), consent_at=CASE WHEN $3 THEN now() ELSE consent_at END, consent_source=CASE WHEN $3 THEN 'staff_update' ELSE consent_source END,
         language=COALESCE($4,language), email=COALESCE($5,email), address=COALESCE($6,address), billing_name=COALESCE($7,billing_name), billing_address=COALESCE($8,billing_address), billing_tax_id=COALESCE($9,billing_tax_id), updated_at=now()
       WHERE id=$1 RETURNING *`,
      [cur.id, b.messageConsent ?? null, consentChanged, b.language ?? null, b.email === '' ? null : b.email ?? null, b.address ?? null, b.billingName ?? null, b.billingAddress ?? null, b.billingTaxId ?? null],
    )).rows[0]
    await audit(c, ctxOf(req), { action: consentChanged ? `Messaging Consent ${b.messageConsent ? 'Granted' : 'Withdrawn'}` : 'Customer Updated', entityType: 'customer', entityId: cur.id, summary: cur.name })
    return u
  })
  res.json({ customer: serializeCustomer(r) })
})

