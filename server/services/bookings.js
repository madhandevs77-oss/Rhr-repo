import { can } from '../lib/auth.js'
import { methodEnum, splitsIn } from '../lib/splits.js'
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js'
import { fromPaise, inr, toPaise } from '../lib/money.js'
import { isoDate, hhmm, money, parse, phone10, uuid, z } from '../lib/validate.js'
import { registerDoc } from './docs.js'
import { businessBlock, fingerprint, listInvoices, reconcileInvoice } from './invoices.js'
import { bookingVars, enqueue, enqueueBill, eventView } from './notifications.js'
import { loadPayments, paymentView, recordPayment } from './payments.js'
import { bookingTotals, settlement } from './pricing.js'
import { audit, getSetting, nextRef, serializeCustomer, todayIST, upsertCustomer } from './support.js'

// ---------------- input schemas ----------------
const optPhone = z.preprocess((v) => (v === '' || v === null ? undefined : v), phone10.optional())
const customerIn = z.object({
  name: z.string().trim().min(1, 'Customer name is required').max(120),
  phone: phone10,
  altPhone: optPhone,
  email: z.preprocess((v) => (v === '' ? undefined : v), z.string().email().max(120).optional()),
  address: z.string().trim().max(500).default(''),
  notes: z.string().trim().max(1000).default(''),
  language: z.enum(['en', 'ta']).default('en'),
  messageConsent: z.boolean().optional(),
})
const chargeIn = z.object({ description: z.string().trim().min(1).max(120), quantity: z.coerce.number().positive().max(1000000).default(1), unitPrice: money })
const optIn = (schema) => z.preprocess((v) => (v === '' || v === null ? undefined : v), schema.optional())
const MEALS = ['breakfast', 'lunch', 'dinner']
const advanceIn = z.object({
  amount: money, method: methodEnum.default('Cash'), splits: splitsIn, stage: z.enum(['advance', 'part', 'final']).optional(), paidOn: isoDate.optional(),
  reference: z.string().trim().max(100).default(''), notes: z.string().trim().max(300).default(''), idempotencyKey: z.string().max(100).optional(), verify: z.boolean().optional(),
})
const base = z.object({
  customer: customerIn,
  hallId: uuid,
  eventType: z.string().trim().max(60).default(''),
  // Optional here; resolveSchedule() makes them mandatory for every section except Outsource
  date: optIn(isoDate),
  startTime: optIn(hhmm),
  endTime: optIn(hhmm),
  hallCharge: money.optional(),
  meals: z.array(z.enum(MEALS)).max(3).default([]),
  foodAmount: money.default(0),
  extraAmount: money.default(0),
  discount: money.default(0),
  taxRate: z.coerce.number().min(0).max(100).optional(),
  charges: z.array(chargeIn).max(30).default([]),
  catering: z.object({ plates: z.coerce.number().int().min(1).max(1000000), pricePerPlate: money, notes: z.string().trim().max(500).default('') }).nullable().default(null),
  foodItems: z.array(z.object({ id: z.string().max(60).nullable().optional(), name: z.string().trim().min(1).max(120), category: z.string().trim().max(80).optional() })).max(300).default([]),
  foodStatus: z.enum(['pending', 'confirmed']).default('pending'),
  notes: z.string().trim().max(2000).default(''),
  fulfilment: z.enum(['delivery', 'takeaway']).nullable().optional(), // Outsource sections only
  deliveryAddress: z.string().trim().max(500).default(''),
})
export const createSchema = base.extend({ advance: advanceIn.optional() })
export const updateSchema = base.extend({
  expectedVersion: z.coerce.number().int().min(1),
  confirm: z.object({ financial: z.boolean().optional(), schedule: z.boolean().optional(), invoice: z.boolean().optional() }).default({}),
  reason: z.string().trim().max(500).optional(),
})

// ---------------- loading ----------------
const SELECT = `SELECT b.*, h.name AS hall_name, h.active AS hall_active, h.kind AS hall_kind, h.default_charge AS hall_default_charge, h.section_order AS hall_order,
  c.name AS c_name, c.phone AS c_phone, c.alt_phone AS c_alt, c.email AS c_email, c.address AS c_address, c.notes AS c_notes, c.language AS c_lang,
  c.message_consent AS c_consent, c.billing_name AS c_bn, c.billing_address AS c_ba, c.billing_tax_id AS c_bt
  FROM bookings b JOIN halls h ON h.id=b.hall_id JOIN customers c ON c.id=b.customer_id`

export async function loadBookingState(db, id, { lock = false } = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  if (lock) await db.query('SELECT id FROM bookings WHERE id=$1 FOR UPDATE', [id])
  const row = (await db.query(`${SELECT} WHERE b.id=$1`, [id])).rows[0]
  if (!row) return null
  const charges = (await db.query('SELECT * FROM booking_charges WHERE booking_id=$1 ORDER BY position, id', [id])).rows
  const payments = await loadPayments(db, 'booking', id)
  const totals = bookingTotals(row, charges, row.hall_name)
  const settle = settlement(totals, payments)
  return { kind: 'booking', id, row, charges, payments, totals, settle, cancelled: row.status === 'cancelled' }
}

export function moneyView(st) {
  const t = st.totals, s = st.settle
  return {
    subtotal: fromPaise(t.subtotal), discount: fromPaise(t.discount), taxRate: t.taxRate, tax: fromPaise(t.tax), total: fromPaise(t.total), taxable: fromPaise(t.taxable),
    maintenance: fromPaise(t.hallP), extraAmount: fromPaise(t.extraAmtP), additional: fromPaise(t.extraP - t.extraAmtP), food: fromPaise(t.foodP),
    basis: st.row.status === 'tentative' ? 'estimate' : st.row.status === 'cancelled' ? 'cancelled' : 'confirmed',
    paid: fromPaise(s.paidTotal), pending: fromPaise(s.pending), balance: fromPaise(s.balance), state: s.state,
    buckets: { hall: { due: fromPaise(t.buckets.hall), paid: fromPaise(s.paid.hall) }, catering: { due: fromPaise(t.buckets.catering), paid: fromPaise(s.paid.catering) } },
    lines: t.lines.map((l) => ({ description: l.description, quantity: l.quantity, unit: l.unit, unitPrice: fromPaise(l.unitPaise), amount: fromPaise(l.amountPaise) })),
  }
}

export function bookingView(st, extra = {}) {
  const b = st.row
  const m = moneyView(st)
  const customer = serializeCustomer({ id: b.customer_id, name: b.c_name, phone: b.c_phone, alt_phone: b.c_alt, email: b.c_email, address: b.c_address, notes: b.c_notes, language: b.c_lang, message_consent: b.c_consent, billing_name: b.c_bn, billing_address: b.c_ba, billing_tax_id: b.c_bt })
  return {
    id: b.id, reference: b.reference, status: b.status, version: b.version, createdAt: b.created_at,
    customer, hallId: b.hall_id, hallName: b.hall_name, hallKind: b.hall_kind || null, fulfilment: b.fulfilment || null, deliveryAddress: b.delivery_address || '', defaultCharge: Number(b.hall_default_charge || 0), meals: b.meals || [], foodAmount: Number(b.food_amount || 0), extraAmount: Number(b.extra_amount || 0), eventType: b.event_type, date: b.event_date, startTime: t5(b.start_time), endTime: t5(b.end_time), endsNextDay: !!b.ends_next_day,
    hallCharge: Number(b.hall_charge), discount: Number(b.discount), taxRate: Number(b.tax_rate),
    charges: st.charges.map((c) => ({ id: c.id, description: c.description, quantity: Number(c.quantity), unitPrice: Number(c.unit_price) })),
    catering: b.catering_plates ? { plates: b.catering_plates, pricePerPlate: Number(b.catering_price_per_plate || 0), notes: b.catering_notes } : null,
    foodItems: b.food_items, foodStatus: b.food_status, notes: b.notes, cancelReason: b.cancel_reason, cancelledAt: b.cancelled_at,
    money: m, ...extra,
  }
}

/** Fields whose change makes an issued invoice stale. */
function invoiceCore(st) {
  const b = st.row
  return {
    customer: [b.c_name, b.c_phone, b.c_bn, b.c_ba, b.c_bt], hall: b.hall_name, meals: b.meals, date: b.event_date, start: b.start_time, end: b.end_time, next: !!b.ends_next_day, type: b.event_type,
    lines: st.totals.lines.map((l) => [l.description, l.quantity, l.unitPaise]), discount: st.totals.discount, taxRate: st.totals.taxRate, total: st.totals.total,
  }
}

export async function buildSnapshot(db, st, { version, number }) {
  const b = st.row
  const biz = await getSetting(db, 'business')
  const fin = await getSetting(db, 'finance')
  const verified = st.payments.filter((p) => p.status === 'verified')
  return {
    kind: 'invoice', number, version, issueDate: new Date().toISOString(), reference: b.reference, currency: fin.currency || 'INR',
    seller: { ...businessBlock(biz), bankDetails: biz.bankDetails || '', terms: biz.terms || '', footer: biz.invoiceFooter || '' },
    customer: { name: b.c_name, phone: b.c_phone, email: b.c_email || '', address: b.c_address || '', billingName: b.c_bn || '', billingAddress: b.c_ba || '', billingTaxId: b.c_bt || '' },
    booking: { reference: b.reference, hall: b.hall_name, eventType: b.event_type, date: b.event_date, startTime: t5(b.start_time), endTime: t5(b.end_time), endsNextDay: !!b.ends_next_day },
    event: {
      lines: [(b.event_type === b.hall_name ? b.hall_name : `${b.event_type} · ${b.hall_name}`), ...whenLines(b)],
    },
    lines: st.totals.lines.map((l) => ({ description: l.description, quantity: l.quantity, unit: l.unit, unit_price: fromPaise(l.unitPaise), amount: fromPaise(l.amountPaise) })),
    totals: { subtotal: fromPaise(st.totals.subtotal), discount: fromPaise(st.totals.discount), taxRate: st.totals.taxRate, taxLabel: fin.taxLabel || 'GST', tax: fromPaise(st.totals.tax), total: fromPaise(st.totals.total) },
    payments: verified.map((p) => ({ id: p.id, date: p.paid_on, method: p.method, reference: p.reference, stage: p.stage, kind: p.kind, amount: Number(p.amount), splits: (p.splits || []).map((x) => ({ method: x.method, amount: Number(x.amount) })) })),
    paidTotal: fromPaise(st.settle.paidTotal), balance: fromPaise(st.settle.balance), status: st.settle.balance === 0 ? 'Fully Paid' : 'Balance Due',
  }
}

// ---------------- menu snapshots ----------------
/** Resolve selected menu items to frozen snapshots {id,name,category,categorySort,sort}. Items already on the booking keep their old
 *  snapshot, so renaming / deleting a menu item or category later never rewrites a saved booking. Menu items carry no price. */
async function snapshotFoodItems(db, incoming, existing) {
  const have = new Map((existing || []).filter((x) => x.id).map((x) => [x.id, x]))
  const need = incoming.filter((x) => x.id && !have.has(x.id)).map((x) => x.id).filter((id) => /^[0-9a-f-]{36}$/i.test(id))
  const rows = need.length ? (await db.query(
    `SELECT i.id, i.name, i.sort, c.id AS cid, c.name AS category, c.sort AS csort FROM meal_menu_items i JOIN menu_categories c ON c.id=i.category_id WHERE i.id = ANY($1::uuid[])`, [need])).rows : []
  const byId = new Map(rows.map((r) => [r.id, r]))
  const seen = new Set()
  const out = []
  for (const x of incoming) {
    const r = x.id && byId.get(x.id)
    const snap = (x.id && have.get(x.id)) || (r && { id: r.id, name: r.name, categoryId: r.cid, category: r.category, categorySort: r.csort, sort: r.sort }) || { id: x.id || null, name: x.name, category: x.category || 'Other', categorySort: 999, sort: 999 }
    const key = snap.id || `${snap.category}|${snap.name.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ id: snap.id || null, name: snap.name, ...(snap.categoryId ? { categoryId: snap.categoryId } : {}), category: snap.category || 'Other', categorySort: snap.categorySort ?? 999, sort: snap.sort ?? 999 })
  }
  return out
}

// ---------------- schedule ----------------
const t5 = (t) => (t ? String(t).slice(0, 5) : null)
const toMin = (t) => parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3, 5), 10)
const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const STANDARD_SLOT_MIN = 180

/**
 * Decide the date / start / end that are stored.
 *  Outsource sections: date and time are optional. A start time without an end gets end = start + 3 hours; when that passes midnight the end falls on
 *  the next day (next = true), e.g. 22:30 -> 01:30 next day. An end earlier than the start is read the same way.
 *  Every other section: date, start and end are required, and the end must be after the start on the same day (unchanged behaviour).
 */
export function resolveSchedule(hall, b) {
  const date = b.date || null, start = b.startTime || null, end = b.endTime || null
  if (hall.kind === 'outsource') {
    if (!start) {
      if (end) throw badRequest('Enter a start time, or leave the time empty')
      return { date, start: null, end: null, next: false }
    }
    if (!end) { const m = toMin(start) + STANDARD_SLOT_MIN; return { date, start, end: fromMin(m % 1440), next: m >= 1440 } }
    if (end === start) throw badRequest('End time must be different from the start time')
    return { date, start, end, next: end < start }
  }
  if (!date) throw badRequest('Function date is required')
  if (!start || !end) throw badRequest('Start time and end time are required')
  if (end <= start) throw badRequest('End time must be after start time')
  return { date, start, end, next: false }
}
const longDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
/** "Date:" / "Time:" lines for documents; a missing date or time is simply left out. */
const whenLines = (b) => [
  ...(b.event_date ? [`Date: ${longDate(b.event_date)}`] : []),
  ...(b.start_time ? [`Time: ${t5(b.start_time)} – ${t5(b.end_time)}${b.ends_next_day ? ' (next day)' : ''}`] : []),
]

// ---------------- hall rules ----------------
async function assertHallOk(db, hallId, { date, checkBlackout = true, requireActive = true }) {
  const hall = (await db.query('SELECT * FROM halls WHERE id=$1', [hallId])).rows[0]
  if (!hall) throw badRequest('Selected hall does not exist', undefined, 'HALL_NOT_FOUND')
  if (requireActive && !hall.active) throw conflict(`${hall.name} is not currently available for booking`, 'HALL_INACTIVE')
  if (checkBlackout && date) {
    const b = (await db.query('SELECT * FROM hall_blackouts WHERE hall_id=$1 AND $2::date BETWEEN start_date AND end_date LIMIT 1', [hallId, date])).rows[0]
    if (b) throw conflict(`${hall.name} is unavailable on ${date}${b.reason ? ` (${b.reason})` : ''}`, 'HALL_UNAVAILABLE')
  }
  return hall
}

async function findConflict(db, { hallId, date, start, end, next = false, ignoreId }) {
  if (!date || !start || !end) return null // no date/time: nothing to overlap with
  const r = await db.query(
    `SELECT b.id, b.reference, b.start_time, b.end_time, c.name FROM bookings b JOIN customers c ON c.id=b.customer_id
     WHERE b.hall_id=$1 AND b.status <> 'cancelled' AND b.id IS DISTINCT FROM $5::uuid
       AND b.starts_at IS NOT NULL AND b.ends_at IS NOT NULL
       AND tsrange(b.starts_at, b.ends_at, '[)') && tsrange($2::date + $3::time, $2::date + $4::time + $6::int * interval '1 day', '[)') LIMIT 1`,
    [hallId, date, start, end, ignoreId || null, next ? 1 : 0],
  )
  return r.rows[0] || null
}
function conflictError(c, hallName) {
  return conflict(`${hallName} is already booked ${c.start_time.slice(0, 5)}–${c.end_time.slice(0, 5)} for ${c.name} (${c.reference})`, 'HALL_CONFLICT', { conflict: { id: c.id, reference: c.reference, customerName: c.name, startTime: c.start_time.slice(0, 5), endTime: c.end_time.slice(0, 5) } })
}
/** Map the DB exclusion-constraint violation (the real concurrency guard) to a friendly 409. */
async function mapConstraint(db, e, ctxData) {
  if (e.code === '23P01') {
    const c = await findConflict(db, ctxData).catch(() => null)
    if (c) throw conflictError(c, ctxData.hallName || 'The hall')
    throw conflict('That hall and time was just taken by another booking', 'HALL_CONFLICT')
  }
  throw e
}

// ---------------- create ----------------
export async function createBooking(db, ctx, raw) {
  const b = parse(createSchema, raw)
  const hall = await assertHallOk(db, b.hallId, { date: b.date || null })
  const sch = resolveSchedule(hall, b)
  if (sch.date && sch.date < todayIST()) throw badRequest('Function date cannot be in the past', undefined, 'PAST_DATE')
  // Every hall: default maintenance charge unless an authorised user agrees another amount; extras / discount need authority; no GST is added.
  const hallCharge = b.hallCharge ?? Number(hall.default_charge)
  const fin2 = can(ctx.user, 'bookings.editFinancial')
  if (toPaise(hallCharge) !== toPaise(hall.default_charge) && !fin2) throw forbidden('Only a manager or admin can change the maintenance charge')
  if (toPaise(b.discount) > 0 && !fin2) throw forbidden('Only a manager or admin can give a discount')
  const taxRate = fin2 && b.taxRate ? b.taxRate : 0
  toPaise(hallCharge); toPaise(b.discount); toPaise(b.foodAmount); toPaise(b.extraAmount) // validate
  const ful = fulfilmentOf(hall, b)
  const foodItems = await snapshotFoodItems(db, b.foodItems, [])
  const customer = await upsertCustomer(db, { ...b.customer, consentSource: 'booking_form' })

  const pre = await findConflict(db, { hallId: b.hallId, date: sch.date, start: sch.start, end: sch.end, next: sch.next })
  if (pre) throw conflictError(pre, hall.name)

  const year = todayIST().slice(0, 4)
  const reference = await nextRef(db, 'booking', year, 'BH', 1000)
  let id
  try {
    const r = await db.query(
      `INSERT INTO bookings (reference, customer_id, hall_id, event_type, event_date, start_time, end_time, hall_charge, discount, tax_rate,
         catering_plates, catering_price_per_plate, catering_notes, food_items, food_status, notes, status, created_by, meals, food_amount, extra_amount, fulfilment, delivery_address, ends_next_day)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'tentative',$17,$18,$19,$20,$21,$22,$23) RETURNING id`,
      [reference, customer.id, b.hallId, b.eventType || hall.name, sch.date, sch.start, sch.end, hallCharge, b.discount, taxRate,
       b.catering?.plates ?? null, b.catering?.pricePerPlate ?? null, b.catering?.notes ?? '', JSON.stringify(foodItems), b.foodStatus, b.notes, ctx.user?.id || null, b.meals, b.foodAmount, b.extraAmount, ful.fulfilment, ful.address, sch.next],
    )
    id = r.rows[0].id
  } catch (e) {
    await mapConstraint(db, e, { hallId: b.hallId, date: sch.date, start: sch.start, end: sch.end, next: sch.next, hallName: hall.name })
  }
  for (const [i, c] of b.charges.entries()) await db.query('INSERT INTO booking_charges (booking_id, description, quantity, unit_price, position) VALUES ($1,$2,$3,$4,$5)', [id, c.description, c.quantity, c.unitPrice, i])
  // validate totals now (discount <= subtotal etc.) — throws before commit
  let st = await loadBookingState(db, id, { lock: true })
  await audit(db, ctx, { action: 'Booking Created', entityType: 'booking', entityId: id, summary: `${reference} for ${customer.name}` })
  if (b.advance) {
    await recordPayment(db, ctx, 'booking', id, { ...b.advance, paidOn: b.advance.paidOn || todayIST(), stage: 'advance' })
    st = await loadBookingState(db, id)
  }
  return st
}

// ---------------- update ----------------
/** Outsource sections are delivery or takeaway (default takeaway); delivery needs an address. Other halls carry neither. */
function fulfilmentOf(hall, b) {
  if (hall.kind !== 'outsource') return { fulfilment: null, address: '' }
  const fulfilment = b.fulfilment || 'takeaway'
  if (fulfilment === 'delivery' && !b.deliveryAddress) throw badRequest('Enter the delivery address', undefined, 'DELIVERY_ADDRESS_REQUIRED')
  return { fulfilment, address: fulfilment === 'delivery' ? b.deliveryAddress : '' }
}
const label = { eventType: 'Event type', date: 'Date', startTime: 'Start time', endTime: 'End time', hallName: 'Hall', hallCharge: 'Hall charge', discount: 'Discount', taxRate: 'Tax rate', cateringPlates: 'Catering plates', cateringPrice: 'Price per plate', foodAmount: 'Food service amount', extraAmount: 'Extra amount', fulfilment: 'Delivery / takeaway', deliveryAddress: 'Delivery address', meals: 'Meals', customerName: 'Customer name', customerPhone: 'Customer phone', notes: 'Notes', foodStatus: 'Food status', foodItems: 'Food items', charges: 'Additional charges' }
function snapshotForDiff(st) {
  const b = st.row
  return {
    eventType: b.event_type, date: b.event_date, startTime: t5(b.start_time), endTime: t5(b.end_time), endsNextDay: !!b.ends_next_day, hallName: b.hall_name,
    hallCharge: Number(b.hall_charge), discount: Number(b.discount), taxRate: Number(b.tax_rate), cateringPlates: b.catering_plates || 0, cateringPrice: Number(b.catering_price_per_plate || 0),
    foodAmount: Number(b.food_amount || 0), extraAmount: Number(b.extra_amount || 0), meals: (b.meals || []).join(', '), customerName: b.c_name, customerPhone: b.c_phone, notes: b.notes, foodStatus: b.food_status, fulfilment: b.fulfilment || '', deliveryAddress: b.delivery_address || '',
    foodItems: (b.food_items || []).map((f) => f.name).sort().join(', '), charges: st.charges.map((c) => `${c.description} ${Number(c.quantity)}×${Number(c.unit_price)}`).join('; '),
  }
}

export async function updateBooking(db, ctx, id, raw) {
  const b = parse(updateSchema, raw)
  if (b.endTime <= b.startTime) throw badRequest('End time must be after start time')
  const before = await loadBookingState(db, id, { lock: true })
  if (!before) throw notFound('Booking')
  const cur = before.row
  if (cur.status === 'cancelled') throw conflict('A cancelled booking cannot be edited. Restore it first.', 'CANCELLED')
  if (cur.version !== b.expectedVersion) throw conflict('This booking was changed by someone else. Reload it and try again.', 'STALE_VERSION', { currentVersion: cur.version })

  // GST is never added automatically; a booking keeps the tax it was saved with unless a manager/admin explicitly changes it
  const newTax = b.taxRate !== undefined && can(ctx.user, 'bookings.editFinancial') ? b.taxRate : Number(cur.tax_rate)
  const financialTouched =
    toPaise(b.hallCharge ?? cur.hall_charge) !== toPaise(cur.hall_charge) || (toPaise(b.foodAmount) !== toPaise(cur.food_amount) && toPaise(cur.food_amount) > 0) || toPaise(b.discount) !== toPaise(cur.discount) || Number(newTax) !== Number(cur.tax_rate) ||
    (b.catering?.plates || 0) !== (cur.catering_plates || 0) || toPaise(b.catering?.pricePerPlate || 0) !== toPaise(cur.catering_price_per_plate || 0) ||
    false
  if (financialTouched && !can(ctx.user, 'bookings.editFinancial')) throw forbidden('Only a manager or admin can change the maintenance charge, discount or tax')

  const hallRow = (await db.query('SELECT kind FROM halls WHERE id=$1', [b.hallId])).rows[0]
  if (!hallRow) throw badRequest('Selected hall does not exist', undefined, 'HALL_NOT_FOUND')
  const sch = resolveSchedule(hallRow, b)
  const scheduleChanged = b.hallId !== cur.hall_id || sch.date !== cur.event_date || sch.start !== t5(cur.start_time) || sch.end !== t5(cur.end_time) || sch.next !== !!cur.ends_next_day
  const hall = await assertHallOk(db, b.hallId, { date: sch.date, checkBlackout: scheduleChanged, requireActive: b.hallId !== cur.hall_id })
  if (sch.date && sch.date !== cur.event_date && sch.date < todayIST()) throw badRequest('Function date cannot be moved into the past', undefined, 'PAST_DATE')
  if (scheduleChanged) {
    const pre = await findConflict(db, { hallId: b.hallId, date: sch.date, start: sch.start, end: sch.end, next: sch.next, ignoreId: id })
    if (pre) throw conflictError(pre, hall.name)
  }

  // ---- impact analysis (what the customer's money / invoice / schedule will look like) ----
  const prospective = {
    ...cur, hall_charge: b.hallCharge ?? cur.hall_charge, food_amount: b.foodAmount, extra_amount: b.extraAmount, hall_kind: hall.kind, discount: b.discount, tax_rate: newTax, catering_plates: b.catering?.plates ?? null, catering_price_per_plate: b.catering?.pricePerPlate ?? null,
  }
  const newCharges = b.charges.map((c) => ({ description: c.description, quantity: c.quantity, unit_price: c.unitPrice }))
  const newTotals = bookingTotals(prospective, newCharges, hall.name)
  const newSettle = settlement(newTotals, before.payments)
  const hasInvoice = (await db.query(`SELECT 1 FROM invoices WHERE booking_id=$1 AND status='issued'`, [id])).rowCount > 0
  const impact = {
    previousTotal: fromPaise(before.totals.total), newTotal: fromPaise(newTotals.total), difference: fromPaise(newTotals.total - before.totals.total),
    paid: fromPaise(before.settle.paidTotal), newBalance: fromPaise(newSettle.balance), hasInvoice, scheduleChanged,
    totalChanged: newTotals.total !== before.totals.total, refundDue: newSettle.balance < 0 ? fromPaise(-newSettle.balance) : 0,
  }
  const needsFinancial = impact.totalChanged && (before.settle.paidTotal > 0 || hasInvoice || cur.status === 'confirmed')
  const needsSchedule = scheduleChanged && (cur.status === 'confirmed' || before.settle.paidTotal > 0)
  const missing = []
  if (needsFinancial && !b.confirm.financial) missing.push('financial')
  if (needsSchedule && !b.confirm.schedule) missing.push('schedule')
  if (missing.length || (hasInvoice && (!b.confirm.invoice || !b.reason))) {
    // An issued invoice exists: any invoice-relevant change must be explicitly confirmed with a reason. We only know for
    // certain after applying, so unconfirmed edits to an invoiced booking are applied, checked, then rolled back below.
    if (missing.length) throw conflict('Please confirm these changes before saving', 'CONFIRMATION_REQUIRED', { required: missing, impact, reasonRequired: hasInvoice })
  }

  // ---- apply ----
  const ful = fulfilmentOf(hall, b)
  const foodItems = await snapshotFoodItems(db, b.foodItems, cur.food_items)
  const customer = await upsertCustomer(db, { ...b.customer, consentSource: 'booking_edit' })
  try {
    await db.query(
      `UPDATE bookings SET customer_id=$2, hall_id=$3, event_type=$4, event_date=$5, start_time=$6, end_time=$7, hall_charge=$8, discount=$9, tax_rate=$10,
         catering_plates=$11, catering_price_per_plate=$12, catering_notes=$13, food_items=$14, food_status=$15, notes=$16, meals=$18, food_amount=$19, extra_amount=$20, fulfilment=$21, delivery_address=$22, ends_next_day=$23, version=version+1, updated_at=now()
       WHERE id=$1 AND version=$17`,
      [id, customer.id, b.hallId, b.eventType || hall.name, sch.date, sch.start, sch.end, b.hallCharge ?? cur.hall_charge, b.discount, newTax, b.catering?.plates ?? null, b.catering?.pricePerPlate ?? null,
       b.catering?.notes ?? '', JSON.stringify(foodItems), b.foodStatus, b.notes, b.expectedVersion, b.meals, b.foodAmount, b.extraAmount, ful.fulfilment, ful.address, sch.next],
    )
  } catch (e) {
    await mapConstraint(db, e, { hallId: b.hallId, date: sch.date, start: sch.start, end: sch.end, next: sch.next, ignoreId: id, hallName: hall.name })
  }
  await db.query('DELETE FROM booking_charges WHERE booking_id=$1', [id])
  for (const [i, c] of b.charges.entries()) await db.query('INSERT INTO booking_charges (booking_id, description, quantity, unit_price, position) VALUES ($1,$2,$3,$4,$5)', [id, c.description, c.quantity, c.unitPrice, i])
  const after = await loadBookingState(db, id)
  const invoiceStale = hasInvoice && fingerprint(invoiceCore(before)) !== fingerprint(invoiceCore(after))
  if (invoiceStale && (!b.confirm.invoice || !b.reason)) {
    // thrown inside the caller's transaction => the edit above is rolled back, nothing is half-applied
    throw conflict('This booking already has an issued invoice. The invoice will be superseded; confirm and give a reason.', 'CONFIRMATION_REQUIRED', { required: ['invoice'], impact, reasonRequired: true })
  }

  const d0 = snapshotForDiff(before), d1 = snapshotForDiff(after)
  const changes = Object.keys(d1).filter((k) => String(d0[k]) !== String(d1[k])).map((k) => ({ field: label[k] || k, from: d0[k], to: d1[k] }))
  if (changes.length || b.reason) {
    await db.query(
      `INSERT INTO booking_changes (booking_id, from_version, to_version, changed_by, changed_by_name, summary, changes, total_before, total_after, reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, cur.version, cur.version + 1, ctx.user?.id || null, ctx.user?.name || null, changes.map((c) => c.field).join(', ') || 'Edited', JSON.stringify(changes), fromPaise(before.totals.total), fromPaise(after.totals.total), b.reason || null],
    )
    await audit(db, ctx, { action: 'Booking Edited', entityType: 'booking', entityId: id, summary: `${cur.reference}: ${changes.map((c) => c.field).join(', ') || 'no field changes'}`, details: { changes, impact, reason: b.reason || null } })
  }

  // ---- invoice reconciliation (supersede, never overwrite) + customer notification ----
  await settleBooking(db, ctx, id, { event: 'edited', reason: invoiceStale ? `Booking amended: ${b.reason}` : undefined })
  const fresh = await loadBookingState(db, id)
  const notif = await getSetting(db, 'notifications')
  if (scheduleChanged && fresh.row.status === 'confirmed' && notif.notifyOnSignificantChange !== false) {
    await enqueue(db, ctx, { key: `booking_changed:${id}:v${fresh.row.version}`, type: 'booking_changed', templateKey: 'booking_changed', bookingId: id,
      customer: { id: customer.id, name: customer.name, phone: customer.phone, language: customer.language, message_consent: customer.message_consent }, vars: bookingVars(fresh.row, customer, fresh, await getSetting(db, 'business')) })
  }
  return { state: fresh, impact }
}

// ---------------- cancel / restore ----------------
export async function cancelBooking(db, ctx, id, { reason, confirm, expectedVersion }) {
  const st = await loadBookingState(db, id, { lock: true })
  if (!st) throw notFound('Booking')
  if (st.row.status === 'cancelled') return st
  if (expectedVersion && st.row.version !== expectedVersion) throw conflict('This booking was changed by someone else. Reload it and try again.', 'STALE_VERSION')
  if ((st.settle.paidTotal > 0 || st.settle.pending > 0) && !confirm) {
    throw conflict(`This booking has ${inr(st.settle.paidTotal)} paid${st.settle.pending ? ` and ${inr(st.settle.pending)} awaiting verification` : ''}. Confirm cancellation (any refund is handled separately).`, 'CONFIRMATION_REQUIRED', { required: ['cancel'], paid: fromPaise(st.settle.paidTotal) })
  }
  await db.query(`UPDATE bookings SET status='cancelled', cancelled_at=now(), cancel_reason=$2, version=version+1, updated_at=now() WHERE id=$1`, [id, reason || null])
  // a cancelled booking's invoice is voided (kept on record, no longer valid)
  const live = (await db.query(`SELECT id, invoice_number FROM invoices WHERE booking_id=$1 AND status='issued' FOR UPDATE`, [id])).rows[0]
  if (live) {
    await db.query(`UPDATE invoices SET status='void', status_reason='Booking cancelled', status_changed_at=now(), status_changed_by=$2 WHERE id=$1`, [live.id, ctx.user?.id || null])
    await audit(db, ctx, { action: 'Invoice Voided', entityType: 'invoice', entityId: live.id, summary: `${live.invoice_number}: booking cancelled` })
  }
  await audit(db, ctx, { action: 'Booking Cancelled', entityType: 'booking', entityId: id, summary: `${st.row.reference}${reason ? `: ${reason}` : ''}`, details: { paid: fromPaise(st.settle.paidTotal) } })
  return loadBookingState(db, id)
}

export async function restoreBooking(db, ctx, id) {
  const st = await loadBookingState(db, id, { lock: true })
  if (!st) throw notFound('Booking')
  if (st.row.status !== 'cancelled') throw conflict('Only cancelled bookings can be restored', 'BAD_STATE')
  const hall = await assertHallOk(db, st.row.hall_id, { date: st.row.event_date })
  const pre = await findConflict(db, { hallId: st.row.hall_id, date: st.row.event_date, start: st.row.start_time, end: st.row.end_time, next: !!st.row.ends_next_day, ignoreId: id })
  if (pre) throw conflictError(pre, hall.name)
  try {
    await db.query(`UPDATE bookings SET status=$2, cancelled_at=NULL, cancel_reason=NULL, version=version+1, updated_at=now() WHERE id=$1`, [id, st.settle.paidTotal > 0 ? 'confirmed' : 'tentative'])
  } catch (e) {
    await mapConstraint(db, e, { hallId: st.row.hall_id, date: st.row.event_date, start: st.row.start_time, end: st.row.end_time, next: !!st.row.ends_next_day, ignoreId: id, hallName: hall.name })
  }
  await audit(db, ctx, { action: 'Booking Restored', entityType: 'booking', entityId: id, summary: st.row.reference })
  await settleBooking(db, ctx, id, { event: 'restored' })
  return loadBookingState(db, id)
}

// ---------------- settle (called after any money / data change; row lock already held) ----------------
export async function settleBooking(db, ctx, id, { event, reason } = {}) {
  let st = await loadBookingState(db, id)
  if (!st) return null
  const fin = await getSetting(db, 'finance')
  const minPct = Number(fin.advanceMinPercent || 0)
  let confirmedNow = false
  // Verified advance => tentative booking becomes confirmed (never from pending/unverified money).
  if (st.row.status === 'tentative' && st.settle.paidTotal > 0 && st.settle.paidTotal * 100 >= st.totals.total * minPct) {
    await db.query(`UPDATE bookings SET status='confirmed', version=version+1, updated_at=now() WHERE id=$1`, [id])
    await audit(db, ctx, { action: 'Booking Confirmed', entityType: 'booking', entityId: id, summary: `${st.row.reference}: advance ${inr(st.settle.paidTotal)} verified` })
    confirmedNow = true
    st = await loadBookingState(db, id)
  }
  if (confirmedNow) {
    // one confirmation per booking, ever (idempotency key), and only from this verified-advance transition
    const customer = { id: st.row.customer_id, name: st.row.c_name, phone: st.row.c_phone, language: st.row.c_lang, message_consent: st.row.c_consent }
    await enqueue(db, ctx, { key: `booking_confirmation:${id}`, type: 'booking_confirmation', templateKey: 'booking_confirmation', bookingId: id, customer, vars: bookingVars(st.row, customer, st, await getSetting(db, 'business')) })
  }
  if (st.row.status !== 'cancelled') {
    await reconcileInvoice(db, ctx, {
      kind: 'booking', id, totalPaise: st.totals.total, paidPaise: st.settle.paidTotal, state: st.settle.state, fingerprintCore: invoiceCore(st),
      buildSnapshot: (v) => buildSnapshot(db, st, v), onFirstInvoice: (inv) => enqueueBill(db, ctx, inv, { auto: true }),
    }, { trigger: event === 'manual' ? 'manual' : 'payment_verified', reason })
  }
  return st
}

registerDoc('booking', {
  load: (db, id, opts) => loadBookingState(db, id, opts),
  afterMoney: (db, ctx, id, info) => settleBooking(db, ctx, id, info),
})

/** Manual "issue invoice now" — only produces one when the verified balance is zero (idempotent). */
export async function issueInvoiceNow(db, ctx, id) {
  const st = await loadBookingState(db, id, { lock: true })
  if (!st) throw notFound('Booking')
  if (st.settle.state !== 'paid') throw conflict('An invoice can only be issued when the verified balance is zero', 'NOT_FULLY_PAID', { balance: fromPaise(st.settle.balance) })
  await settleBooking(db, ctx, id, { event: 'manual' })
  return listInvoices(db, `WHERE booking_id=$1`, [id])
}

// ---------------- queries ----------------
export async function listBookings(db, f) {
  const where = []
  const p = []
  const add = (sql, v) => { p.push(v); where.push(sql.replace('?', `$${p.length}`)) }
  const dateConds = []
  if (f.from) { p.push(f.from); dateConds.push(`b.event_date >= $${p.length}`) }
  if (f.to) { p.push(f.to); dateConds.push(`b.event_date <= $${p.length}`) }
  // bookings that have no date yet (Outsource) are only listed when the caller asks for them (the Bookings list), never in availability checks
  if (dateConds.length) where.push(f.includeUndated ? `(b.event_date IS NULL OR (${dateConds.join(' AND ')}))` : dateConds.join(' AND '))
  if (f.status) add('b.status = ?', f.status)
  if (f.hallId) add('b.hall_id = ?', f.hallId)
  if (f.customerId) add('b.customer_id = ?', f.customerId)
  if (f.q) {
    const q = String(f.q).trim()
    p.push(`%${q.replace(/[%_\\]/g, '')}%`)
    const i = p.length
    const digits = q.replace(/\D/g, '')
    let clause = `(c.name ILIKE $${i} OR b.reference ILIKE $${i}`
    if (digits) { p.push(`%${digits}%`); clause += ` OR c.phone LIKE $${p.length}` }
    where.push(clause + ')')
  }
  const rows = (await db.query(`${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY b.event_date, b.start_time LIMIT 2000`, p)).rows
  if (!rows.length) return []
  const ids = rows.map((r) => r.id)
  const charges = (await db.query('SELECT * FROM booking_charges WHERE booking_id = ANY($1) ORDER BY position', [ids])).rows
  const pays = (await db.query(
    `SELECT p.*, COALESCE((SELECT json_agg(json_build_object('bucket', a.bucket, 'amount', a.amount)) FROM payment_allocations a WHERE a.payment_id=p.id), '[]') AS allocations FROM payments p WHERE p.booking_id = ANY($1)`, [ids])).rows
  const invs = (await db.query(`SELECT booking_id, invoice_number, status FROM invoices WHERE booking_id = ANY($1) AND status='issued'`, [ids])).rows
  const out = rows.map((row) => {
    const ch = charges.filter((c) => c.booking_id === row.id)
    const pm = pays.filter((x) => x.booking_id === row.id)
    const totals = bookingTotals(row, ch, row.hall_name)
    const st = { row, charges: ch, payments: pm, totals, settle: settlement(totals, pm) }
    return bookingView(st, { invoiceNumber: invs.find((i) => i.booking_id === row.id)?.invoice_number || null })
  })
  if (f.payment === 'pending') return out.filter((b) => b.status !== 'cancelled' && b.money.balance > 0)
  if (f.payment === 'unverified') return out.filter((b) => b.money.pending > 0)
  return out
}

export async function bookingDetail(db, id) {
  const st = await loadBookingState(db, id)
  if (!st) throw notFound('Booking')
  const history = (await db.query('SELECT * FROM booking_changes WHERE booking_id=$1 ORDER BY to_version DESC', [id])).rows.map((h) => ({
    id: h.id, fromVersion: h.from_version, toVersion: h.to_version, by: h.changed_by_name, at: h.changed_at, summary: h.summary, changes: h.changes, totalBefore: Number(h.total_before), totalAfter: Number(h.total_after), reason: h.reason,
  }))
  const invoices = await listInvoices(db, 'WHERE booking_id=$1', [id])
  const notifs = (await db.query('SELECT * FROM notification_events WHERE booking_id=$1 ORDER BY created_at DESC', [id])).rows
  const linked = (await db.query('SELECT id, reference, status FROM catering_orders WHERE booking_id=$1 ORDER BY created_at', [id])).rows
  return { ...bookingView(st), payments: st.payments.map(paymentView), history, invoices, linkedCatering: linked, notifications: notifs.map(eventView) }
}


/** Customer bill: live view of the booking with every verified payment (advance and final) and its method split. Not an invoice (no number). */
export async function billSnapshot(db, id) {
  const st = await loadBookingState(db, id)
  if (!st) throw notFound('Booking')
  const snap = await buildSnapshot(db, st, { version: 1, number: st.row.reference })
  return { ...snap, kind: 'bill', issueDate: new Date().toISOString() }
}

/** Receipt for ONE verified payment: its split by method, and the position (paid so far / balance) right after it. */
export async function receiptSnapshot(db, paymentId) {
  const pr = (await db.query('SELECT booking_id FROM payments WHERE id=$1', [paymentId])).rows[0]
  if (!pr || !pr.booking_id) throw notFound('Payment')
  const st = await loadBookingState(db, pr.booking_id)
  const idx = st.payments.findIndex((p) => p.id === paymentId)
  const pay = st.payments[idx]
  if (pay.status !== 'verified' || pay.kind !== 'payment') throw conflict('A receipt can only be issued for a verified payment', 'NOT_VERIFIED')
  const upTo = st.payments.slice(0, idx + 1).filter((p) => p.status === 'verified')
  const paidSoFar = upTo.reduce((a, p) => a + (p.kind === 'refund' ? -1 : 1) * toPaise(p.amount), 0)
  const biz = await getSetting(db, 'business')
  const b = st.row
  return {
    kind: 'receipt', number: `R-${paymentId.slice(0, 8).toUpperCase()}`, reference: b.reference,
    seller: { ...businessBlock(biz), footer: biz.invoiceFooter || '' },
    customer: { name: b.c_name, phone: b.c_phone },
    event: [(b.event_type === b.hall_name ? b.hall_name : `${b.event_type} · ${b.hall_name}`), ...whenLines(b)],
    payment: { date: pay.paid_on, stage: pay.stage, amount: Number(pay.amount), reference: pay.reference || '', splits: (pay.splits || []).map((x) => ({ method: x.method, amount: Number(x.amount) })), method: pay.method },
    bookingTotal: fromPaise(st.totals.total), paidSoFar: fromPaise(paidSoFar), balance: fromPaise(st.totals.total - paidSoFar),
  }
}
