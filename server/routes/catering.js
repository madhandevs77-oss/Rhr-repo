import { methodEnum, splitsIn } from '../lib/splits.js'
import { Router } from 'express'
import { query, tx } from '../db/pool.js'
import { requirePerm } from '../lib/auth.js'
import { conflict, notFound } from '../lib/errors.js'
import { isoDate, money, parse, uuid, z } from '../lib/validate.js'
import { assignVendor, createOrder, createQuotation, getVersionSnapshot, issueOrderInvoiceNow, listOrders, loadOrderState, orderDetail, orderView, quotationView, STATUSES, transition, updateAssignment, updateOrder } from '../services/catering.js'
import { recordPayment } from '../services/payments.js'
import { enqueueThanks, eventView } from '../services/notifications.js'
import { renderPdf } from '../services/pdf.js'
import { audit } from '../services/support.js'
import { paymentResponse } from './core.js'
import { consumeDraft } from './drafts.js'

const ctxOf = (req) => ({ user: req.user, ip: req.ip })

// ================= orders =================
export const cateringRouter = Router()
const listQuery = z.object({ from: isoDate.optional(), to: isoDate.optional(), q: z.string().max(100).optional(), status: z.enum(STATUSES).optional(), serviceOptionId: uuid.optional(), vendorId: uuid.optional(), bookingId: uuid.optional(), payment: z.enum(['pending']).optional() })

// service options (admin can rename / describe / switch off)
cateringRouter.get('/options', requirePerm('catering.view'), async (_req, res) => {
  const r = await query('SELECT * FROM catering_service_options ORDER BY code')
  res.json({ options: r.rows.map((o) => ({ id: o.id, code: o.code, name: o.name, description: o.description, includesStaff: o.includes_staff, includesUtensils: o.includes_utensils, includesSetup: o.includes_setup, requiresVendor: o.requires_vendor, active: o.active })) })
})
cateringRouter.patch('/options/:id', requirePerm('settings.edit'), async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(2).max(80).optional(), description: z.string().trim().max(500).optional(), includesStaff: z.boolean().optional(), includesUtensils: z.boolean().optional(), includesSetup: z.boolean().optional(), requiresVendor: z.boolean().optional(), active: z.boolean().optional() }), req.body)
  const r = await query(
    `UPDATE catering_service_options SET name=COALESCE($2,name), description=COALESCE($3,description), includes_staff=COALESCE($4,includes_staff), includes_utensils=COALESCE($5,includes_utensils),
       includes_setup=COALESCE($6,includes_setup), requires_vendor=COALESCE($7,requires_vendor), active=COALESCE($8,active), updated_at=now() WHERE id=$1 RETURNING *`,
    [req.params.id, b.name ?? null, b.description ?? null, b.includesStaff ?? null, b.includesUtensils ?? null, b.includesSetup ?? null, b.requiresVendor ?? null, b.active ?? null])
  if (!r.rows[0]) throw notFound('Service option')
  await audit({ query }, ctxOf(req), { action: 'Catering Option Updated', entityType: 'catering_option', entityId: req.params.id, summary: r.rows[0].name, details: b })
  res.json({ ok: true })
})

cateringRouter.get('/', requirePerm('catering.view'), async (req, res) => {
  res.json({ orders: await listOrders({ query }, parse(listQuery, req.query)) })
})
cateringRouter.post('/', requirePerm('catering.create'), async (req, res) => {
  const st = await tx(async (c) => { const r = await createOrder(c, ctxOf(req), req.body); await consumeDraft(c, ctxOf(req), req.body?.draftId, 'catering'); return r })
  res.status(201).json({ order: orderView(st) })
})
cateringRouter.get('/quotations/:qid', requirePerm('catering.view'), async (req, res) => {
  const q = (await query('SELECT * FROM catering_quotations WHERE id=$1', [req.params.qid])).rows[0]
  if (!q) throw notFound('Quotation')
  res.json({ quotation: quotationView(q), snapshot: q.snapshot })
})
cateringRouter.get('/quotations/:qid/pdf', requirePerm('catering.view'), async (req, res) => {
  const q = (await query('SELECT * FROM catering_quotations WHERE id=$1', [req.params.qid])).rows[0]
  if (!q) throw notFound('Quotation')
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${q.quotation_number.replace(/[^\w.-]+/g, '_')}.pdf"`)
  renderPdf(q.snapshot, { kind: 'quotation' }).pipe(res)
})
cateringRouter.get('/:id', requirePerm('catering.view'), async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw notFound('Catering order')
  res.json({ order: await orderDetail({ query }, req.params.id) })
})
cateringRouter.get('/:id/versions/:v', requirePerm('catering.view'), async (req, res) => {
  res.json({ snapshot: await getVersionSnapshot({ query }, req.params.id, parseInt(req.params.v, 10)) })
})
cateringRouter.put('/:id', requirePerm('catering.edit'), async (req, res) => {
  const out = await tx((c) => updateOrder(c, ctxOf(req), req.params.id, req.body))
  res.json({ order: orderView(out.state), impact: out.impact })
})
cateringRouter.post('/:id/status', requirePerm('catering.progress'), async (req, res) => {
  const b = parse(z.object({ to: z.enum(STATUSES), reason: z.string().trim().max(500).optional(), confirm: z.boolean().optional() }), req.body)
  const st = await tx((c) => transition(c, ctxOf(req), req.params.id, b.to, b))
  res.json({ order: orderView(st) })
})
cateringRouter.post('/:id/quotations', requirePerm('catering.edit'), async (req, res) => {
  const q = await tx((c) => createQuotation(c, ctxOf(req), req.params.id))
  res.status(201).json({ quotation: quotationView(q) })
})
cateringRouter.post('/:id/vendor', requirePerm('vendors.manage'), async (req, res) => {
  const { vendorId } = parse(z.object({ vendorId: uuid }), req.body)
  res.json({ order: orderView(await tx((c) => assignVendor(c, ctxOf(req), req.params.id, vendorId))) })
})
cateringRouter.patch('/:id/vendor', requirePerm('vendors.manage'), async (req, res) => {
  const b = parse(z.object({ status: z.enum(['proposed', 'quoted', 'assigned', 'accepted', 'declined', 'in_preparation', 'ready', 'delivered', 'failed', 'cancelled']).optional(), quoteAmount: money.optional(), agreedCost: money.optional(), finalCost: money.optional(), notes: z.string().max(500).optional() }), req.body)
  res.json({ order: orderView(await tx((c) => updateAssignment(c, ctxOf(req), req.params.id, b))) })
})
cateringRouter.post('/:id/payments', requirePerm('payments.record'), async (req, res) => {
  const b = parse(z.object({ amount: money, method: methodEnum.default('Cash'), splits: splitsIn, paidOn: isoDate, stage: z.enum(['advance', 'part', 'final']).default('part'), reference: z.string().trim().max(100).default(''), notes: z.string().trim().max(300).default(''), idempotencyKey: z.string().trim().max(100).optional(), verify: z.boolean().optional() }), req.body)
  paymentResponse(await tx((c) => recordPayment(c, ctxOf(req), 'catering', req.params.id, b)), res)
})
cateringRouter.post('/:id/invoices/issue', requirePerm('invoices.issue'), async (req, res) => {
  res.json({ invoices: await tx((c) => issueOrderInvoiceNow(c, ctxOf(req), req.params.id)) })
})

cateringRouter.post('/:id/thank-you', requirePerm('messages.send'), async (req, res) => {
  const b = parse(z.object({ channels: z.array(z.enum(['email', 'phone', 'sms', 'whatsapp'])).min(1).optional() }), req.body || {})
  const events = await tx((c) => enqueueThanks(c, ctxOf(req), 'catering', req.params.id, { auto: false, channels: b.channels }))
  res.status(201).json({ notifications: events.map(eventView) })
})

// ================= vendors =================
export const vendorsRouter = Router()
const vendorBody = z.object({ name: z.string().trim().min(2).max(120), contactPerson: z.string().trim().max(120).default(''), phone: z.string().trim().max(20).default(''), email: z.string().trim().max(120).default(''), address: z.string().trim().max(500).default(''), notes: z.string().trim().max(1000).default(''), active: z.boolean().default(true) })
const vview = (v) => ({ id: v.id, name: v.name, contactPerson: v.contact_person, phone: v.phone, email: v.email, address: v.address, notes: v.notes, active: v.active })
vendorsRouter.get('/', requirePerm('vendors.view'), async (_req, res) => {
  const r = await query(`SELECT v.*, (SELECT count(*)::int FROM vendor_assignments a WHERE a.vendor_id=v.id AND a.is_active) AS open_orders FROM vendors v ORDER BY v.active DESC, v.name`)
  res.json({ vendors: r.rows.map((v) => ({ ...vview(v), openOrders: v.open_orders })) })
})
vendorsRouter.post('/', requirePerm('vendors.manage'), async (req, res) => {
  const b = parse(vendorBody, req.body)
  try {
    const r = await query('INSERT INTO vendors (name, contact_person, phone, email, address, notes, active) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [b.name, b.contactPerson, b.phone, b.email, b.address, b.notes, b.active])
    await audit({ query }, ctxOf(req), { action: 'Vendor Created', entityType: 'vendor', entityId: r.rows[0].id, summary: b.name })
    res.status(201).json({ vendor: vview(r.rows[0]) })
  } catch (e) {
    if (e.code === '23505') throw conflict('A vendor with that name already exists', 'DUPLICATE')
    throw e
  }
})
vendorsRouter.patch('/:id', requirePerm('vendors.manage'), async (req, res) => {
  const b = parse(vendorBody.partial(), req.body)
  const cur = (await query('SELECT * FROM vendors WHERE id=$1', [req.params.id])).rows[0]
  if (!cur) throw notFound('Vendor')
  const r = await query('UPDATE vendors SET name=$2, contact_person=$3, phone=$4, email=$5, address=$6, notes=$7, active=$8, updated_at=now() WHERE id=$1 RETURNING *',
    [cur.id, b.name ?? cur.name, b.contactPerson ?? cur.contact_person, b.phone ?? cur.phone, b.email ?? cur.email, b.address ?? cur.address, b.notes ?? cur.notes, b.active ?? cur.active])
  await audit({ query }, ctxOf(req), { action: 'Vendor Updated', entityType: 'vendor', entityId: cur.id, summary: cur.name })
  res.json({ vendor: vview(r.rows[0]) })
})

// ================= menu =================
export const menuRouter = Router()
const menuBody = z.object({
  name: z.string().trim().min(1).max(150), category: z.string().trim().min(1).max(80), unit: z.enum(['plate', 'kg', 'litre', 'piece', 'tray', 'packet']).default('plate'),
  unitPrice: money.default(0), mealTypes: z.array(z.string().trim().max(40)).max(8).default([]), active: z.boolean().default(true),
})
const mview = (m) => ({ id: m.id, name: m.name, category: m.category, unit: m.unit, unitPrice: Number(m.unit_price), mealTypes: m.meal_types, active: m.active })
menuRouter.get('/', requirePerm('menu.view'), async (_req, res) => {
  res.json({ items: (await query('SELECT * FROM menu_items ORDER BY category, sort, name')).rows.map(mview) })
})
menuRouter.post('/', requirePerm('menu.manage'), async (req, res) => {
  const b = parse(menuBody, req.body)
  try {
    const r = await query('INSERT INTO menu_items (name, category, unit, unit_price, meal_types, active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [b.name, b.category, b.unit, b.unitPrice, b.mealTypes, b.active])
    await audit({ query }, ctxOf(req), { action: 'Menu Item Created', entityType: 'menu', entityId: r.rows[0].id, summary: `${b.name} (${b.category})` })
    res.status(201).json({ item: mview(r.rows[0]) })
  } catch (e) {
    if (e.code === '23505') throw conflict('That item already exists in this category', 'DUPLICATE')
    throw e
  }
})
menuRouter.patch('/:id', requirePerm('menu.manage'), async (req, res) => {
  const b = parse(menuBody.partial(), req.body)
  const cur = (await query('SELECT * FROM menu_items WHERE id=$1', [req.params.id])).rows[0]
  if (!cur) throw notFound('Menu item')
  const r = await query('UPDATE menu_items SET name=$2, category=$3, unit=$4, unit_price=$5, meal_types=$6, active=$7, updated_at=now() WHERE id=$1 RETURNING *',
    [cur.id, b.name ?? cur.name, b.category ?? cur.category, b.unit ?? cur.unit, b.unitPrice ?? cur.unit_price, b.mealTypes ?? cur.meal_types, b.active ?? cur.active])
  await audit({ query }, ctxOf(req), { action: 'Menu Item Updated', entityType: 'menu', entityId: cur.id, summary: cur.name, details: b })
  res.json({ item: mview(r.rows[0]) })
})
menuRouter.delete('/:id', requirePerm('menu.manage'), async (req, res) => {
  const used = (await query('SELECT (SELECT count(*) FROM catering_order_items WHERE menu_item_id=$1)::int n', [req.params.id])).rows[0].n
  if (used > 0) {
    await query('UPDATE menu_items SET active=false, updated_at=now() WHERE id=$1', [req.params.id])
    return res.json({ ok: true, deactivated: true, message: 'Used in past orders, so it was deactivated instead of deleted.' })
  }
  const r = await query('DELETE FROM menu_items WHERE id=$1', [req.params.id])
  if (!r.rowCount) throw notFound('Menu item')
  await audit({ query }, ctxOf(req), { action: 'Menu Item Deleted', entityType: 'menu', entityId: req.params.id })
  res.json({ ok: true })
})
