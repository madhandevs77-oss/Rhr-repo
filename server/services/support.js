// Small shared services: audit, settings, counters, customers
import { badRequest } from '../lib/errors.js'

export async function audit(db, ctx, { action, entityType, entityId, summary, details }) {
  await db.query(
    `INSERT INTO audit_events (user_id, user_name, action, entity_type, entity_id, summary, details, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [ctx?.user?.id || null, ctx?.user?.name || (ctx?.system ? 'System' : null), action, entityType || null, entityId ? String(entityId) : null, summary || null, details ? JSON.stringify(details) : null, ctx?.ip || null],
  )
}

export async function getSetting(db, key) {
  const r = await db.query('SELECT value FROM settings WHERE key=$1', [key])
  return r.rows[0]?.value || {}
}
export async function getSettings(db) {
  const r = await db.query('SELECT key, value FROM settings')
  return Object.fromEntries(r.rows.map((x) => [x.key, x.value]))
}

export async function nextRef(db, name, period, prefix, start = 1000) {
  const r = await db.query('SELECT next_counter($1,$2,$3) AS n', [name, period, start])
  return `${prefix}-${period}-${r.rows[0].n}`
}
export async function raiseCounter(db, name, period, atLeast) {
  await db.query(
    `INSERT INTO counters (name, period, last_value) VALUES ($1,$2,$3)
     ON CONFLICT (name, period) DO UPDATE SET last_value = GREATEST(counters.last_value, EXCLUDED.last_value)`,
    [name, period, atLeast],
  )
}

/** Indian financial year label for a date, e.g. 2026-10-15 -> "2026-27" */
export function financialYear(d = new Date()) {
  const ist = new Date(d.getTime() + 5.5 * 3600 * 1000)
  const y = ist.getUTCFullYear()
  const start = ist.getUTCMonth() >= 3 ? y : y - 1
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`
}
export const todayIST = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10)

export async function upsertCustomer(db, c) {
  if (!/^\d{10}$/.test(c.phone || '')) throw badRequest('Customer phone must be 10 digits')
  const existing = await db.query('SELECT * FROM customers WHERE phone=$1 FOR UPDATE', [c.phone])
  const consentGiven = c.messageConsent === true
  if (existing.rows[0]) {
    const e = existing.rows[0]
    const consentChanged = c.messageConsent !== undefined && c.messageConsent !== e.message_consent
    const r = await db.query(
      `UPDATE customers SET name=$2, alt_phone=$3, email=$4, address=$5, notes=$6, language=$7,
         billing_name=$8, billing_address=$9, billing_tax_id=$10,
         message_consent = $11, consent_at = CASE WHEN $12 THEN now() ELSE consent_at END,
         consent_source = CASE WHEN $12 THEN $13 ELSE consent_source END, updated_at=now()
       WHERE id=$1 RETURNING *`,
      [e.id, c.name ?? e.name, c.altPhone ?? e.alt_phone, c.email ?? e.email, c.address ?? e.address, c.notes ?? e.notes,
       c.language ?? e.language, c.billingName ?? e.billing_name, c.billingAddress ?? e.billing_address, c.billingTaxId ?? e.billing_tax_id,
       c.messageConsent ?? e.message_consent, consentChanged, c.consentSource || 'staff_form'],
    )
    return r.rows[0]
  }
  const r = await db.query(
    `INSERT INTO customers (name, phone, alt_phone, email, address, notes, language, billing_name, billing_address, billing_tax_id,
       message_consent, consent_at, consent_source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [c.name, c.phone, c.altPhone || null, c.email || null, c.address || '', c.notes || '', c.language || 'en',
     c.billingName || null, c.billingAddress || null, c.billingTaxId || null, consentGiven, consentGiven ? new Date() : null, consentGiven ? c.consentSource || 'staff_form' : null],
  )
  return r.rows[0]
}

export const serializeCustomer = (c) => ({
  id: c.id, name: c.name, phone: c.phone, altPhone: c.alt_phone || '', email: c.email || '', address: c.address || '', notes: c.notes || '',
  language: c.language, messageConsent: c.message_consent, consentAt: c.consent_at,
  billingName: c.billing_name || '', billingAddress: c.billing_address || '', billingTaxId: c.billing_tax_id || '',
})
