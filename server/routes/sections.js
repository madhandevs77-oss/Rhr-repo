// Seven booking sections (dashboard + calendar) and the price-free Breakfast/Lunch/Dinner menu (+ menu-only print / PDF).
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Router } from 'express'
import PDFDocument from 'pdfkit'
import { query, tx } from '../db/pool.js'
import { can, requirePerm } from '../lib/auth.js'
import { badRequest, conflict, notFound } from '../lib/errors.js'
import { isoDate, parse, uuid, z } from '../lib/validate.js'
import { bookingTotals, settlement } from '../services/pricing.js'
import { loadPayments } from '../services/payments.js'
import { audit, todayIST } from '../services/support.js'

const ctxOf = (req) => ({ user: req.user, ip: req.ip })
const hhmm = (t) => String(t).slice(0, 5)

// ================= sections (dashboard cards) =================
export const sectionsRouter = Router()
sectionsRouter.get('/', requirePerm('bookings.view'), async (_req, res) => {
  const today = todayIST()
  const halls = (await query(`SELECT id, name, kind, default_charge, section_order, active FROM halls ORDER BY COALESCE(kind = 'outsource', false), section_order NULLS LAST, lower(name)`)).rows
  const bk = (await query(
    `SELECT b.id, b.hall_id, b.reference, b.event_date, b.start_time, b.end_time, b.status, b.meals, c.name AS customer
     FROM bookings b JOIN customers c ON c.id=b.customer_id JOIN halls h ON h.id=b.hall_id
     WHERE b.status <> 'cancelled' AND b.event_date >= $1::date ORDER BY b.event_date, b.start_time`, [today])).rows
  res.json({
    today,
    sections: halls.map((h) => {
      const mine = bk.filter((b) => b.hall_id === h.id)
      const todays = mine.filter((b) => b.event_date === today)
      const next = mine.find((b) => b.event_date > today) || null
      return {
        id: h.id, name: h.name, kind: h.kind, order: h.section_order, active: h.active, defaultCharge: Number(h.default_charge),
        todayStatus: todays.length ? 'booked' : 'free',
        today: todays.map((b) => ({ id: b.id, startTime: hhmm(b.start_time), endTime: hhmm(b.end_time), customer: b.customer, status: b.status, meals: b.meals })),
        upcomingCount: mine.filter((b) => b.event_date > today).length,
        next: next && { id: next.id, date: next.event_date, startTime: hhmm(next.start_time), customer: next.customer },
      }
    }),
  })
})

// ================= calendar =================
export const calendarRouter = Router()
// Halls = Mandapam, Mini Hall and every other hall (added later); Outsource = the five outsource sections.
const inGroup = (g) => `($${g}::text IS NULL OR ($${g} = 'outsource') = COALESCE(h.kind = 'outsource', false))`
const monthQ = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), hallId: uuid.optional(), group: z.enum(['halls', 'outsource']).optional() })
calendarRouter.get('/', requirePerm('bookings.view'), async (req, res) => {
  const q = parse(monthQ, req.query)
  const first = `${q.month}-01`
  const r = await query(
    `SELECT b.event_date AS d, count(*)::int AS n FROM bookings b JOIN halls h ON h.id = b.hall_id
     WHERE b.status <> 'cancelled' AND b.event_date >= $1::date AND b.event_date < ($1::date + interval '1 month')::date AND ($2::uuid IS NULL OR b.hall_id = $2)
       AND ${inGroup(3)}
     GROUP BY b.event_date ORDER BY 1`, [first, q.hallId || null, q.group || null])
  res.json({ month: q.month, days: Object.fromEntries(r.rows.map((x) => [x.d, x.n])) })
})
calendarRouter.get('/day', requirePerm('bookings.view'), async (req, res) => {
  const q = parse(z.object({ date: isoDate, hallId: uuid.optional(), group: z.enum(['halls', 'outsource']).optional() }), req.query)
  const rows = (await query(
    `SELECT b.*, h.name AS hall_name, h.kind AS hall_kind, h.section_order, c.name AS c_name, c.phone AS c_phone
     FROM bookings b JOIN halls h ON h.id=b.hall_id JOIN customers c ON c.id=b.customer_id
     WHERE b.event_date = $1::date AND ($2::uuid IS NULL OR b.hall_id = $2) AND ${inGroup(3)} ORDER BY COALESCE(h.kind = 'outsource', false), h.section_order NULLS LAST, h.name, b.start_time`, [q.date, q.hallId || null, q.group || null])).rows
  const money = can(req.user, 'bookings.editFinancial')
  const ids = rows.map((r) => r.id)
  const charges = ids.length ? (await query('SELECT * FROM booking_charges WHERE booking_id = ANY($1)', [ids])).rows : []
  const pays = ids.length ? (await query(`SELECT p.*, COALESCE((SELECT json_agg(json_build_object('bucket', a.bucket, 'amount', a.amount)) FROM payment_allocations a WHERE a.payment_id=p.id), '[]') AS allocations FROM payments p WHERE p.booking_id = ANY($1)`, [ids])).rows : []
  const view = (b) => {
    const base = {
      id: b.id, reference: b.reference, status: b.status, customer: b.c_name, phone: b.c_phone, startTime: hhmm(b.start_time), endTime: hhmm(b.end_time),
      meals: b.meals, notes: b.notes,
    }
    if (!money) return base
    const t = bookingTotals(b, charges.filter((c) => c.booking_id === b.id), b.hall_name)
    const s = settlement(t, pays.filter((p) => p.booking_id === b.id))
    return { ...base, total: t.total / 100, balance: s.balance / 100, paid: s.paidTotal / 100 }
  }
  const sections = (await query(`SELECT id, name, kind FROM halls h WHERE (h.active OR EXISTS (SELECT 1 FROM bookings x WHERE x.hall_id = h.id AND x.event_date = $1::date)) AND ${inGroup(2)} ORDER BY COALESCE(kind = 'outsource', false), section_order NULLS LAST, lower(name)`, [q.date, q.group || null])).rows
    .filter((h) => !q.hallId || h.id === q.hallId)
    .map((h) => ({ id: h.id, name: h.name, kind: h.kind, bookings: rows.filter((b) => b.hall_id === h.id).map(view) }))
  res.json({ date: q.date, financial: money, sections, total: rows.filter((b) => b.status !== 'cancelled').length })
})

// ================= menu: dynamic categories + items (no prices, ever) =================
export const mealMenuRouter = Router()
const nameIn = z.object({ name: z.string().trim().min(1).max(80), active: z.boolean().default(true) })
const itemIn = z.object({ categoryId: uuid, name: z.string().trim().min(1).max(120), active: z.boolean().default(true) })
const orderIn = z.object({ ids: z.array(uuid).min(1).max(500) })
const itemView = (r) => ({ id: r.id, name: r.name, active: r.active, sort: r.sort })

mealMenuRouter.get('/', requirePerm('mealmenu.view'), async (req, res) => {
  const all = req.query.all === '1'
  const cats = (await query(`SELECT * FROM menu_categories ${all ? '' : 'WHERE active'} ORDER BY sort, lower(name)`)).rows
  const items = (await query(`SELECT * FROM meal_menu_items ${all ? '' : 'WHERE active'} ORDER BY sort, lower(name)`)).rows
  res.json({ categories: cats.map((c) => ({ id: c.id, name: c.name, active: c.active, sort: c.sort, items: items.filter((i) => i.category_id === c.id).map(itemView) })) })
})

const dupCat = (e) => { if (e.code === '23505') throw conflict('A category with that name already exists', 'DUPLICATE_CATEGORY'); throw e }
mealMenuRouter.post('/categories', requirePerm('mealmenu.manage'), async (req, res) => {
  const b = parse(nameIn, req.body)
  try {
    const row = await tx(async (c) => {
      const r = await c.query('INSERT INTO menu_categories (name, active, sort) VALUES ($1,$2,(SELECT COALESCE(max(sort),0)+1 FROM menu_categories)) RETURNING *', [b.name, b.active])
      await audit(c, ctxOf(req), { action: 'Menu Category Added', entityType: 'menu_category', entityId: r.rows[0].id, summary: b.name })
      return r.rows[0]
    })
    res.status(201).json({ category: { id: row.id, name: row.name, active: row.active, sort: row.sort, items: [] } })
  } catch (e) { dupCat(e) }
})
mealMenuRouter.put('/categories-order', requirePerm('mealmenu.manage'), async (req, res) => {
  const { ids } = parse(orderIn, req.body)
  await tx(async (c) => {
    for (const [i, id] of ids.entries()) await c.query('UPDATE menu_categories SET sort=$2, updated_at=now() WHERE id=$1', [id, i + 1])
    await audit(c, ctxOf(req), { action: 'Menu Categories Reordered', entityType: 'menu_category', entityId: 'all', summary: `${ids.length} categories` })
  })
  res.json({ ok: true })
})
mealMenuRouter.put('/categories/:id', requirePerm('mealmenu.manage'), async (req, res) => {
  const b = parse(nameIn, req.body)
  try {
    const row = await tx(async (c) => {
      const cur = (await c.query('SELECT * FROM menu_categories WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0]
      if (!cur) throw notFound('Category')
      const r = await c.query('UPDATE menu_categories SET name=$2, active=$3, updated_at=now() WHERE id=$1 RETURNING *', [cur.id, b.name, b.active])
      await audit(c, ctxOf(req), { action: 'Menu Category Edited', entityType: 'menu_category', entityId: cur.id, summary: `${cur.name} → ${b.name}${cur.active !== b.active ? (b.active ? ' (activated)' : ' (deactivated)') : ''}` })
      return r.rows[0]
    })
    res.json({ category: { id: row.id, name: row.name, active: row.active, sort: row.sort } })
  } catch (e) { dupCat(e) }
})
mealMenuRouter.delete('/categories/:id', requirePerm('mealmenu.manage'), async (req, res) => {
  // Items go with the category; saved bookings keep their own frozen copy of names and category.
  await tx(async (c) => {
    const r = await c.query('DELETE FROM menu_categories WHERE id=$1 RETURNING name', [req.params.id])
    if (!r.rowCount) throw notFound('Category')
    await audit(c, ctxOf(req), { action: 'Menu Category Deleted', entityType: 'menu_category', entityId: req.params.id, summary: r.rows[0].name })
  })
  res.json({ ok: true })
})

mealMenuRouter.post('/items', requirePerm('mealmenu.manage'), async (req, res) => {
  const b = parse(itemIn, req.body)
  const row = await tx(async (c) => {
    const cat = (await c.query('SELECT name FROM menu_categories WHERE id=$1', [b.categoryId])).rows[0]
    if (!cat) throw notFound('Category')
    const dup = await c.query('SELECT 1 FROM meal_menu_items WHERE category_id=$1 AND lower(name)=lower($2)', [b.categoryId, b.name])
    if (dup.rowCount) throw conflict(`${b.name} is already in ${cat.name}`, 'DUPLICATE_ITEM')
    const r = await c.query('INSERT INTO meal_menu_items (category_id, name, active, sort) VALUES ($1,$2,$3,(SELECT COALESCE(max(sort),0)+1 FROM meal_menu_items WHERE category_id=$1)) RETURNING *', [b.categoryId, b.name, b.active])
    await audit(c, ctxOf(req), { action: 'Menu Item Added', entityType: 'meal_menu', entityId: r.rows[0].id, summary: `${cat.name}: ${b.name}` })
    return r.rows[0]
  })
  res.status(201).json({ item: itemView(row) })
})
mealMenuRouter.put('/items-order', requirePerm('mealmenu.manage'), async (req, res) => {
  const { ids } = parse(orderIn, req.body)
  await tx(async (c) => {
    for (const [i, id] of ids.entries()) await c.query('UPDATE meal_menu_items SET sort=$2, updated_at=now() WHERE id=$1', [id, i + 1])
    await audit(c, ctxOf(req), { action: 'Menu Items Reordered', entityType: 'meal_menu', entityId: 'order', summary: `${ids.length} items` })
  })
  res.json({ ok: true })
})
mealMenuRouter.put('/items/:id', requirePerm('mealmenu.manage'), async (req, res) => {
  const b = parse(itemIn, req.body)
  const row = await tx(async (c) => {
    const cur = (await c.query('SELECT * FROM meal_menu_items WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0]
    if (!cur) throw notFound('Menu item')
    const dup = await c.query('SELECT 1 FROM meal_menu_items WHERE category_id=$1 AND lower(name)=lower($2) AND id<>$3', [b.categoryId, b.name, cur.id])
    if (dup.rowCount) throw conflict(`${b.name} is already in that category`, 'DUPLICATE_ITEM')
    const r = await c.query('UPDATE meal_menu_items SET category_id=$2, name=$3, active=$4, updated_at=now() WHERE id=$1 RETURNING *', [cur.id, b.categoryId, b.name, b.active])
    await audit(c, ctxOf(req), { action: 'Menu Item Edited', entityType: 'meal_menu', entityId: cur.id, summary: `${cur.name} → ${b.name}${cur.active !== b.active ? (b.active ? ' (activated)' : ' (deactivated)') : ''}` })
    return r.rows[0]
  })
  res.json({ item: itemView(row) })
})
mealMenuRouter.delete('/items/:id', requirePerm('mealmenu.manage'), async (req, res) => {
  await tx(async (c) => {
    const r = await c.query('DELETE FROM meal_menu_items WHERE id=$1 RETURNING name', [req.params.id])
    if (!r.rowCount) throw notFound('Menu item')
    await audit(c, ctxOf(req), { action: 'Menu Item Deleted', entityType: 'meal_menu', entityId: req.params.id, summary: r.rows[0].name })
  })
  res.json({ ok: true })
})

/** Kitchen sheet: the ONLY data the chef's print / PDF may use — where/when/which meals + category headings and item names.
 *  Never a customer name or phone, an amount, a payment or a note. */
async function kitchenOf(id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Booking')
  const r = (await query(
    `SELECT b.food_items, b.meals, b.event_date, b.start_time, b.end_time, h.name AS hall_name
     FROM bookings b JOIN halls h ON h.id=b.hall_id WHERE b.id=$1`, [id])).rows[0]
  if (!r) throw notFound('Booking')
  const groups = new Map()
  for (const x of r.food_items || []) {
    const key = x.categoryId || x.category || 'Other'
    if (!groups.has(key)) groups.set(key, { title: x.category || 'Other', sort: x.categorySort ?? 999, items: [] })
    groups.get(key).items.push({ name: x.name, sort: x.sort ?? 999 })
  }
  const cap = (m) => m.charAt(0).toUpperCase() + m.slice(1)
  return {
    section: r.hall_name, date: r.event_date, startTime: hhmm(r.start_time), endTime: hhmm(r.end_time), serve: (r.meals || []).map(cap),
    meals: [...groups.values()].sort((a, b) => a.sort - b.sort || a.title.localeCompare(b.title))
      .map((g) => ({ title: g.title, items: g.items.sort((a, b) => a.sort - b.sort).map((i) => i.name) })).filter((g) => g.items.length),
  }
}
mealMenuRouter.get('/booking/:id', requirePerm('bookings.view'), async (req, res) => {
  res.json(await kitchenOf(req.params.id))
})

const fonts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts')
mealMenuRouter.get('/booking/:id/pdf', requirePerm('bookings.view'), async (req, res) => {
  const k = await kitchenOf(req.params.id)
  const doc = new PDFDocument({ size: 'A4', margin: 56, info: { Title: 'Kitchen Sheet' } })
  doc.registerFont('R', path.join(fonts, 'FreeSans.ttf'))
  doc.registerFont('B', path.join(fonts, 'FreeSansBold.ttf'))
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="kitchen-sheet.pdf"`)
  doc.pipe(res)
  doc.font('B').fontSize(24).fillColor('#111827').text('Kitchen Sheet', { align: 'center' })
  doc.moveDown(0.4)
  const [y, m, d] = String(k.date).split('-')
  doc.font('B').fontSize(13).fillColor('#374151').text(`${k.section}  ·  ${d}-${m}-${y}  ·  ${k.startTime} – ${k.endTime}`, { align: 'center' })
  if (k.serve.length) doc.font('R').fontSize(12).fillColor('#6b7280').text(`Serve: ${k.serve.join(', ')}`, { align: 'center' })
  doc.moveDown(1.2)
  const bottom = () => doc.page.height - doc.page.margins.bottom
  if (!k.meals.length) doc.font('R').fontSize(12).fillColor('#6b7280').text('No menu items selected.', { align: 'center' })
  k.meals.forEach((g, i) => {
    if (i > 0 && doc.y + 60 > bottom()) doc.addPage()
    if (i > 0) doc.moveDown(1)
    doc.font('B').fontSize(17).fillColor('#e11d2e').text(g.title, { align: 'center' })
    doc.moveTo(doc.page.margins.left + 140, doc.y + 2).lineTo(doc.page.width - doc.page.margins.right - 140, doc.y + 2).strokeColor('#e5e7eb').stroke()
    doc.moveDown(0.6)
    for (const it of g.items) {
      if (doc.y + 24 > bottom()) doc.addPage()
      doc.font('R').fontSize(13).fillColor('#111827').text(it, { align: 'center' })
      doc.moveDown(0.25)
    }
  })
  doc.end()
})
