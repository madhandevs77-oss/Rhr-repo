// Validated, idempotent migration of the old browser-only data (localStorage "rhr_state_v2" / backup JSON).
// Runs inside ONE transaction; with dryRun it is rolled back so staff can preview the report first.
import { badRequest } from '../lib/errors.js'
import { fromPaise, toPaise } from '../lib/money.js'
import { audit, nextRef, raiseCounter } from './support.js'

const digits = (s) => String(s || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '')
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(new Date(s + 'T00:00:00Z').getTime())
const safeMoney = (v) => { try { return toPaise(v ?? 0) } catch { return null } }

export async function importLegacy(db, ctx, raw, { dryRun = false } = {}) {
  const data = raw?.data || raw
  if (!data || !Array.isArray(data.bookings)) throw badRequest('This is not a valid RHR backup file (no bookings list found)')
  const report = { halls: { created: 0, matched: 0 }, menu: { created: 0, matched: 0 }, customers: { created: 0, matched: 0 }, bookings: { imported: 0, alreadyPresent: 0, skipped: [], importedAsCancelled: [] }, payments: { imported: 0, alreadyPresent: 0, skipped: 0 }, warnings: [], dryRun }

  // ---- halls (match by name; photos stored as old data-URLs are not migrated) ----
  const hallMap = new Map()
  for (const h of data.halls || []) {
    if (!h?.name) continue
    const found = (await db.query('SELECT id FROM halls WHERE lower(name)=lower($1)', [h.name])).rows[0]
    if (found) { hallMap.set(h.id, found.id); report.halls.matched++; continue }
    const r = await db.query('INSERT INTO halls (name, description, legacy_id) VALUES ($1,$2,$3) RETURNING id', [String(h.name).slice(0, 100), String(h.description || '').slice(0, 2000), String(h.id)])
    hallMap.set(h.id, r.rows[0].id)
    report.halls.created++
    report.warnings.push(`Hall "${h.name}" was created without photos; upload them in Manage Halls.`)
  }

  // ---- menu ----
  for (const f of data.food || []) {
    if (!f?.name || !f?.cat) continue
    const price = safeMoney(f.price)
    const r = await db.query('INSERT INTO menu_items (name, category, unit_price, legacy_id) VALUES ($1,$2,$3,$4) ON CONFLICT (category, lower(name)) DO NOTHING RETURNING id', [String(f.name).slice(0, 150), String(f.cat).slice(0, 80), price === null ? 0 : fromPaise(price), String(f.id || '')])
    r.rowCount ? report.menu.created++ : report.menu.matched++
  }

  // ---- bookings ----
  const bookingMap = new Map()
  const bookingKeys = new Map()
  let maxRef = 1000
  const refYear = String(new Date().getFullYear())
  for (const b of data.bookings) {
    const label = `${b.bookingId || b.id || '?'} (${b.name || 'no name'})`
    const phone = digits(b.phone)
    if (!b.name || !/^\d{10}$/.test(phone)) { report.bookings.skipped.push({ booking: label, reason: 'Missing name or a valid 10-digit phone' }); continue }
    if (!isDate(b.date)) { report.bookings.skipped.push({ booking: label, reason: 'Invalid function date' }); continue }
    const hallId = hallMap.get(b.hallId) || (await db.query('SELECT id FROM halls WHERE legacy_id=$1', [String(b.hallId)])).rows[0]?.id
    if (!hallId) { report.bookings.skipped.push({ booking: label, reason: 'Hall not found' }); continue }
    let ref = String(b.bookingId || '').slice(0, 40)
    const legacyKey = `${ref}|${b.id ?? ''}|${b.date}|${phone}`.slice(0, 200)
    const ex = (await db.query('SELECT id FROM bookings WHERE legacy_id=$1', [legacyKey])).rows[0]
    if (ex) { bookingMap.set(b.id, ex.id); bookingKeys.set(b.id, legacyKey); report.bookings.alreadyPresent++; continue }
    let refNote = ''
    if (!ref || (await db.query('SELECT 1 FROM bookings WHERE reference=$1', [ref])).rowCount) {
      // never merge with, or overwrite, a different booking that happens to use the same reference
      if (ref) refNote = `Imported: old reference ${ref} was already in use, so a new one was issued.`
      ref = await nextRef(db, 'booking', refYear, 'BH', 1000)
    }
    const hallCharge = safeMoney(b.hallTotal)
    if (hallCharge === null) { report.bookings.skipped.push({ booking: label, reason: 'Invalid hall amount' }); continue }

    let cust = (await db.query('SELECT id FROM customers WHERE phone=$1', [phone])).rows[0]
    if (!cust) {
      const alt = digits(b.altPhone)
      cust = (await db.query('INSERT INTO customers (name, phone, alt_phone, address, notes) VALUES ($1,$2,$3,$4,$5) RETURNING id', [String(b.name).trim().slice(0, 120), phone, /^\d{10}$/.test(alt) ? alt : null, String(b.address || '').slice(0, 500), String(b.custNotes || '').slice(0, 1000)])).rows[0]
      report.customers.created++
    } else report.customers.matched++

    const start = /^\d{2}:\d{2}$/.test(b.startTime || '') ? b.startTime : '00:00'
    let end = /^\d{2}:\d{2}$/.test(b.endTime || '') ? b.endTime : '23:59'
    if (end <= start) end = '23:59'
    const timeGuessed = !b.startTime || !b.endTime
    let status = ['confirmed', 'cancelled'].includes(b.status) ? b.status : 'tentative'
    const plates = b.catering?.plates ? parseInt(b.catering.plates, 10) : null
    const ppp = b.catering?.pricePerPlate ? safeMoney(b.catering.pricePerPlate) : null
    const foodItems = JSON.stringify((b.foodItems || []).map((f) => ({ id: null, name: String(typeof f === 'string' ? f : f.name).slice(0, 120) })))
    const insertRow = async (st, note) => (await db.query(
      `INSERT INTO bookings (reference, customer_id, hall_id, event_type, event_date, start_time, end_time, hall_charge, catering_plates, catering_price_per_plate, food_items, food_status, notes, status, cancelled_at, legacy_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [ref, cust.id, hallId, String(b.eventType || 'Other').slice(0, 60), b.date, start, end, fromPaise(hallCharge), plates, ppp === null ? null : fromPaise(ppp), foodItems,
       b.foodStatus === 'confirmed' ? 'confirmed' : 'pending', [String(b.bookingNotes || ''), note, refNote].filter(Boolean).join(' | ').slice(0, 2000), st, st === 'cancelled' ? new Date() : null, legacyKey])).rows[0].id
    await db.query('SAVEPOINT bk')
    let id
    try {
      id = await insertRow(status, timeGuessed ? 'Imported: times were not recorded; whole day assumed.' : '')
      await db.query('RELEASE SAVEPOINT bk')
    } catch (e) {
      await db.query('ROLLBACK TO SAVEPOINT bk')
      if (e.code !== '23P01') { report.bookings.skipped.push({ booking: label, reason: e.message }); continue }
      // legacy data contained a double booking: keep the record (as cancelled) rather than lose it, and say so
      id = await insertRow('cancelled', 'Imported as CANCELLED: overlapped another booking in the old system. Review and resolve.')
      report.bookings.importedAsCancelled.push({ booking: label, reason: 'Overlapped another booking for the same hall and time' })
    }
    if (timeGuessed) report.warnings.push(`${label}: no start/end time was recorded; the whole day is blocked. Please edit it.`)
    const m = /(\d+)$/.exec(ref)
    if (m && ref.startsWith(`BH-${refYear}-`)) maxRef = Math.max(maxRef, parseInt(m[1], 10))
    bookingMap.set(b.id, id)
    bookingKeys.set(b.id, legacyKey)
    report.bookings.imported++
  }
  await raiseCounter(db, 'booking', refYear, maxRef)

  // ---- payments (trusted history: imported as verified; no messages, no invoices are triggered) ----
  for (const p of data.payments || []) {
    const bid = bookingMap.get(p.bookingId)
    const amt = safeMoney(p.amount)
    if (!bid || !amt || amt <= 0 || !isDate(p.date)) { report.payments.skipped++; continue }
    const key = `legacy:${bookingKeys.get(p.bookingId) || p.bookingId}:${p.id}`
    const ex = await db.query('SELECT 1 FROM payments WHERE idempotency_key=$1', [key])
    if (ex.rowCount) { report.payments.alreadyPresent++; continue }
    const method = ['Cash', 'UPI', 'Bank Transfer', 'Card', 'Cheque'].includes(p.method) ? p.method : 'Other'
    const stage = /advance/i.test(p.type || '') ? 'advance' : /final/i.test(p.type || '') ? 'final' : 'part'
    const r = await db.query(
      `INSERT INTO payments (booking_id, amount, method, stage, paid_on, notes, status, source, idempotency_key, verified_at) VALUES ($1,$2,$3,$4,$5,$6,'verified','manual',$7,now()) RETURNING id`,
      [bid, fromPaise(amt), method, stage, p.date, `Imported from previous system${p.type ? `: ${p.type}` : ''}`, key],
    )
    await db.query('INSERT INTO payment_allocations (payment_id, bucket, amount) VALUES ($1,$2,$3)', [r.rows[0].id, p.kind === 'catering' || /catering/i.test(p.type || '') ? 'catering' : 'hall', fromPaise(amt)])
    report.payments.imported++
  }

  // ---- old audit trail ----
  for (const a of data.audit || []) {
    if (!a?.time || Number.isNaN(Date.parse(a.time))) continue
    await db.query(`INSERT INTO audit_events (at, user_name, action, entity_type, entity_id, summary) VALUES ($1,'Legacy import',$2,'legacy',$3,$4)`, [a.time, `Legacy: ${String(a.action || '').slice(0, 80)}`, String(a.bookingId || ''), String(a.details || '').slice(0, 300)])
  }

  report.warnings.push('Customers who previously used the old app have NOT consented to SMS/WhatsApp messages. Record consent on each customer before expecting notifications.')
  report.warnings.push('No invoices were generated for old bookings. Open a fully paid booking and use "Issue invoice" if you need one.')
  await audit(db, ctx, { action: dryRun ? 'Legacy Import (dry run)' : 'Legacy Import', entityType: 'system', summary: `${report.bookings.imported} bookings, ${report.payments.imported} payments`, details: { ...report, warnings: undefined } })
  if (dryRun) {
    const e = new Error('dry-run')
    e.dryRunReport = report
    throw e
  }
  return report
}
