// Saved drafts of unsubmitted booking / catering forms, and per-item catering prices.
// Drafts live in their own table: they are never bookings, never in history, and never block a date.
import { Router } from 'express'
import { query, tx } from '../db/pool.js'
import { can, requirePerm } from '../lib/auth.js'
import { forbidden, notFound } from '../lib/errors.js'
import { money, parse, uuid, z } from '../lib/validate.js'
import { audit } from '../services/support.js'

const ctxOf = (req) => ({ user: req.user, ip: req.ip })
const PERM = { booking: 'bookings.create', catering: 'catering.create' }
const KINDS = Object.keys(PERM)

const draftIn = z.object({
  kind: z.enum(['booking', 'catering']),
  data: z.record(z.string(), z.any()),
  hallId: uuid.nullable().optional(),
  customerName: z.string().trim().max(150).default(''),
})
const view = (d) => ({
  id: d.id, kind: d.kind, category: d.category, hallId: d.hall_id, hallName: d.hall_name || null, title: d.title, customerName: d.customer_name,
  status: d.status, createdBy: d.created_by_name || null, createdAt: d.created_at, updatedAt: d.updated_at,
})
const SELECT = `SELECT d.*, h.name AS hall_name, u.name AS created_by_name FROM drafts d LEFT JOIN halls h ON h.id = d.hall_id LEFT JOIN users u ON u.id = d.created_by`

async function describe(db, b) {
  if (b.kind === 'catering') return { category: 'Catering', title: 'Catering order', hallId: null }
  const hall = b.hallId ? (await db.query('SELECT id, name, kind FROM halls WHERE id=$1', [b.hallId])).rows[0] : null
  return { category: hall ? (hall.kind === 'outsource' ? 'Outsource' : 'Hall') : 'Booking', title: hall ? `${hall.name} booking` : 'Hall booking', hallId: hall?.id || null }
}

export const draftsRouter = Router()
draftsRouter.get('/', async (req, res) => {
  const kinds = KINDS.filter((k) => can(req.user, PERM[k]))
  const r = kinds.length ? await query(`${SELECT} WHERE d.kind = ANY($1) ORDER BY d.updated_at DESC LIMIT 100`, [kinds]) : { rows: [] }
  res.json({ drafts: r.rows.map(view) })
})
draftsRouter.get('/:id', async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw notFound('Draft')
  const d = (await query(`${SELECT} WHERE d.id = $1`, [req.params.id])).rows[0]
  if (!d) throw notFound('Draft')
  if (!can(req.user, PERM[d.kind])) throw forbidden('You cannot open this kind of draft')
  res.json({ draft: view(d), data: d.data })
})
draftsRouter.post('/', async (req, res) => {
  const b = parse(draftIn, req.body)
  if (!can(req.user, PERM[b.kind])) throw forbidden('You cannot create this kind of draft')
  const row = await tx(async (c) => {
    const d = await describe(c, b)
    const r = await c.query(
      `INSERT INTO drafts (kind, category, hall_id, title, customer_name, data, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [b.kind, d.category, d.hallId, d.title, b.customerName, JSON.stringify(b.data), req.user.id])
    await audit(c, ctxOf(req), { action: 'Draft Saved', entityType: 'draft', entityId: r.rows[0].id, summary: `${d.category} draft${b.customerName ? ` — ${b.customerName}` : ''}` })
    return (await c.query(`${SELECT} WHERE d.id = $1`, [r.rows[0].id])).rows[0]
  })
  res.status(201).json({ draft: view(row) })
})
draftsRouter.put('/:id', async (req, res) => {
  const b = parse(draftIn, req.body)
  const row = await tx(async (c) => {
    const cur = (await c.query('SELECT * FROM drafts WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0]
    if (!cur) throw notFound('Draft')
    if (cur.kind !== b.kind || !can(req.user, PERM[cur.kind])) throw forbidden('You cannot change this draft')
    const d = await describe(c, b)
    await c.query('UPDATE drafts SET category=$2, hall_id=$3, title=$4, customer_name=$5, data=$6, updated_at=now() WHERE id=$1', [cur.id, d.category, d.hallId, d.title, b.customerName, JSON.stringify(b.data)])
    return (await c.query(`${SELECT} WHERE d.id = $1`, [cur.id])).rows[0]
  })
  res.json({ draft: view(row) })
})
draftsRouter.delete('/:id', async (req, res) => {
  await tx(async (c) => {
    const cur = (await c.query('SELECT * FROM drafts WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0]
    if (!cur) throw notFound('Draft')
    if (!can(req.user, PERM[cur.kind])) throw forbidden('You cannot delete this kind of draft')
    if (cur.created_by !== req.user.id && !can(req.user, 'bookings.editFinancial')) throw forbidden('Only the person who saved a draft, or a manager, can delete it')
    await c.query('DELETE FROM drafts WHERE id=$1', [cur.id])
    await audit(c, ctxOf(req), { action: 'Draft Deleted', entityType: 'draft', entityId: cur.id, summary: `${cur.category} draft${cur.customer_name ? ` — ${cur.customer_name}` : ''}` })
  })
  res.json({ ok: true })
})

/** Called inside the same transaction that creates the real booking / order: the draft it came from disappears with it. */
export async function consumeDraft(db, ctx, draftId, kind) {
  if (!draftId || !/^[0-9a-f-]{36}$/i.test(String(draftId))) return
  const r = await db.query('DELETE FROM drafts WHERE id=$1 AND kind=$2 RETURNING category, customer_name', [draftId, kind])
  if (r.rowCount) await audit(db, ctx, { action: 'Draft Submitted', entityType: 'draft', entityId: draftId, summary: `${r.rows[0].category} draft became a real ${kind}` })
}

// ================= catering prices (one price per Catering Menu item) =================
export const cateringPricesRouter = Router()
cateringPricesRouter.get('/', requirePerm('menu.view'), async (_req, res) => {
  const r = await query('SELECT meal_item_id, unit, unit_price FROM catering_prices')
  res.json({ prices: Object.fromEntries(r.rows.map((p) => [p.meal_item_id, { unit: p.unit, unitPrice: Number(p.unit_price) }])) })
})
cateringPricesRouter.put('/:itemId', requirePerm('menu.manage'), async (req, res) => {
  const b = parse(z.object({ unit: z.enum(['plate', 'kg', 'litre', 'piece', 'tray', 'packet']), unitPrice: money }), req.body)
  await tx(async (c) => {
    const it = (await c.query('SELECT name FROM meal_menu_items WHERE id=$1', [req.params.itemId])).rows[0]
    if (!it) throw notFound('Menu item')
    await c.query(
      `INSERT INTO catering_prices (meal_item_id, unit, unit_price, updated_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (meal_item_id) DO UPDATE SET unit=$2, unit_price=$3, updated_by=$4, updated_at=now()`, [req.params.itemId, b.unit, b.unitPrice, req.user.id])
    await audit(c, ctxOf(req), { action: 'Catering Price Set', entityType: 'catering_price', entityId: req.params.itemId, summary: `${it.name}: ${b.unitPrice} per ${b.unit}` })
  })
  res.json({ ok: true })
})
