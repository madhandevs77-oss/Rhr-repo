import crypto from 'node:crypto'
import { Router } from 'express'
import { config } from '../config.js'
import { query, tx } from '../db/pool.js'
import { requirePerm } from '../lib/auth.js'
import { AppError, badRequest, notFound } from '../lib/errors.js'
import { parse, z } from '../lib/validate.js'
import { providerStatus } from '../providers/index.js'
import { listBookings } from '../services/bookings.js'
import { listOrders } from '../services/catering.js'
import { importLegacy } from '../services/legacyImport.js'
import { applyReceipt, eventView, retryEvent, runWorkerOnce, safeEqual, twilioSignature } from '../services/notifications.js'
import { recordPayment } from '../services/payments.js'
import { audit, getSettings, todayIST } from '../services/support.js'

const ctxOf = (req) => ({ user: req.user, ip: req.ip })

// ================= settings =================
export const settingsRouter = Router()
const SCHEMAS = {
  business: z.object({ name: z.string().trim().min(1).max(120), legalName: z.string().trim().max(150).default(''), phone: z.string().trim().max(30), email: z.string().trim().max(120).default(''), address: z.string().trim().max(400),
    taxId: z.string().trim().max(40).default(''), invoiceFooter: z.string().trim().max(300).default(''), terms: z.string().trim().max(2000).default(''), bankDetails: z.string().trim().max(500).default('') }),
  finance: z.object({ currency: z.literal('INR').default('INR'), taxLabel: z.string().trim().min(1).max(20), defaultTaxRate: z.coerce.number().min(0).max(100), invoicePrefix: z.string().trim().regex(/^[A-Z0-9]{1,8}$/, 'Prefix: 1-8 capital letters/digits'),
    quotationPrefix: z.string().trim().regex(/^[A-Z0-9]{1,8}$/), advanceMinPercent: z.coerce.number().min(0).max(100), quotationValidDays: z.coerce.number().int().min(1).max(90) }),
  notifications: z.object({ enabled: z.boolean(), smsProvider: z.enum(['mock', 'twilio']), whatsappProvider: z.enum(['mock', 'twilio', 'meta']), defaultChannel: z.enum(['sms', 'whatsapp']), maxAttempts: z.coerce.number().int().min(1).max(10), notifyOnSignificantChange: z.boolean(),
    emailProvider: z.enum(['mock', 'smtp']).default('mock'), sendBill: z.boolean().default(true), sendThankYou: z.boolean().default(true), thankYouDelayHours: z.coerce.number().int().min(0).max(72).default(2) }),
}
settingsRouter.get('/', async (req, res) => {
  const all = await getSettings({ query })
  const manager = ['admin', 'manager'].includes(req.user.role)
  res.json({
    business: manager ? all.business : { name: all.business.name, phone: all.business.phone, address: all.business.address },
    finance: manager ? all.finance : { currency: all.finance.currency, taxLabel: all.finance.taxLabel, defaultTaxRate: all.finance.defaultTaxRate },
    ...(manager ? { notifications: all.notifications } : {}),
  })
})
settingsRouter.put('/:key', requirePerm('settings.edit'), async (req, res) => {
  const schema = SCHEMAS[req.params.key]
  if (!schema) throw notFound('Setting')
  const v = parse(schema, req.body)
  await tx(async (c) => {
    await c.query(`INSERT INTO settings (key, value, updated_by) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now(), updated_by=EXCLUDED.updated_by`, [req.params.key, JSON.stringify(v), req.user.id])
    await audit(c, ctxOf(req), { action: 'Settings Updated', entityType: 'settings', entityId: req.params.key, summary: req.params.key, details: v })
  })
  res.json({ [req.params.key]: v })
})
settingsRouter.get('/providers/status', requirePerm('notifications.config'), (_req, res) => res.json({ providers: providerStatus() }))

// ================= templates =================
export const templatesRouter = Router()
const ALLOWED_VARS = {
  booking_confirmation: ['customer_name', 'booking_reference', 'hall_name', 'event_type', 'event_date', 'start_time', 'end_time', 'total_amount', 'advance_amount', 'remaining_balance', 'restaurant_phone'],
  booking_changed: ['customer_name', 'booking_reference', 'hall_name', 'event_type', 'event_date', 'start_time', 'end_time', 'total_amount', 'advance_amount', 'remaining_balance', 'restaurant_phone'],
  bill_ready: ['customer_name', 'reference', 'invoice_number', 'invoice_date', 'total_amount', 'event_date', 'event_type', 'restaurant_phone', 'restaurant_name', 'bill_note'],
  thank_you: ['customer_name', 'reference', 'event_type', 'event_date', 'restaurant_phone', 'restaurant_name'],
  catering_confirmation: ['customer_name', 'order_reference', 'event_date', 'delivery_time', 'plates', 'total_amount', 'advance_amount', 'remaining_balance', 'restaurant_phone'],
}
templatesRouter.get('/', requirePerm('notifications.config'), async (_req, res) => {
  const r = await query('SELECT * FROM notification_templates ORDER BY key, channel, language')
  res.json({ templates: r.rows.map((t) => ({ id: t.id, key: t.key, channel: t.channel, language: t.language, subject: t.subject, body: t.body, providerTemplateName: t.provider_template_name, active: t.active, variables: ALLOWED_VARS[t.key] || [] })) })
})
templatesRouter.put('/:id', requirePerm('notifications.config'), async (req, res) => {
  const b = parse(z.object({ subject: z.string().trim().max(200).nullable().optional(), body: z.string().trim().min(10).max(1500), providerTemplateName: z.string().trim().max(100).nullable().optional(), active: z.boolean().optional() }), req.body)
  const cur = (await query('SELECT * FROM notification_templates WHERE id=$1', [req.params.id])).rows[0]
  if (!cur) throw notFound('Template')
  if (cur.channel === 'email' && !(b.subject ?? cur.subject)) throw badRequest('An email needs a subject line')
  const used = [...`${b.body} ${b.subject || ''}`.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1])
  const bad = used.filter((v) => !(ALLOWED_VARS[cur.key] || []).includes(v))
  if (bad.length) throw badRequest(`Unknown placeholder(s): ${[...new Set(bad)].map((v) => `{{${v}}}`).join(', ')}`)
  if (/\b(card|cvv|upi\s*id|account\s*number)\b/i.test(b.body)) throw badRequest('Messages must not include payment instrument details')
  await query('UPDATE notification_templates SET body=$2, provider_template_name=$3, active=COALESCE($4,active), subject=$5, updated_at=now() WHERE id=$1', [cur.id, b.body, b.providerTemplateName ?? cur.provider_template_name, b.active ?? null, cur.channel === 'email' ? (b.subject ?? cur.subject) : null])
  await audit({ query }, ctxOf(req), { action: 'Template Updated', entityType: 'template', entityId: cur.id, summary: `${cur.key}/${cur.channel}/${cur.language}` })
  res.json({ ok: true })
})

// ================= notifications =================
export const notificationsRouter = Router()
notificationsRouter.get('/', requirePerm('notifications.view'), async (req, res) => {
  const p = []
  const w = []
  if (req.query.status) { p.push(String(req.query.status)); w.push(`e.status=$${p.length}`) }
  if (req.query.bookingId) { p.push(String(req.query.bookingId)); w.push(`e.booking_id=$${p.length}`) }
  const r = await query(
    `SELECT e.*, c.name AS customer_name, b.reference AS booking_ref, o.reference AS order_ref FROM notification_events e JOIN customers c ON c.id=e.customer_id
       LEFT JOIN bookings b ON b.id=e.booking_id LEFT JOIN catering_orders o ON o.id=e.catering_order_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY e.created_at DESC LIMIT 300`, p)
  res.json({ notifications: r.rows.map((e) => ({ ...eventView(e), customer: e.customer_name, reference: e.booking_ref || e.order_ref })) })
})
notificationsRouter.get('/:id/attempts', requirePerm('notifications.view'), async (req, res) => {
  const r = await query('SELECT * FROM notification_attempts WHERE event_id=$1 ORDER BY attempt_no', [req.params.id])
  res.json({ attempts: r.rows.map((a) => ({ attemptNo: a.attempt_no, at: a.started_at, outcome: a.outcome, errorCode: a.error_code, error: a.error_message })) })
})
notificationsRouter.post('/:id/retry', requirePerm('notifications.retry'), async (req, res) => {
  const ev = await tx((c) => retryEvent(c, ctxOf(req), req.params.id))
  res.json({ notification: eventView(ev) })
})
notificationsRouter.post('/run', requirePerm('notifications.config'), async (_req, res) => {
  res.json({ results: await runWorkerOnce() })
})

// ================= provider webhooks (verified by signature, not by session) =================
export const webhooksRouter = Router()
webhooksRouter.post('/twilio', async (req, res) => {
  const { authToken, webhookUrl } = config.twilio
  if (!authToken) throw new AppError(503, 'NOT_CONFIGURED', 'Twilio is not configured')
  const url = webhookUrl || `${req.protocol}://${req.get('host')}${req.originalUrl}`
  if (!safeEqual(req.get('x-twilio-signature') || '', twilioSignature(authToken, url, req.body || {}))) throw new AppError(403, 'BAD_SIGNATURE', 'Invalid signature')
  const r = await applyReceipt({ provider: 'twilio', messageId: req.body.MessageSid, status: req.body.MessageStatus, errorCode: req.body.ErrorCode })
  res.json({ ok: true, ...r })
})
webhooksRouter.get('/whatsapp', (req, res) => {
  if (config.metaWhatsapp.verifyToken && req.query['hub.mode'] === 'subscribe' && safeEqual(req.query['hub.verify_token'] || '', config.metaWhatsapp.verifyToken)) return res.status(200).send(String(req.query['hub.challenge']))
  res.sendStatus(403)
})
webhooksRouter.post('/whatsapp', async (req, res) => {
  const secret = config.metaWhatsapp.appSecret
  if (!secret) throw new AppError(503, 'NOT_CONFIGURED', 'WhatsApp is not configured')
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody || Buffer.alloc(0)).digest('hex')
  if (!safeEqual(req.get('x-hub-signature-256') || '', sig)) throw new AppError(403, 'BAD_SIGNATURE', 'Invalid signature')
  for (const entry of req.body?.entry || []) for (const ch of entry.changes || []) for (const s of ch.value?.statuses || []) {
    await applyReceipt({ provider: 'meta-whatsapp', messageId: s.id, status: s.status, errorCode: s.errors?.[0]?.code })
  }
  res.json({ ok: true })
})

// ================= payment gateway integration interface =================
// A future gateway posts server-to-server events here, signed with PAYMENT_WEBHOOK_SECRET (HMAC-SHA256 of the raw body).
// Only `payment.succeeded` creates money; failures/pending events never touch balances. Idempotent per (provider, eventId).
export const integrationsRouter = Router()
integrationsRouter.post('/payment-events', async (req, res) => {
  const secret = config.paymentWebhookSecret
  if (!secret) throw notFound('Integration')
  const expect = crypto.createHmac('sha256', secret).update(req.rawBody || Buffer.alloc(0)).digest('hex')
  if (!safeEqual(req.get('x-signature') || '', expect)) throw new AppError(403, 'BAD_SIGNATURE', 'Invalid signature')
  const e = parse(z.object({
    provider: z.string().min(2).max(40), eventId: z.string().min(3).max(120), type: z.string().max(60),
    target: z.object({ type: z.enum(['booking', 'catering']), id: z.string().uuid() }),
    amount: z.union([z.number(), z.string()]), method: z.enum(['UPI', 'Card', 'Bank Transfer', 'Other']).default('Other'), paidOn: z.string().optional(), reference: z.string().max(100).default(''),
  }), req.body)
  if (e.type !== 'payment.succeeded') return res.json({ ignored: true, reason: `event type ${e.type} does not create money` })
  const out = await tx((c) => recordPayment(c, { system: true, user: null, ip: req.ip }, e.target.type, e.target.id, {
    amount: e.amount, method: e.method, paidOn: e.paidOn || todayIST(), reference: e.reference, stage: 'part', source: 'gateway', provider: e.provider, externalRef: e.eventId,
  }))
  res.json({ ok: true, duplicate: out.duplicate, paymentId: out.payment.id })
})

// ================= reports =================
export const reportsRouter = Router()
reportsRouter.get('/summary', requirePerm('reports.view'), async (req, res) => {
  const { month } = parse(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).default(todayIST().slice(0, 7)) }), req.query)
  const [y, m] = month.split('-').map(Number)
  const from = `${month}-01`
  const to = `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`
  const bookings = await listBookings({ query }, { from, to })
  const orders = await listOrders({ query }, { from, to })
  const live = bookings.filter((b) => b.status !== 'cancelled')
  const sum = (arr, f) => Math.round(arr.reduce((s, x) => s + f(x), 0) * 100) / 100
  const byHall = {}, byType = {}
  live.forEach((b) => { byHall[b.hallName] = (byHall[b.hallName] || 0) + 1; byType[b.eventType] = (byType[b.eventType] || 0) + 1 })
  const liveOrders = orders.filter((o) => o.status !== 'cancelled')
  const withVendor = liveOrders.filter((o) => o.vendor && o.vendor.finalCost !== null)
  const vendorCost = sum(withVendor, (o) => o.vendor.finalCost)
  const revenueWithVendor = sum(withVendor, (o) => o.money.total)
  res.json({
    month,
    halls: { count: live.length, cancelled: bookings.length - live.length, billed: sum(live, (b) => b.money.total), collected: sum(live, (b) => b.money.paid), outstanding: sum(live, (b) => Math.max(0, b.money.balance)), awaitingVerification: sum(live, (b) => b.money.pending), byHall, byType,
      foodConfirmed: live.filter((b) => b.foodStatus === 'confirmed').length, foodPending: live.filter((b) => b.foodStatus !== 'confirmed').length },
    catering: { count: liveOrders.length, cancelled: orders.length - liveOrders.length, billed: sum(liveOrders, (o) => o.money.total), collected: sum(liveOrders, (o) => o.money.paid), outstanding: sum(liveOrders, (o) => Math.max(0, o.money.balance)),
      byStatus: liveOrders.reduce((a, o) => ((a[o.status] = (a[o.status] || 0) + 1), a), {}), plates: sum(liveOrders, (o) => o.plates),
      vendor: { ordersWithFinalCost: withVendor.length, cost: vendorCost, revenue: revenueWithVendor, margin: Math.round((revenueWithVendor - vendorCost) * 100) / 100 } },
  })
})

// ================= audit =================
export const auditRouter = Router()
auditRouter.get('/', requirePerm('audit.view'), async (req, res) => {
  const p = [], w = []
  if (req.query.entityType) { p.push(String(req.query.entityType)); w.push(`entity_type=$${p.length}`) }
  if (req.query.entityId) { p.push(String(req.query.entityId)); w.push(`entity_id=$${p.length}`) }
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100))
  const r = await query(`SELECT * FROM audit_events ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY at DESC, id DESC LIMIT ${limit}`, p)
  res.json({ events: r.rows.map((a) => ({ id: a.id, at: a.at, user: a.user_name, action: a.action, entityType: a.entity_type, entityId: a.entity_id, summary: a.summary, details: a.details })) })
})

// ================= data admin: export + legacy import =================
export const dataRouter = Router()
const EXPORT_TABLES = ['halls', 'hall_images', 'hall_blackouts', 'customers', 'bookings', 'booking_charges', 'booking_changes', 'menu_items', 'menu_categories', 'meal_menu_items', 'catering_prices', 'drafts', 'vendors', 'catering_service_options', 'catering_orders', 'catering_order_items', 'catering_order_versions',
  'catering_quotations', 'vendor_assignments', 'payments', 'payment_allocations', 'payment_splits', 'invoices', 'notification_templates', 'notification_events', 'notification_attempts', 'settings', 'audit_events']
dataRouter.get('/export', requirePerm('data.admin'), async (req, res) => {
  const out = { app: 'rhr-server', version: 1, exportedAt: new Date().toISOString(), tables: {} }
  for (const t of EXPORT_TABLES) out.tables[t] = (await query(`SELECT * FROM ${t}`)).rows
  out.tables.users = (await query('SELECT id, username, name, role, active, created_at FROM users')).rows
  await audit({ query }, ctxOf(req), { action: 'Data Exported', entityType: 'system', summary: 'JSON export downloaded' })
  res.setHeader('Content-Disposition', `attachment; filename="rhr-export-${todayIST()}.json"`)
  res.json(out)
})
dataRouter.post('/import-legacy', requirePerm('data.admin'), async (req, res) => {
  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true'
  try {
    const report = await tx((c) => importLegacy(c, ctxOf(req), req.body, { dryRun }))
    res.json({ report })
  } catch (e) {
    if (e.dryRunReport) return res.json({ report: e.dryRunReport })
    throw e
  }
})

export const healthHandler = async (_req, res) => {
  const r = await query('SELECT 1 AS ok')
  res.json({ ok: r.rows[0].ok === 1, time: new Date().toISOString() })
}
