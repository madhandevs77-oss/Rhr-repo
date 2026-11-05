// Invoice lifecycle. Issued invoices are IMMUTABLE (enforced by a DB trigger): corrections supersede or void.
import crypto from 'node:crypto'
import { conflict, notFound } from '../lib/errors.js'
import { fromPaise } from '../lib/money.js'
import { audit, financialYear, getSetting } from './support.js'

const sha = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex')

export function fingerprint(core) {
  return sha(core)
}

export async function nextInvoiceNumber(db, prefix = 'INV', at = new Date()) {
  const fy = financialYear(at)
  const r = await db.query('SELECT next_counter($1,$2,0) n', ['invoice', fy])
  return `${prefix}/${fy}/${String(r.rows[0].n).padStart(6, '0')}`
}

export const invoiceView = (i) => ({
  id: i.id, number: i.invoice_number, bookingId: i.booking_id, cateringOrderId: i.catering_order_id, version: i.version, status: i.status,
  issuedAt: i.issued_at, issueTrigger: i.issue_trigger, total: Number(i.total), paid: Number(i.paid), statusReason: i.status_reason,
  supersededBy: i.superseded_by,
})

export async function listInvoices(db, where, params) {
  const r = await db.query(`SELECT * FROM invoices ${where} ORDER BY issued_at DESC, version DESC`, params)
  return r.rows.map(invoiceView)
}

export const businessBlock = (b) => ({
  name: b.name, legalName: b.legalName || '', phone: b.phone, email: b.email || '', address: b.address, taxId: b.taxId || '',
})

/**
 * Bring the invoice state in line with the money state of a booking / catering order.
 * Must be called inside the transaction that holds the row lock on the document.
 *
 *  - fully paid (verified balance == 0, total > 0) and no live invoice  -> issue exactly one
 *  - live invoice but balance != 0, or invoice-relevant data changed    -> supersede it (never edit)
 *
 * `doc` = { kind: 'booking'|'catering', id, totalPaise, paidPaise, state, fingerprintCore, buildSnapshot(version, number) }
 */
export async function reconcileInvoice(db, ctx, doc, { trigger = 'payment_verified', reason } = {}) {
  const col = doc.kind === 'booking' ? 'booking_id' : 'catering_order_id'
  const fp = fingerprint(doc.fingerprintCore)
  const live = (await db.query(`SELECT * FROM invoices WHERE ${col}=$1 AND status='issued' FOR UPDATE`, [doc.id])).rows[0]
  const result = { issued: null, superseded: null }

  if (live) {
    const stillValid = doc.state === 'paid' && live.fingerprint === fp
    if (stillValid) return result
    const why = reason || (doc.state !== 'paid' ? 'Outstanding balance changed after the invoice was issued' : 'Booking details or charges changed after the invoice was issued')
    await db.query(`UPDATE invoices SET status='superseded', status_reason=$2, status_changed_at=now(), status_changed_by=$3 WHERE id=$1`, [live.id, why, ctx?.user?.id || null])
    await audit(db, ctx, { action: 'Invoice Superseded', entityType: 'invoice', entityId: live.id, summary: `${live.invoice_number}: ${why}` })
    result.superseded = live
  }

  if (doc.state === 'paid' && doc.totalPaise > 0) {
    const prev = (await db.query(`SELECT COALESCE(max(version),0) v FROM invoices WHERE ${col}=$1`, [doc.id])).rows[0].v
    const finance = await getSetting(db, 'finance')
    const number = await nextInvoiceNumber(db, finance.invoicePrefix || 'INV')
    const version = prev + 1
    const snapshot = await doc.buildSnapshot({ version, number })
    try {
      const r = await db.query(
        `INSERT INTO invoices (invoice_number, ${col}, version, issue_trigger, issued_by, total, paid, fingerprint, snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [number, doc.id, version, trigger, ctx?.user?.id || null, fromPaise(doc.totalPaise), fromPaise(doc.paidPaise), fp, JSON.stringify(snapshot)],
      )
      const inv = r.rows[0]
      if (result.superseded) await db.query('UPDATE invoices SET superseded_by=$2 WHERE id=$1', [result.superseded.id, inv.id])
      await audit(db, ctx, { action: 'Invoice Issued', entityType: 'invoice', entityId: inv.id, summary: `${number} v${version}`, details: { trigger } })
      result.issued = inv
      if (prev === 0 && doc.onFirstInvoice) await doc.onFirstInvoice(inv) // e.g. send the customer their bill (first invoice only)
    } catch (e) {
      if (e.code === '23505') return result // a concurrent request already issued it — idempotent
      throw e
    }
  }
  return result
}

export async function getInvoice(db, id) {
  const r = await db.query('SELECT * FROM invoices WHERE id=$1', [id])
  if (!r.rows[0]) throw notFound('Invoice')
  return r.rows[0]
}

export async function voidInvoice(db, ctx, id, reason) {
  const inv = (await db.query('SELECT * FROM invoices WHERE id=$1 FOR UPDATE', [id])).rows[0]
  if (!inv) throw notFound('Invoice')
  if (inv.status !== 'issued') throw conflict(`Invoice is already ${inv.status}`, 'INVOICE_NOT_LIVE')
  await db.query(`UPDATE invoices SET status='void', status_reason=$2, status_changed_at=now(), status_changed_by=$3 WHERE id=$1`, [id, reason, ctx.user.id])
  await audit(db, ctx, { action: 'Invoice Voided', entityType: 'invoice', entityId: id, summary: `${inv.invoice_number}: ${reason}` })
}
