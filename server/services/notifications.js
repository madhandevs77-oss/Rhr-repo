import crypto from 'node:crypto'
import { config } from '../config.js'
import { query, tx } from '../db/pool.js'
import { conflict, notFound } from '../lib/errors.js'
import { inr, toPaise } from '../lib/money.js'
import { ProviderError, providerFor } from '../providers/index.js'
import { renderPdf } from './pdf.js'
import { audit, getSetting } from './support.js'

export const BACKOFF_SEC = [30, 120, 600, 3600, 21600]
const fmtDate = (s) => (s ? new Date(s + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '')
export const fmtTime12 = (t) => {
  if (!t) return ''
  const [h, m] = t.split(':')
  return `${+h % 12 || 12}:${m} ${+h >= 12 ? 'PM' : 'AM'}`
}
export const e164 = (p10) => `+91${p10}`

export const pdfBuffer = (snapshot) => new Promise((resolve, reject) => {
  const chunks = []
  const doc = renderPdf(snapshot, { kind: 'invoice' })
  doc.on('data', (c) => chunks.push(c))
  doc.on('end', () => resolve(Buffer.concat(chunks)))
  doc.on('error', reject)
})
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
export const emailHtml = (text) => `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111827;max-width:560px">${esc(text).replace(/\n/g, '<br>')}</div>`

export function render(template, vars) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k]))).replace(/[ \t]+-[ \t]*$/gm, '') // a line left ending in " -" (no end time) is tidied
}

export function bookingVars(row, customer, st, business) {
  return {
    customer_name: customer.name, booking_reference: row.reference, hall_name: row.hall_name, event_type: row.event_type,
    event_date: row.event_date ? fmtDate(row.event_date) : 'To be confirmed', start_time: row.start_time ? fmtTime12(row.start_time) : 'To be confirmed',
    end_time: row.end_time ? fmtTime12(row.end_time) + (row.ends_next_day ? ' (next day)' : '') : '',
    total_amount: inr(st.totals.total), advance_amount: inr(st.settle.paidTotal), remaining_balance: inr(Math.max(0, st.settle.balance)),
    restaurant_phone: business.phone || '',
  }
}

/**
 * Queue a message. Safe to call many times for the same event: the UNIQUE idempotency key means the
 * second call is a no-op and returns the first event. Never contains card/UPI/bank details.
 */
export async function enqueue(db, ctx, { key, type, templateKey, customer, vars, bookingId = null, cateringOrderId = null, channel: forced = null, invoiceId = null }) {
  const existing = await db.query('SELECT * FROM notification_events WHERE idempotency_key=$1', [key])
  if (existing.rows[0]) return { event: existing.rows[0], created: false }
  if (forced === 'email' && !customer.email) return { event: null, created: false, skipped: 'no_email' } // nothing to send to; no row
  const settings = await getSetting(db, 'notifications')
  const channel = forced || (settings.defaultChannel === 'whatsapp' ? 'whatsapp' : 'sms')
  const language = customer.language === 'ta' ? 'ta' : 'en'
  const tpl = (await db.query(
    `SELECT * FROM notification_templates WHERE key=$1 AND channel=$2 AND active AND language IN ($3,'en') ORDER BY (language=$3) DESC LIMIT 1`,
    [templateKey, channel, language],
  )).rows[0]
  const body = tpl ? render(tpl.body, vars) : ''
  const subject = tpl?.subject ? render(tpl.subject, vars) : null
  let status = 'queued'
  let skipped = null
  if (!tpl) { status = 'skipped'; skipped = 'no_template' }
  else if (settings.enabled === false) { status = 'skipped'; skipped = 'notifications_disabled' }
  else if (!customer.message_consent) { status = 'skipped'; skipped = 'no_consent' }
  const toEmail = channel === 'email' ? (customer.email || null) : null
  const toPhone = channel === 'email' ? null : e164(customer.phone)
  const r = await db.query(
    `INSERT INTO notification_events (idempotency_key, type, booking_id, catering_order_id, customer_id, channel, to_phone, to_email, subject, invoice_id, language, template_key, body, variables, status, skipped_reason, max_attempts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
    [key, type, bookingId, cateringOrderId, customer.id, channel, toPhone, toEmail, subject, invoiceId, tpl?.language || language, templateKey, body, JSON.stringify(vars), status, skipped, settings.maxAttempts || 5],
  )
  if (!r.rows[0]) return { event: (await db.query('SELECT * FROM notification_events WHERE idempotency_key=$1', [key])).rows[0], created: false }
  await audit(db, ctx, { action: status === 'queued' ? 'Notification Queued' : 'Notification Skipped', entityType: bookingId ? 'booking' : 'catering', entityId: bookingId || cateringOrderId, summary: `${templateKey} via ${channel}${skipped ? ` (${skipped})` : ''}` })
  return { event: r.rows[0], created: true }
}

const maskEmail = (m) => (m ? m.replace(/^(.{1,2})[^@]*(@.).*(\.[^.]+)$/, '$1•••$2•••$3') : null)
export const eventView = (e) => ({
  id: e.id, type: e.type, bookingId: e.booking_id, cateringOrderId: e.catering_order_id, channel: e.channel,
  toPhone: e.to_phone ? e.to_phone.replace(/^(\+91)(\d{2})\d{6}(\d{2})$/, '$1$2••••••$3') : null, toEmail: maskEmail(e.to_email), subject: e.subject, invoiceId: e.invoice_id,
  status: e.status, attempts: e.attempts, maxAttempts: e.max_attempts, lastError: e.last_error, skippedReason: e.skipped_reason, provider: e.provider,
  createdAt: e.created_at, sentAt: e.sent_at, deliveredAt: e.delivered_at, nextAttemptAt: e.next_attempt_at, language: e.language, body: e.body,
  templateKey: e.template_key,
})

// ---------------- worker ----------------
/** Claim due events with SKIP LOCKED so several app instances can run workers safely. */
async function claimDue(limit) {
  return tx(async (c) => {
    // a worker that died mid-send leaves the row 'sending' with an expired lock. We cannot know whether the
    // provider accepted the message, so we do NOT auto-resend (that could duplicate): flag it for staff.
    await c.query(
      `UPDATE notification_events SET status='failed', last_error='Worker interrupted while sending; delivery uncertain. Check with the customer before retrying.', updated_at=now()
       WHERE status='sending' AND locked_until < now()`,
    )
    const r = await c.query(
      `UPDATE notification_events SET status='sending', locked_until = now() + interval '2 minutes', attempts = attempts + 1, updated_at = now()
       WHERE id IN (SELECT id FROM notification_events WHERE status='queued' AND next_attempt_at <= now()
                    ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING *`,
      [limit],
    )
    return r.rows
  })
}

export async function processEvent(ev, { providerOverride } = {}) {
  const settings = await getSetting({ query }, 'notifications')
  const provider = providerOverride || providerFor(ev.channel, settings)
  const tpl = (await query('SELECT provider_template_name FROM notification_templates WHERE key=$1 AND channel=$2 AND language=$3', [ev.template_key, ev.channel, ev.language])).rows[0]
  const started = new Date()
  try {
    if (!provider.isConfigured()) throw new ProviderError(`Provider "${provider.name}" is not configured (missing environment variables)`, { retryable: false, code: 'NOT_CONFIGURED' })
    let out
    if (ev.channel === 'email') {
      const attachments = []
      if (ev.invoice_id) {
        const inv = (await query('SELECT invoice_number, snapshot FROM invoices WHERE id=$1', [ev.invoice_id])).rows[0]
        if (!inv) throw new ProviderError('The invoice for this email no longer exists', { retryable: false, code: 'ATTACHMENT_MISSING' })
        attachments.push({ filename: `${inv.invoice_number.replace(/[^\w.-]+/g, '_')}.pdf`, content: await pdfBuffer(inv.snapshot), contentType: 'application/pdf' })
      }
      out = await provider.send({ to: ev.to_email, subject: ev.subject || 'Message from RHR Veg Restaurant', body: ev.body, html: emailHtml(ev.body), channel: 'email', attachments })
    } else {
      out = await provider.send({ to: ev.to_phone, body: ev.body, channel: ev.channel, templateName: tpl?.provider_template_name || null, templateKey: ev.template_key, language: ev.language, variables: ev.variables })
    }
    await tx(async (c) => {
      await c.query(`INSERT INTO notification_attempts (event_id, attempt_no, started_at, finished_at, outcome, provider_status) VALUES ($1,$2,$3,now(),'sent','accepted')`, [ev.id, ev.attempts, started])
      await c.query(`UPDATE notification_events SET status = CASE WHEN status='delivered' THEN status ELSE 'sent' END, provider=$2, provider_message_id=$3, sent_at=now(), last_error=NULL, locked_until=NULL, updated_at=now() WHERE id=$1`, [ev.id, provider.name, out.providerMessageId])
    })
    return 'sent'
  } catch (e) {
    const pe = e instanceof ProviderError ? e : new ProviderError(e.message, { retryable: true, code: 'UNEXPECTED' })
    const exhausted = pe.retryable && ev.attempts >= ev.max_attempts
    const outcome = pe.rateLimited ? 'rate_limited' : pe.retryable ? 'retryable_error' : 'permanent_error'
    const nextStatus = !pe.retryable ? 'failed' : exhausted ? 'dead' : 'queued'
    const delay = Math.max(pe.retryAfterSec || 0, BACKOFF_SEC[Math.min(ev.attempts - 1, BACKOFF_SEC.length - 1)])
    await tx(async (c) => {
      await c.query(`INSERT INTO notification_attempts (event_id, attempt_no, started_at, finished_at, outcome, error_code, error_message) VALUES ($1,$2,$3,now(),$4,$5,$6)`, [ev.id, ev.attempts, started, outcome, pe.code, pe.message.slice(0, 500)])
      await c.query(
        `UPDATE notification_events SET status=$2, provider=$3, last_error=$4, locked_until=NULL, next_attempt_at = now() + ($5 || ' seconds')::interval, updated_at=now() WHERE id=$1`,
        [ev.id, nextStatus, provider.name, `${pe.code}: ${pe.message}`.slice(0, 500), String(delay)],
      )
    })
    return nextStatus
  }
}

export async function runWorkerOnce({ limit = 20, providerOverride } = {}) {
  const claimed = await claimDue(limit)
  const results = []
  for (const ev of claimed) results.push({ id: ev.id, result: await processEvent(ev, { providerOverride }) })
  return results
}

// ---------------- bill + thank-you messages ----------------
const fmtLong = (d) => (d ? fmtDate(String(d).slice(0, 10)) : '')

/** The customer and event facts behind a booking or catering order (used to build bill / thank-you messages). */
async function docParty(db, kind, id) {
  const sql = kind === 'booking'
    ? `SELECT d.id AS doc_id, d.reference, d.event_type, d.event_date, d.status, c.id AS cid, c.name, c.phone, c.email, c.language, c.message_consent
         FROM bookings d JOIN customers c ON c.id=d.customer_id WHERE d.id=$1`
    : `SELECT d.id AS doc_id, d.reference, d.event_type, d.event_date, d.status, c.id AS cid, c.name, c.phone, c.email, c.language, c.message_consent
         FROM catering_orders d JOIN customers c ON c.id=d.customer_id WHERE d.id=$1`
  const r = (await db.query(sql, [id])).rows[0]
  if (!r) throw notFound(kind === 'booking' ? 'Booking' : 'Catering order')
  return { row: r, customer: { id: r.cid, name: r.name, phone: r.phone, email: r.email, language: r.language, message_consent: r.message_consent } }
}
async function targetChannels(db, customer, { only } = {}) {
  const settings = await getSetting(db, 'notifications')
  const phoneCh = settings.defaultChannel === 'whatsapp' ? 'whatsapp' : 'sms'
  let chans = [phoneCh]
  if (customer.email) chans.push('email')
  if (only?.length) chans = chans.filter((c) => only.includes(c) || (c !== 'email' && only.includes('phone')))
  return chans
}
const nextRun = async (db, prefix) => (await db.query(`SELECT count(*)::int n FROM notification_events WHERE idempotency_key LIKE $1`, [prefix + '%'])).rows[0].n

/**
 * "Your bill is ready": SMS/WhatsApp text + an email with the invoice PDF attached.
 * auto=true  -> once per document, only for the FIRST invoice (a later corrected invoice is sent by staff, deliberately).
 * auto=false -> staff pressed "Send to customer": a fresh send each time, but never two in flight for the same channel.
 */
export async function enqueueBill(db, ctx, invoice, { auto = true, channels } = {}) {
  const settings = await getSetting(db, 'notifications')
  if (auto && settings.sendBill === false) return []
  const kind = invoice.booking_id ? 'booking' : 'catering'
  const { row, customer } = await docParty(db, kind, invoice.booking_id || invoice.catering_order_id)
  const biz = await getSetting(db, 'business')
  const chans = await targetChannels(db, customer, { only: channels })
  if (channels?.includes('email') && !customer.email) throw conflict('This customer has no email address on file. Add it to the customer first.', 'NO_EMAIL')
  const hasEmail = chans.includes('email')
  const out = []
  for (const ch of chans) {
    let key = `bill:${invoice.id}:${ch}`
    if (!auto) {
      const inflight = await db.query(`SELECT 1 FROM notification_events WHERE invoice_id=$1 AND channel=$2 AND type='bill_ready' AND status IN ('queued','sending')`, [invoice.id, ch])
      if (inflight.rowCount) throw conflict('This bill is already being sent. Wait a moment and check the message list.', 'ALREADY_SENDING')
      key += `:m${await nextRun(db, `bill:${invoice.id}:${ch}`)}`
    }
    const vars = {
      customer_name: customer.name, reference: row.reference, invoice_number: invoice.invoice_number, invoice_date: fmtLong(invoice.issued_at?.toISOString?.() || invoice.issued_at),
      total_amount: inr(toPaise(invoice.total)), event_date: fmtLong(row.event_date), event_type: row.event_type, restaurant_phone: biz.phone || '', restaurant_name: biz.name || 'RHR Veg Restaurant',
      bill_note: hasEmail ? 'A copy of your invoice (PDF) has also been sent to your email.' : 'A printed copy of your invoice is available at the restaurant on request.',
    }
    const r = await enqueue(db, ctx, { key, type: 'bill_ready', templateKey: 'bill_ready', customer, vars, bookingId: invoice.booking_id, cateringOrderId: invoice.catering_order_id, channel: ch, invoiceId: invoice.id })
    if (r.event) out.push(r.event)
  }
  return out
}

/** "Thank you" after the event. auto: once per booking/order (idempotent). manual: staff re-send. */
export async function enqueueThanks(db, ctx, kind, id, { auto = true, channels } = {}) {
  const settings = await getSetting(db, 'notifications')
  if (auto && settings.sendThankYou === false) return []
  const { row, customer } = await docParty(db, kind, id)
  const okStatus = kind === 'booking' ? ['confirmed', 'completed'] : ['delivered', 'completed']
  if (!okStatus.includes(row.status)) {
    if (auto) return []
    throw conflict(kind === 'booking' ? 'A thank-you can only be sent for a confirmed booking.' : 'A thank-you can only be sent once the order is delivered.', 'BAD_STATE')
  }
  if (!auto && kind === 'booking' && row.event_date && String(row.event_date).slice(0, 10) > todayIST()) throw conflict('The event has not taken place yet.', 'TOO_EARLY')
  if (channels?.includes('email') && !customer.email) throw conflict('This customer has no email address on file.', 'NO_EMAIL')
  const biz = await getSetting(db, 'business')
  const out = []
  for (const ch of await targetChannels(db, customer, { only: channels })) {
    let key = `thanks:${kind}:${id}:${ch}`
    if (!auto) {
      const inflight = await db.query(`SELECT 1 FROM notification_events WHERE ${kind === 'booking' ? 'booking_id' : 'catering_order_id'}=$1 AND channel=$2 AND type='thank_you' AND status IN ('queued','sending')`, [id, ch])
      if (inflight.rowCount) throw conflict('A thank-you message is already being sent.', 'ALREADY_SENDING')
      key += `:m${await nextRun(db, `thanks:${kind}:${id}:${ch}`)}`
    }
    const vars = { customer_name: customer.name, reference: row.reference, event_type: row.event_type, event_date: fmtLong(row.event_date), restaurant_phone: biz.phone || '', restaurant_name: biz.name || 'RHR Veg Restaurant' }
    const r = await enqueue(db, ctx, { key, type: 'thank_you', templateKey: 'thank_you', customer, vars, bookingId: kind === 'booking' ? id : null, cateringOrderId: kind === 'catering' ? id : null, channel: ch })
    if (r.event) out.push(r.event)
  }
  return out
}

export const todayIST = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10)

/**
 * Thank-you for hall bookings once the event has ended (+ configured delay). Looks back only 3 days so enabling the
 * feature (or importing old bookings) never mass-messages past customers. Safe to run as often as you like.
 */
export async function scanThankYous() {
  const settings = await getSetting({ query }, 'notifications')
  if (settings.sendThankYou === false || settings.enabled === false) return 0
  const delay = Math.min(72, Math.max(0, parseInt(settings.thankYouDelayHours ?? 2, 10) || 0))
  const due = await query(
    `SELECT b.id FROM bookings b
      WHERE b.status IN ('confirmed','completed')
        AND b.ends_at <= ((now() AT TIME ZONE 'Asia/Kolkata') - make_interval(hours => $1))
        AND b.event_date >= ((now() AT TIME ZONE 'Asia/Kolkata')::date - 3)
        AND NOT EXISTS (SELECT 1 FROM notification_events e WHERE e.booking_id=b.id AND e.type='thank_you')
      ORDER BY b.event_date LIMIT 50`,
    [delay],
  )
  let n = 0
  for (const r of due.rows) {
    await tx(async (c) => { n += (await enqueueThanks(c, { system: true }, 'booking', r.id, { auto: true })).length })
  }
  return n
}

let timer
let lastScan = 0
export function startWorker() {
  if (timer || !config.notifyWorker) return
  const tick = async () => {
    try { await runWorkerOnce() } catch (e) { console.error('[notify-worker]', e.message) }
    if (Date.now() - lastScan > 5 * 60 * 1000) {
      lastScan = Date.now()
      try { await scanThankYous() } catch (e) { console.error('[thank-you-scan]', e.message) }
    }
    timer = setTimeout(tick, config.notifyPollMs)
  }
  timer = setTimeout(tick, 1000)
}
export function stopWorker() {
  clearTimeout(timer)
  timer = undefined
}

/** Staff retry of a failed/dead/skipped message. Re-queues the SAME event — never creates a second one. */
export async function retryEvent(db, ctx, id) {
  const ev = (await db.query('SELECT e.*, c.message_consent FROM notification_events e JOIN customers c ON c.id=e.customer_id WHERE e.id=$1 FOR UPDATE OF e', [id])).rows[0]
  if (!ev) throw notFound('Notification')
  if (!['failed', 'dead', 'skipped'].includes(ev.status)) throw conflict(`A ${ev.status} message cannot be retried`, 'BAD_STATE')
  if (ev.status === 'skipped') {
    if (ev.skipped_reason === 'no_consent' && !ev.message_consent) throw conflict('Customer has not agreed to receive messages. Record consent on the customer first.', 'NO_CONSENT')
    if (ev.skipped_reason === 'no_template') throw conflict('No message template exists for this event', 'NO_TEMPLATE')
  }
  await db.query(
    `UPDATE notification_events SET status='queued', skipped_reason=NULL, max_attempts = attempts + (SELECT COALESCE((value->>'maxAttempts')::int, 5) FROM settings WHERE key='notifications'),
       next_attempt_at=now(), locked_until=NULL, last_error=NULL, updated_at=now() WHERE id=$1`,
    [id],
  )
  await audit(db, ctx, { action: 'Notification Retry', entityType: 'notification', entityId: id, summary: `${ev.template_key} (${ev.status})` })
  return (await db.query('SELECT * FROM notification_events WHERE id=$1', [id])).rows[0]
}

// ---------------- delivery receipts (webhooks) ----------------
const RANK = { queued: 0, sending: 1, sent: 2, delivered: 3 }
/** Apply a provider delivery receipt. Idempotent on (provider, message id, status) and never downgrades a delivered message. */
export async function applyReceipt({ provider, messageId, status, errorCode }) {
  const norm = { queued: 'sent', accepted: 'sent', sent: 'sent', delivered: 'delivered', read: 'delivered', undelivered: 'failed', failed: 'failed' }[String(status).toLowerCase()]
  if (!norm) return { ignored: true }
  const ins = await query(`INSERT INTO notification_receipts (provider, provider_message_id, status, error_code) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`, [provider, messageId, norm, errorCode || null])
  if (!ins.rowCount) return { duplicate: true }
  const ev = (await query('SELECT * FROM notification_events WHERE provider_message_id=$1', [messageId])).rows[0]
  if (!ev) return { unknown: true }
  if (norm === 'delivered') await query(`UPDATE notification_events SET status='delivered', delivered_at=COALESCE(delivered_at, now()), updated_at=now() WHERE id=$1`, [ev.id])
  else if (norm === 'failed' && (RANK[ev.status] ?? 0) < RANK.delivered) await query(`UPDATE notification_events SET status='failed', last_error=$2, updated_at=now() WHERE id=$1`, [ev.id, `Delivery failed${errorCode ? ` (${errorCode})` : ''}`])
  return { applied: true }
}

export const twilioSignature = (authToken, url, params) => {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('')
  return crypto.createHmac('sha1', authToken).update(data).digest('base64')
}
export const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}
