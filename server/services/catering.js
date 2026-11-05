// Bulk food outsourcing / catering orders. Independent of hall bookings (optional link). Payment status
// and fulfilment status are separate: being fully paid never completes an order.
import { methodEnum } from '../lib/splits.js'
import { can } from '../lib/auth.js'
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js'
import { fromPaise, inr, toPaise } from '../lib/money.js'
import { hhmm, isoDate, money, parse, phone10, uuid, z } from '../lib/validate.js'
import { registerDoc } from './docs.js'
import { businessBlock, listInvoices, reconcileInvoice, fingerprint } from './invoices.js'
import { enqueue, enqueueBill, enqueueThanks, eventView, fmtTime12 } from './notifications.js'
import { loadPayments, paymentView, recordPayment } from './payments.js'
import { cateringTotals, settlement } from './pricing.js'
import { audit, financialYear, getSetting, nextRef, serializeCustomer, todayIST, upsertCustomer } from './support.js'

export const STATUSES = ['draft', 'quotation_sent', 'awaiting_confirmation', 'confirmed', 'preparation', 'ready_for_dispatch', 'delivered', 'completed', 'cancelled', 'exception']
const NEXT = {
  draft: ['awaiting_confirmation', 'confirmed', 'cancelled'],
  quotation_sent: ['draft', 'awaiting_confirmation', 'confirmed', 'cancelled'],
  awaiting_confirmation: ['quotation_sent', 'confirmed', 'cancelled'],
  confirmed: ['preparation', 'exception', 'cancelled'],
  preparation: ['ready_for_dispatch', 'exception', 'cancelled'],
  ready_for_dispatch: ['delivered', 'exception', 'cancelled'],
  delivered: ['completed', 'exception'],
  completed: [],
  cancelled: [],
  exception: ['confirmed', 'preparation', 'ready_for_dispatch', 'delivered', 'cancelled'],
}
const LOCKED_FOR_EDIT = ['cancelled', 'completed']
const POST_CONFIRM = ['confirmed', 'preparation', 'ready_for_dispatch', 'delivered', 'exception']

// ---------------- schemas ----------------
const optPhone = z.preprocess((v) => (v === '' || v === null ? undefined : v), phone10.optional())
const customerIn = z.object({
  name: z.string().trim().min(1, 'Customer or organisation name is required').max(120), phone: phone10, altPhone: optPhone,
  email: z.preprocess((v) => (v === '' ? undefined : v), z.string().email().max(120).optional()),
  address: z.string().trim().max(500).default(''), language: z.enum(['en', 'ta']).default('en'), messageConsent: z.boolean().optional(),
  billingName: z.string().trim().max(150).optional(), billingAddress: z.string().trim().max(500).optional(), billingTaxId: z.string().trim().max(40).optional(),
})
const itemIn = z.object({
  menuItemId: z.preprocess((v) => (v === '' ? null : v), uuid.nullable().optional()),
  mealItemId: z.preprocess((v) => (v === '' ? null : v), uuid.nullable().optional()),
  name: z.string().trim().min(1).max(150).optional(),
  mealType: z.string().trim().max(40).optional(),
  unit: z.enum(['plate', 'kg', 'litre', 'piece', 'tray', 'packet']).default('plate'),
  quantity: z.coerce.number().positive('Quantity must be greater than zero').max(1000000),
  unitPrice: money.optional(),
  notes: z.string().trim().max(300).default(''),
})
const orderBase = z.object({
  customer: customerIn,
  bookingId: z.preprocess((v) => (v === '' ? null : v), uuid.nullable().default(null)),
  serviceOptionId: uuid,
  eventType: z.string().trim().min(1).max(60),
  date: isoDate,
  deliveryTime: z.preprocess((v) => (v === '' ? undefined : v), hhmm.optional()),
  servingTime: z.preprocess((v) => (v === '' ? undefined : v), hhmm.optional()),
  venueName: z.string().trim().max(200).default(''),
  deliveryAddress: z.string().trim().max(600).default(''),
  plates: z.coerce.number().int().min(1).max(1000000),
  contactPerson: z.string().trim().max(120).default(''),
  contactPhone: z.preprocess((v) => (v === '' || v === null ? undefined : v), phone10.optional()),
  mealCategory: z.string().trim().min(1).max(40).default('lunch'),
  notes: z.string().trim().max(2000).default(''),
  dietaryInstructions: z.string().trim().max(1000).default(''),
  packagingRequirements: z.string().trim().max(1000).default(''),
  servingRequirements: z.string().trim().max(1000).default(''),
  fulfilmentMethod: z.enum(['delivery', 'pickup']).default('delivery'),
  staffRequired: z.boolean().default(false),
  staffCount: z.coerce.number().int().min(0).max(10000).default(0),
  staffCharge: money.default(0),
  utensilsRequired: z.boolean().default(false),
  equipmentNotes: z.string().trim().max(500).default(''),
  equipmentCharge: money.default(0),
  setupRequired: z.boolean().default(false),
  setupCharge: money.default(0),
  deliveryCharge: money.default(0),
  pricingMode: z.enum(['per_plate', 'item_based']).default('per_plate'),
  pricePerPlate: money.default(0),
  discount: money.default(0),
  taxRate: z.coerce.number().min(0).max(100).optional(),
  items: z.array(itemIn).max(200).default([]),
})
export const orderCreateSchema = orderBase.extend({ advance: z.object({ amount: money, method: methodEnum.default('Cash'), paidOn: isoDate.optional(), reference: z.string().max(100).default(''), notes: z.string().max(300).default(''), idempotencyKey: z.string().max(100).optional(), verify: z.boolean().optional() }).optional() })
export const orderUpdateSchema = orderBase.extend({
  expectedVersion: z.coerce.number().int().min(1),
  confirm: z.object({ financial: z.boolean().optional(), invoice: z.boolean().optional() }).default({}),
  reason: z.string().trim().max(500).optional(),
})

// ---------------- loading ----------------
const SELECT = `SELECT o.*, so.code AS so_code, so.name AS so_name, so.requires_vendor AS so_requires_vendor,
  c.name AS c_name, c.phone AS c_phone, c.alt_phone AS c_alt, c.email AS c_email, c.address AS c_address, c.notes AS c_notes, c.language AS c_lang,
  c.message_consent AS c_consent, c.billing_name AS c_bn, c.billing_address AS c_ba, c.billing_tax_id AS c_bt, b.reference AS booking_reference
  FROM catering_orders o JOIN catering_service_options so ON so.id=o.service_option_id JOIN customers c ON c.id=o.customer_id LEFT JOIN bookings b ON b.id=o.booking_id`

const vendorView = (a) => a && ({
  id: a.id, vendorId: a.vendor_id, vendorName: a.vendor_name, status: a.status, quoteAmount: a.quote_amount === null ? null : Number(a.quote_amount),
  agreedCost: a.agreed_cost === null ? null : Number(a.agreed_cost), finalCost: a.final_cost === null ? null : Number(a.final_cost), notes: a.notes,
  quotedAt: a.quoted_at, assignedAt: a.assigned_at, acceptedAt: a.accepted_at, deliveredAt: a.delivered_at,
})
async function loadAssignments(db, id) {
  return (await db.query(`SELECT a.*, v.name AS vendor_name FROM vendor_assignments a JOIN vendors v ON v.id=a.vendor_id WHERE a.order_id=$1 ORDER BY a.created_at`, [id])).rows
}

export async function loadOrderState(db, id, { lock = false } = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  if (lock) await db.query('SELECT id FROM catering_orders WHERE id=$1 FOR UPDATE', [id])
  const row = (await db.query(`${SELECT} WHERE o.id=$1`, [id])).rows[0]
  if (!row) return null
  const items = (await db.query('SELECT * FROM catering_order_items WHERE order_id=$1 ORDER BY position, id', [id])).rows
  const payments = await loadPayments(db, 'catering', id)
  const totals = cateringTotals(row, items)
  const assignments = await loadAssignments(db, id)
  return { kind: 'catering', id, row, items, payments, totals, settle: settlement(totals, payments), assignments, cancelled: row.status === 'cancelled' }
}

export function orderView(st, extra = {}) {
  const o = st.row, t = st.totals, s = st.settle
  const active = st.assignments.find((a) => a.is_active)
  return {
    id: o.id, reference: o.reference, status: o.status, version: o.version, createdAt: o.created_at,
    customer: serializeCustomer({ id: o.customer_id, name: o.c_name, phone: o.c_phone, alt_phone: o.c_alt, email: o.c_email, address: o.c_address, notes: o.c_notes, language: o.c_lang, message_consent: o.c_consent, billing_name: o.c_bn, billing_address: o.c_ba, billing_tax_id: o.c_bt }),
    bookingId: o.booking_id, bookingReference: o.booking_reference || null,
    serviceOption: { id: o.service_option_id, code: o.so_code, name: o.so_name, requiresVendor: o.so_requires_vendor },
    eventType: o.event_type, date: o.event_date, deliveryTime: o.delivery_time?.slice(0, 5) || '', servingTime: o.serving_time?.slice(0, 5) || '',
    venueName: o.venue_name, deliveryAddress: o.delivery_address, plates: o.plates, contactPerson: o.contact_person, contactPhone: o.contact_phone,
    mealCategory: o.meal_category, notes: o.notes, dietaryInstructions: o.dietary_instructions, packagingRequirements: o.packaging_requirements, servingRequirements: o.serving_requirements,
    fulfilmentMethod: o.fulfilment_method, staffRequired: o.staff_required, staffCount: o.staff_count, staffCharge: Number(o.staff_charge), utensilsRequired: o.utensils_required,
    equipmentNotes: o.equipment_notes, equipmentCharge: Number(o.equipment_charge), setupRequired: o.setup_required, setupCharge: Number(o.setup_charge), deliveryCharge: Number(o.delivery_charge),
    pricingMode: o.pricing_mode, pricePerPlate: Number(o.price_per_plate), discount: Number(o.discount), taxRate: Number(o.tax_rate),
    items: st.items.map((i) => ({ id: i.id, menuItemId: i.menu_item_id, mealItemId: i.meal_item_id, name: i.name, mealType: i.meal_type, unit: i.unit, quantity: Number(i.quantity), unitPrice: Number(i.unit_price), notes: i.notes })),
    exceptionReason: o.exception_reason, cancelReason: o.cancel_reason,
    money: {
      subtotal: fromPaise(t.subtotal), discount: fromPaise(t.discount), taxRate: t.taxRate, tax: fromPaise(t.tax), total: fromPaise(t.total), paid: fromPaise(s.paidTotal), pending: fromPaise(s.pending),
      balance: fromPaise(s.balance), state: s.state,
      lines: t.lines.map((l) => ({ description: l.description, quantity: l.quantity, unit: l.unit, unitPrice: fromPaise(l.unitPaise), amount: fromPaise(l.amountPaise) })),
    },
    vendor: vendorView(active) || null,
    ...extra,
  }
}

const orderInvoiceCore = (st) => ({
  customer: [st.row.c_name, st.row.c_phone, st.row.c_bn, st.row.c_ba, st.row.c_bt], date: st.row.event_date, delivery: st.row.delivery_time, venue: st.row.venue_name, type: st.row.event_type, plates: st.row.plates,
  lines: st.totals.lines.map((l) => [l.description, l.quantity, l.unitPaise]), discount: st.totals.discount, taxRate: st.totals.taxRate, total: st.totals.total,
})

async function buildDocSnapshot(db, st, { version, number }, kind = 'invoice') {
  const o = st.row
  const biz = await getSetting(db, 'business')
  const fin = await getSetting(db, 'finance')
  const verified = st.payments.filter((p) => p.status === 'verified')
  return {
    kind, number, version, issueDate: new Date().toISOString(), reference: o.reference, orderReference: o.reference, currency: fin.currency || 'INR',
    seller: { ...businessBlock(biz), bankDetails: biz.bankDetails || '', terms: biz.terms || '', footer: biz.invoiceFooter || '' },
    customer: { name: o.c_name, phone: o.c_phone, email: o.c_email || '', address: o.c_address || '', billingName: o.billing_name || o.c_bn || '', billingAddress: o.billing_address || o.c_ba || '', billingTaxId: o.billing_tax_id || o.c_bt || '' },
    order: { reference: o.reference, service: o.so_name, eventType: o.event_type, date: o.event_date, plates: o.plates, venue: o.venue_name },
    event: {
      lines: [`${o.event_type} · ${o.so_name}`, `Date: ${new Date(o.event_date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`,
        o.delivery_time ? `Delivery: ${fmtTime12(o.delivery_time)}` : '', o.venue_name ? `Venue: ${o.venue_name}` : '', `Plates: ${o.plates}`].filter(Boolean),
    },
    lines: st.totals.lines.map((l) => ({ description: l.description, quantity: l.quantity, unit: l.unit, unit_price: fromPaise(l.unitPaise), amount: fromPaise(l.amountPaise) })),
    totals: { subtotal: fromPaise(st.totals.subtotal), discount: fromPaise(st.totals.discount), taxRate: st.totals.taxRate, taxLabel: fin.taxLabel || 'GST', tax: fromPaise(st.totals.tax), total: fromPaise(st.totals.total) },
    payments: kind === 'invoice' ? verified.map((p) => ({ id: p.id, date: p.paid_on, method: p.method, reference: p.reference, stage: p.stage, kind: p.kind, amount: Number(p.amount) })) : [],
    paidTotal: kind === 'invoice' ? fromPaise(st.settle.paidTotal) : 0, balance: kind === 'invoice' ? fromPaise(st.settle.balance) : fromPaise(st.totals.total),
    status: st.settle.balance === 0 ? 'Fully Paid' : 'Balance Due',
  }
}

// ---------------- validation helpers ----------------
async function resolveItems(db, ctx, b, existingMealIds = new Set()) {
  const out = []
  for (const [i, it] of b.items.entries()) {
    let name = it.name, unit = it.unit, price = it.unitPrice === undefined ? undefined : toPaise(it.unitPrice, 'item price'), menuItemId = null, mealItemId = null
    if (it.mealItemId) {
      // the managed Catering Menu: name from the menu, unit + price from Catering Prices
      const m = (await db.query(`SELECT i.id, i.name, i.active, c.active AS cat_active, p.unit, p.unit_price FROM meal_menu_items i JOIN menu_categories c ON c.id = i.category_id LEFT JOIN catering_prices p ON p.meal_item_id = i.id WHERE i.id=$1`, [it.mealItemId])).rows[0]
      if (!m) throw badRequest(`Menu item #${i + 1} no longer exists`)
      if ((!m.active || !m.cat_active) && !existingMealIds.has(m.id)) throw badRequest(`"${m.name}" is not active on the catering menu`)
      mealItemId = m.id
      name = m.name
      unit = m.unit || it.unit
      if (b.pricingMode === 'per_plate') price = 0 // plate-priced order: the item is only part of the menu, it carries no price
      else if (m.unit_price === null) {
        if (price === undefined) throw badRequest(`Set a price for "${m.name}" under Catering Prices first`)
        if (!can(ctx.user, 'catering.priceOverride')) throw forbidden(`"${m.name}" has no catering price yet — ask a manager to set it under Catering Prices`)
      } else {
        const serverPrice = toPaise(m.unit_price)
        if (price !== undefined && price !== serverPrice) {
          if (!can(ctx.user, 'catering.priceOverride')) throw forbidden(`Only a manager can change the price of "${m.name}" (catering price is ${inr(serverPrice)})`)
        } else price = serverPrice
      }
    } else if (it.menuItemId) {
      const m = (await db.query('SELECT * FROM menu_items WHERE id=$1', [it.menuItemId])).rows[0]
      if (!m) throw badRequest(`Menu item #${i + 1} no longer exists`)
      if (!m.active) throw badRequest(`"${m.name}" is not active on the menu`)
      menuItemId = m.id
      name = m.name
      unit = m.unit
      const serverPrice = toPaise(m.unit_price)
      if (price !== undefined && price !== serverPrice) {
        if (!can(ctx.user, 'catering.priceOverride')) throw forbidden(`Only a manager can change the price of "${m.name}" (menu price is ${inr(serverPrice)})`)
      } else price = serverPrice
    } else {
      if (!name) throw badRequest(`Custom item #${i + 1} needs a name`)
      if (price === undefined) throw badRequest(`Custom item "${name}" needs a price`)
    }
    out.push({ menuItemId, mealItemId, name, mealType: it.mealType || null, unit, quantity: it.quantity, unitPaise: b.pricingMode === 'per_plate' ? 0 : price, notes: it.notes })
  }
  return out
}

function validateBusinessRules(b, opt) {
  if (b.deliveryTime && b.servingTime && b.servingTime < b.deliveryTime) throw badRequest('Serving time cannot be before the delivery time')
  if (b.staffRequired && b.staffCount < 1) throw badRequest('Enter how many serving staff are needed')
  if (b.pricingMode === 'item_based' && b.items.length === 0 && !opt.allowEmpty) throw badRequest('Add at least one menu item for item-based pricing')
}
function readyForQuotation(st) {
  const o = st.row
  if (st.totals.total <= 0) throw conflict('The order total must be greater than zero', 'NOT_READY')
  if (o.fulfilment_method === 'delivery' && !o.delivery_address.trim()) throw conflict('A delivery address is required for delivery orders', 'NOT_READY')
  if (!o.delivery_time) throw conflict('Set the required food delivery time', 'NOT_READY')
}

async function replaceItems(db, id, items) {
  await db.query('DELETE FROM catering_order_items WHERE order_id=$1', [id])
  for (const [i, it] of items.entries())
    await db.query('INSERT INTO catering_order_items (order_id, menu_item_id, meal_item_id, name, meal_type, unit, quantity, unit_price, notes, position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [id, it.menuItemId, it.mealItemId, it.name, it.mealType, it.unit, it.quantity, fromPaise(it.unitPaise), it.notes, i])
}

async function saveVersion(db, ctx, st, { summary, reason, approvedBy }) {
  await db.query(
    `INSERT INTO catering_order_versions (order_id, version, snapshot, total, change_summary, reason, changed_by, approved_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (order_id, version) DO NOTHING`,
    [st.id, st.row.version, JSON.stringify(orderView(st)), fromPaise(st.totals.total), summary || '', reason || null, ctx.user?.id || null, approvedBy || null],
  )
}

// ---------------- create ----------------
export async function createOrder(db, ctx, raw) {
  const b = parse(orderCreateSchema, raw)
  if (b.date < todayIST()) throw badRequest('Event date cannot be in the past', undefined, 'PAST_DATE')
  const opt = (await db.query('SELECT * FROM catering_service_options WHERE id=$1', [b.serviceOptionId])).rows[0]
  if (!opt || !opt.active) throw badRequest('Choose an available service option')
  validateBusinessRules(b, { allowEmpty: true })
  if (b.bookingId) {
    const bk = (await db.query('SELECT id, status FROM bookings WHERE id=$1', [b.bookingId])).rows[0]
    if (!bk) throw badRequest('Linked hall booking not found')
    if (bk.status === 'cancelled') throw conflict('The linked hall booking is cancelled')
  }
  const fin = await getSetting(db, 'finance')
  const items = await resolveItems(db, ctx, b)
  const customer = await upsertCustomer(db, { ...b.customer, consentSource: 'catering_form' })
  const ref = await nextRef(db, 'catering', todayIST().slice(0, 4), 'BC', 1000)
  const r = await db.query(
    `INSERT INTO catering_orders (reference, customer_id, booking_id, service_option_id, event_type, event_date, delivery_time, serving_time, venue_name, delivery_address, plates,
       contact_person, contact_phone, meal_category, notes, dietary_instructions, packaging_requirements, serving_requirements, fulfilment_method, staff_required, staff_count, staff_charge,
       utensils_required, equipment_notes, equipment_charge, setup_required, setup_charge, delivery_charge, pricing_mode, price_per_plate, discount, tax_rate, billing_name, billing_address, billing_tax_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36) RETURNING id`,
    [ref, customer.id, b.bookingId, b.serviceOptionId, b.eventType, b.date, b.deliveryTime || null, b.servingTime || null, b.venueName, b.deliveryAddress, b.plates,
     b.contactPerson, b.contactPhone || '', b.mealCategory, b.notes, b.dietaryInstructions, b.packagingRequirements, b.servingRequirements, b.fulfilmentMethod, b.staffRequired, b.staffCount, b.staffCharge,
     b.utensilsRequired, b.equipmentNotes, b.equipmentCharge, b.setupRequired, b.setupCharge, b.deliveryCharge, b.pricingMode, b.pricingMode === 'per_plate' ? b.pricePerPlate : 0, b.discount,
     b.taxRate ?? fin.defaultTaxRate ?? 0, customer.billing_name, customer.billing_address, customer.billing_tax_id, ctx.user?.id || null],
  )
  const id = r.rows[0].id
  await replaceItems(db, id, items)
  const st = await loadOrderState(db, id, { lock: true }) // totals computed -> validates discount etc.
  await saveVersion(db, ctx, st, { summary: 'Created' })
  await audit(db, ctx, { action: 'Catering Order Created', entityType: 'catering', entityId: id, summary: `${ref} for ${customer.name} (${st.row.so_name})` })
  if (b.advance) {
    await recordPayment(db, ctx, 'catering', id, { ...b.advance, paidOn: b.advance.paidOn || todayIST(), stage: 'advance' })
    return loadOrderState(db, id)
  }
  return st
}

// ---------------- update ----------------
export async function updateOrder(db, ctx, id, raw) {
  const b = parse(orderUpdateSchema, raw)
  const before = await loadOrderState(db, id, { lock: true })
  if (!before) throw notFound('Catering order')
  const o = before.row
  if (LOCKED_FOR_EDIT.includes(o.status)) throw conflict(`A ${o.status} order cannot be edited`, 'LOCKED')
  if (o.version !== b.expectedVersion) throw conflict('This order was changed by someone else. Reload it and try again.', 'STALE_VERSION', { currentVersion: o.version })
  if (b.date !== o.event_date && b.date < todayIST()) throw badRequest('Event date cannot be moved into the past', undefined, 'PAST_DATE')
  const opt = (await db.query('SELECT * FROM catering_service_options WHERE id=$1', [b.serviceOptionId])).rows[0]
  if (!opt) throw badRequest('Unknown service option')
  validateBusinessRules(b, { allowEmpty: true })
  const existingMealIds = new Set(before.items.map((x) => x.meal_item_id).filter(Boolean))
  const items = await resolveItems(db, ctx, b, existingMealIds)
  const postConfirm = POST_CONFIRM.includes(o.status)

  const prospective = { ...o, pricing_mode: b.pricingMode, price_per_plate: b.pricingMode === 'per_plate' ? b.pricePerPlate : 0, plates: b.plates, delivery_charge: b.deliveryCharge, staff_charge: b.staffCharge, staff_count: b.staffCount,
    equipment_charge: b.equipmentCharge, setup_charge: b.setupCharge, discount: b.discount, tax_rate: b.taxRate ?? o.tax_rate }
  const newTotals = cateringTotals(prospective, items.map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit, unit_price: fromPaise(i.unitPaise) })))
  const sameFood = JSON.stringify(before.items.map((i) => [i.name, Number(i.quantity), toPaise(i.unit_price)])) === JSON.stringify(items.map((i) => [i.name, Number(i.quantity), i.unitPaise]))
  const quantitiesChanged = b.plates !== o.plates || !sameFood
  const totalChanged = newTotals.total !== before.totals.total
  const newSettle = settlement(newTotals, before.payments)
  const hasInvoice = (await db.query(`SELECT 1 FROM invoices WHERE catering_order_id=$1 AND status='issued'`, [id])).rowCount > 0
  const impact = { previousTotal: fromPaise(before.totals.total), newTotal: fromPaise(newTotals.total), difference: fromPaise(newTotals.total - before.totals.total), paid: fromPaise(before.settle.paidTotal), newBalance: fromPaise(newSettle.balance), hasInvoice, refundDue: newSettle.balance < 0 ? fromPaise(-newSettle.balance) : 0, previousPlates: o.plates, newPlates: b.plates }

  if (postConfirm && (totalChanged || quantitiesChanged)) {
    if (!can(ctx.user, 'catering.approveChange')) throw forbidden('Changing the plates, menu or price of a confirmed order needs manager approval')
    if (!b.confirm.financial || !b.reason) throw conflict('Confirm the revised total and give a reason', 'CONFIRMATION_REQUIRED', { required: ['financial'], impact, reasonRequired: true })
  }
  if (o.status === 'exception' || postConfirm) {
    if (b.serviceOptionId !== o.service_option_id) throw conflict('The service option cannot be changed after confirmation', 'LOCKED')
  }

  const customer = await upsertCustomer(db, { ...b.customer, consentSource: 'catering_edit' })
  await db.query(
    `UPDATE catering_orders SET customer_id=$2, booking_id=$3, service_option_id=$4, event_type=$5, event_date=$6, delivery_time=$7, serving_time=$8, venue_name=$9, delivery_address=$10, plates=$11,
       contact_person=$12, contact_phone=$13, meal_category=$14, notes=$15, dietary_instructions=$16, packaging_requirements=$17, serving_requirements=$18, fulfilment_method=$19, staff_required=$20, staff_count=$21,
       staff_charge=$22, utensils_required=$23, equipment_notes=$24, equipment_charge=$25, setup_required=$26, setup_charge=$27, delivery_charge=$28, pricing_mode=$29, price_per_plate=$30, discount=$31, tax_rate=$32,
       version=version+1, updated_at=now() WHERE id=$1 AND version=$33`,
    [id, customer.id, b.bookingId, b.serviceOptionId, b.eventType, b.date, b.deliveryTime || null, b.servingTime || null, b.venueName, b.deliveryAddress, b.plates, b.contactPerson, b.contactPhone || '', b.mealCategory, b.notes,
     b.dietaryInstructions, b.packagingRequirements, b.servingRequirements, b.fulfilmentMethod, b.staffRequired, b.staffCount, b.staffCharge, b.utensilsRequired, b.equipmentNotes, b.equipmentCharge, b.setupRequired, b.setupCharge,
     b.deliveryCharge, b.pricingMode, b.pricingMode === 'per_plate' ? b.pricePerPlate : 0, b.discount, b.taxRate ?? o.tax_rate, b.expectedVersion],
  )
  await replaceItems(db, id, items)
  const after = await loadOrderState(db, id)
  const invoiceStale = hasInvoice && fingerprint(orderInvoiceCore(before)) !== fingerprint(orderInvoiceCore(after))
  if (invoiceStale && (!b.confirm.invoice || !b.reason)) throw conflict('This order already has an issued invoice that will be superseded. Confirm and give a reason.', 'CONFIRMATION_REQUIRED', { required: ['invoice'], impact, reasonRequired: true })
  const summary = [totalChanged && `total ${inr(before.totals.total)} → ${inr(after.totals.total)}`, quantitiesChanged && 'quantities/menu', b.date !== o.event_date && 'date'].filter(Boolean).join(', ') || 'details'
  await saveVersion(db, ctx, after, { summary, reason: b.reason, approvedBy: postConfirm && (totalChanged || quantitiesChanged) ? ctx.user.id : null })
  await audit(db, ctx, { action: 'Catering Order Edited', entityType: 'catering', entityId: id, summary: `${o.reference}: ${summary}`, details: { impact, reason: b.reason || null } })
  await settleOrder(db, ctx, id, { event: 'edited', reason: invoiceStale ? `Order amended: ${b.reason}` : undefined })
  return { state: await loadOrderState(db, id), impact }
}

// ---------------- lifecycle ----------------
export async function transition(db, ctx, id, to, { reason, confirm } = {}) {
  const st = await loadOrderState(db, id, { lock: true })
  if (!st) throw notFound('Catering order')
  const o = st.row
  if (!NEXT[o.status]?.includes(to)) throw conflict(`An order that is ${o.status.replace(/_/g, ' ')} cannot move to ${to.replace(/_/g, ' ')}`, 'BAD_TRANSITION', { allowed: NEXT[o.status] })
  if (to === 'cancelled' && !can(ctx.user, 'catering.cancel')) throw forbidden('Only a manager can cancel an order')
  if (to === 'completed' && !can(ctx.user, 'catering.complete')) throw forbidden('Only a manager can mark an order completed')
  if (!can(ctx.user, 'catering.progress')) throw forbidden()
  const active = st.assignments.find((a) => a.is_active)

  if (to === 'quotation_sent') {
    const q = (await db.query('SELECT 1 FROM catering_quotations WHERE order_id=$1', [id])).rowCount
    if (!q) throw conflict('Generate a quotation first', 'NO_QUOTATION')
  }
  if (['confirmed'].includes(to)) readyForQuotation(st)
  if (to === 'preparation' && o.so_requires_vendor) {
    if (!active || !['accepted', 'in_preparation', 'ready'].includes(active.status)) throw conflict('Assign a vendor and record their acceptance before starting preparation', 'VENDOR_REQUIRED')
  }
  if (to === 'ready_for_dispatch' && o.so_requires_vendor && !(active && ['ready', 'in_preparation', 'accepted'].includes(active.status))) throw conflict('The vendor has not accepted this order', 'VENDOR_REQUIRED')
  if (to === 'delivered' && o.so_requires_vendor && !(active && active.status === 'delivered')) throw conflict('Record the vendor delivery (with their final cost) first', 'VENDOR_REQUIRED')
  if (to === 'cancelled') {
    if (!reason) throw badRequest('Give a cancellation reason')
    if ((st.settle.paidTotal > 0 || st.settle.pending > 0) && !confirm) throw conflict(`This order has ${inr(st.settle.paidTotal)} paid. Confirm cancellation (refunds are handled separately).`, 'CONFIRMATION_REQUIRED', { required: ['cancel'] })
  }
  if (to === 'exception' && !reason) throw badRequest('Describe the exception (e.g. delivery delayed, vendor unavailable)')

  const sets = ['status=$2', 'version=version+1', 'updated_at=now()']
  const params = [id, to]
  if (to === 'exception') { params.push(o.status, reason); sets.push(`status_before_exception=$${params.length - 1}`, `exception_reason=$${params.length}`) }
  if (o.status === 'exception') sets.push('exception_reason=NULL', 'status_before_exception=NULL')
  if (to === 'cancelled') { params.push(reason); sets.push('cancelled_at=now()', `cancel_reason=$${params.length}`) }
  await db.query(`UPDATE catering_orders SET ${sets.join(', ')} WHERE id=$1`, params)
  if (to === 'cancelled') {
    await db.query(`UPDATE vendor_assignments SET status='cancelled', is_active=false, updated_at=now() WHERE order_id=$1 AND is_active AND status NOT IN ('delivered')`, [id])
    const live = (await db.query(`SELECT id, invoice_number FROM invoices WHERE catering_order_id=$1 AND status='issued' FOR UPDATE`, [id])).rows[0]
    if (live) {
      await db.query(`UPDATE invoices SET status='void', status_reason='Order cancelled', status_changed_at=now(), status_changed_by=$2 WHERE id=$1`, [live.id, ctx.user?.id || null])
      await audit(db, ctx, { action: 'Invoice Voided', entityType: 'invoice', entityId: live.id, summary: `${live.invoice_number}: order cancelled` })
    }
  }
  await audit(db, ctx, { action: `Catering ${to.replace(/_/g, ' ')}`, entityType: 'catering', entityId: id, summary: `${o.reference}: ${o.status} → ${to}${reason ? ` (${reason})` : ''}` })
  const after = await loadOrderState(db, id)
  if (to === 'confirmed') await saveVersion(db, ctx, after, { summary: 'Confirmed', approvedBy: ctx.user?.id })
  await settleOrder(db, ctx, id, { event: 'status' })
  if (to === 'delivered' || to === 'completed') await enqueueThanks(db, ctx, 'catering', id, { auto: true }) // once per order (idempotent)
  return loadOrderState(db, id)
}

async function maybeNotifyConfirmed(db, ctx, st) {
  if (!POST_CONFIRM.includes(st.row.status) && st.row.status !== 'completed') return
  if (st.settle.paidTotal <= 0) return
  const o = st.row
  const customer = { id: o.customer_id, name: o.c_name, phone: o.c_phone, language: o.c_lang, message_consent: o.c_consent }
  const biz = await getSetting(db, 'business')
  await enqueue(db, ctx, {
    key: `catering_confirmation:${o.id}`, type: 'catering_confirmation', templateKey: 'catering_confirmation', cateringOrderId: o.id, customer,
    vars: { customer_name: o.c_name, order_reference: o.reference, event_date: new Date(o.event_date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }),
      delivery_time: o.delivery_time ? fmtTime12(o.delivery_time) : '-', plates: o.plates, total_amount: inr(st.totals.total), advance_amount: inr(st.settle.paidTotal), remaining_balance: inr(Math.max(0, st.settle.balance)), restaurant_phone: biz.phone || '' },
  })
}

export async function settleOrder(db, ctx, id, { event, reason } = {}) {
  const st = await loadOrderState(db, id)
  if (!st) return null
  if (st.row.status !== 'cancelled') {
    await maybeNotifyConfirmed(db, ctx, st) // confirmation only after: order confirmed AND a verified advance exists
    await reconcileInvoice(db, ctx, { kind: 'catering', id, totalPaise: st.totals.total, paidPaise: st.settle.paidTotal, state: st.settle.state, fingerprintCore: orderInvoiceCore(st), buildSnapshot: (v) => buildDocSnapshot(db, st, v), onFirstInvoice: (inv) => enqueueBill(db, ctx, inv, { auto: true }) },
      { trigger: event === 'manual' ? 'manual' : 'payment_verified', reason })
  }
  return st
}
registerDoc('catering', { load: (db, id, o) => loadOrderState(db, id, o), afterMoney: (db, ctx, id, info) => settleOrder(db, ctx, id, info) })

export async function issueOrderInvoiceNow(db, ctx, id) {
  const st = await loadOrderState(db, id, { lock: true })
  if (!st) throw notFound('Catering order')
  if (st.settle.state !== 'paid') throw conflict('An invoice can only be issued when the verified balance is zero', 'NOT_FULLY_PAID', { balance: fromPaise(st.settle.balance) })
  await settleOrder(db, ctx, id, { event: 'manual' })
  return listInvoices(db, 'WHERE catering_order_id=$1', [id])
}

// ---------------- quotations ----------------
export async function createQuotation(db, ctx, id) {
  const st = await loadOrderState(db, id, { lock: true })
  if (!st) throw notFound('Catering order')
  if (!['draft', 'quotation_sent', 'awaiting_confirmation'].includes(st.row.status)) throw conflict('Quotations can only be generated before confirmation', 'BAD_STATE')
  readyForQuotation(st)
  const fin = await getSetting(db, 'finance')
  const prev = (await db.query('SELECT COALESCE(max(version),0) v FROM catering_quotations WHERE order_id=$1', [id])).rows[0].v
  const fy = financialYear()
  const n = (await db.query('SELECT next_counter($1,$2,0) n', ['quotation', fy])).rows[0].n
  const number = `${fin.quotationPrefix || 'QT'}/${fy}/${String(n).padStart(6, '0')}`
  const valid = new Date(Date.now() + (fin.quotationValidDays || 7) * 86400000 + 5.5 * 3600000).toISOString().slice(0, 10)
  const snap = await buildDocSnapshot(db, st, { version: prev + 1, number }, 'quotation')
  snap.validUntil = valid
  const q = (await db.query(
    `INSERT INTO catering_quotations (order_id, quotation_number, version, order_version, snapshot, total, valid_until, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [id, number, prev + 1, st.row.version, JSON.stringify(snap), fromPaise(st.totals.total), valid, ctx.user?.id || null],
  )).rows[0]
  if (st.row.status === 'draft') await db.query(`UPDATE catering_orders SET status='quotation_sent', updated_at=now() WHERE id=$1`, [id])
  await audit(db, ctx, { action: 'Quotation Generated', entityType: 'catering', entityId: id, summary: `${number} (${inr(st.totals.total)})` })
  return q
}
export const quotationView = (q) => ({ id: q.id, orderId: q.order_id, number: q.quotation_number, version: q.version, orderVersion: q.order_version, total: Number(q.total), validUntil: q.valid_until, createdAt: q.created_at })

// ---------------- vendor assignments ----------------
const VSTEPS = { proposed: ['quoted', 'assigned', 'declined', 'cancelled'], quoted: ['assigned', 'declined', 'cancelled'], assigned: ['accepted', 'declined', 'cancelled'], accepted: ['in_preparation', 'ready', 'failed', 'cancelled'],
  in_preparation: ['ready', 'failed', 'cancelled'], ready: ['delivered', 'failed', 'cancelled'], delivered: [], declined: [], failed: [], cancelled: [] }
export async function assignVendor(db, ctx, id, vendorId) {
  const st = await loadOrderState(db, id, { lock: true })
  if (!st) throw notFound('Catering order')
  if (['cancelled', 'completed', 'delivered'].includes(st.row.status)) throw conflict(`Cannot assign a vendor to a ${st.row.status} order`, 'BAD_STATE')
  const v = (await db.query('SELECT * FROM vendors WHERE id=$1', [vendorId])).rows[0]
  if (!v || !v.active) throw badRequest('Choose an active vendor')
  const cur = st.assignments.find((a) => a.is_active)
  if (cur && ['in_preparation', 'ready', 'delivered'].includes(cur.status)) throw conflict('The current vendor has already started; mark them failed or cancelled before reassigning', 'BAD_STATE')
  if (cur) await db.query(`UPDATE vendor_assignments SET is_active=false, status=CASE WHEN status IN ('declined','failed','cancelled') THEN status ELSE 'cancelled' END, updated_at=now() WHERE id=$1`, [cur.id])
  await db.query(`INSERT INTO vendor_assignments (order_id, vendor_id, created_by) VALUES ($1,$2,$3)`, [id, vendorId, ctx.user?.id || null])
  await audit(db, ctx, { action: 'Vendor Assigned', entityType: 'catering', entityId: id, summary: `${st.row.reference} → ${v.name}` })
  return loadOrderState(db, id)
}
export async function updateAssignment(db, ctx, id, input) {
  const st = await loadOrderState(db, id, { lock: true })
  if (!st) throw notFound('Catering order')
  const a = st.assignments.find((x) => x.is_active)
  if (!a) throw conflict('No vendor is assigned to this order', 'NO_VENDOR')
  let status = a.status
  if (input.status && input.status !== a.status) {
    if (!VSTEPS[a.status].includes(input.status)) throw conflict(`Vendor status cannot go from ${a.status} to ${input.status}`, 'BAD_TRANSITION', { allowed: VSTEPS[a.status] })
    status = input.status
  }
  const quote = input.quoteAmount === undefined ? a.quote_amount : toPaise(input.quoteAmount, 'quote') / 100
  const agreed = input.agreedCost === undefined ? a.agreed_cost : toPaise(input.agreedCost, 'agreed cost') / 100
  const final = input.finalCost === undefined ? a.final_cost : toPaise(input.finalCost, 'final cost') / 100
  if (status === 'quoted' && quote === null) throw badRequest('Enter the vendor\'s quoted amount')
  if (['assigned', 'accepted'].includes(status) && agreed === null) throw badRequest('Enter the agreed cost with the vendor')
  if (status === 'delivered' && final === null) throw badRequest('Enter the vendor\'s final cost to record delivery')
  const stamp = (col, when) => (status === when && a.status !== when ? `, ${col}=now()` : '')
  await db.query(
    `UPDATE vendor_assignments SET status=$2, quote_amount=$3, agreed_cost=$4, final_cost=$5, notes=$6, updated_at=now()
       ${stamp('quoted_at', 'quoted')}${stamp('assigned_at', 'assigned')}${stamp('accepted_at', 'accepted')}${stamp('delivered_at', 'delivered')} WHERE id=$1`,
    [a.id, status, quote, agreed, final, input.notes ?? a.notes],
  )
  await audit(db, ctx, { action: 'Vendor Updated', entityType: 'catering', entityId: id, summary: `${st.row.reference}: ${a.vendor_name} ${a.status}${status !== a.status ? ` → ${status}` : ''}`, details: { quote, agreed, final } })
  return loadOrderState(db, id)
}

// ---------------- queries ----------------
export async function listOrders(db, f) {
  const where = [], p = []
  const add = (sql, v) => { p.push(v); where.push(sql.replace('?', `$${p.length}`)) }
  if (f.from) add('o.event_date >= ?', f.from)
  if (f.to) add('o.event_date <= ?', f.to)
  if (f.status) add('o.status = ?', f.status)
  if (f.serviceOptionId) add('o.service_option_id = ?', f.serviceOptionId)
  if (f.bookingId) add('o.booking_id = ?', f.bookingId)
  if (f.vendorId) add('EXISTS (SELECT 1 FROM vendor_assignments a WHERE a.order_id=o.id AND a.is_active AND a.vendor_id = ?)', f.vendorId)
  if (f.q) {
    const q = String(f.q).trim()
    p.push(`%${q.replace(/[%_\\]/g, '')}%`)
    const i = p.length
    let clause = `(c.name ILIKE $${i} OR o.reference ILIKE $${i} OR o.venue_name ILIKE $${i} OR o.event_type ILIKE $${i}`
    const digits = q.replace(/\D/g, '')
    if (digits) { p.push(`%${digits}%`); clause += ` OR c.phone LIKE $${p.length}` }
    where.push(clause + ')')
  }
  const rows = (await db.query(`${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY o.event_date, o.delivery_time NULLS LAST LIMIT 2000`, p)).rows
  if (!rows.length) return []
  const ids = rows.map((r) => r.id)
  const items = (await db.query('SELECT * FROM catering_order_items WHERE order_id = ANY($1) ORDER BY position', [ids])).rows
  const pays = (await db.query(`SELECT p.*, COALESCE((SELECT json_agg(json_build_object('bucket', a.bucket, 'amount', a.amount)) FROM payment_allocations a WHERE a.payment_id=p.id), '[]') AS allocations FROM payments p WHERE p.catering_order_id = ANY($1)`, [ids])).rows
  const asg = (await db.query(`SELECT a.*, v.name AS vendor_name FROM vendor_assignments a JOIN vendors v ON v.id=a.vendor_id WHERE a.order_id = ANY($1) ORDER BY a.created_at`, [ids])).rows
  let out = rows.map((row) => {
    const it = items.filter((i) => i.order_id === row.id), pm = pays.filter((x) => x.catering_order_id === row.id)
    const totals = cateringTotals(row, it)
    return orderView({ row, items: it, payments: pm, totals, settle: settlement(totals, pm), assignments: asg.filter((a) => a.order_id === row.id) })
  })
  if (f.payment === 'pending') out = out.filter((o) => !['cancelled'].includes(o.status) && o.money.balance > 0)
  return out
}

export async function orderDetail(db, id) {
  const st = await loadOrderState(db, id)
  if (!st) throw notFound('Catering order')
  const versions = (await db.query('SELECT id, version, total, change_summary, reason, created_at, changed_by, approved_by FROM catering_order_versions WHERE order_id=$1 ORDER BY version DESC', [id])).rows
  const quotations = (await db.query('SELECT * FROM catering_quotations WHERE order_id=$1 ORDER BY version DESC', [id])).rows.map(quotationView)
  const invoices = await listInvoices(db, 'WHERE catering_order_id=$1', [id])
  const notifs = (await db.query('SELECT * FROM notification_events WHERE catering_order_id=$1 ORDER BY created_at DESC', [id])).rows
  const lastQ = quotations[0]
  return orderView(st, {
    payments: st.payments.map(paymentView), invoices, quotations, quotationCurrent: !!lastQ && lastQ.orderVersion === st.row.version,
    versions: versions.map((v) => ({ id: v.id, version: v.version, total: Number(v.total), summary: v.change_summary, reason: v.reason, at: v.created_at })),
    assignments: st.assignments.map(vendorView), notifications: notifs.map(eventView), allowedNext: NEXT[st.row.status] || [],
  })
}
export async function getVersionSnapshot(db, id, version) {
  const r = (await db.query('SELECT snapshot FROM catering_order_versions WHERE order_id=$1 AND version=$2', [id, version])).rows[0]
  if (!r) throw notFound('Order version')
  return r.snapshot
}
