// Messaging providers. Each adapter exposes: name, isConfigured(), send({to, body, channel, templateName, language, variables})
// and throws ProviderError({retryable, code, retryAfterSec}) on failure. Credentials come from env only.
import crypto from 'node:crypto'
import nodemailer from 'nodemailer'
import { config } from '../config.js'

export class ProviderError extends Error {
  constructor(message, { retryable = false, code = 'PROVIDER_ERROR', retryAfterSec = null, rateLimited = false } = {}) {
    super(message)
    this.retryable = retryable
    this.code = code
    this.retryAfterSec = retryAfterSec
    this.rateLimited = rateLimited
  }
}

// ---------------- mock (default; never contacts anyone) ----------------
export const mock = {
  name: 'mock',
  outbox: [],
  isConfigured: () => true,
  reset() { this.outbox.length = 0 },
  async send({ to, body, channel, subject, attachments }) {
    // deterministic failure injection for tests / staging drills
    if (to.startsWith('permfail@')) throw new ProviderError('Mailbox does not exist', { retryable: false, code: 'INVALID_EMAIL' })
    if (to.startsWith('tempfail@')) throw new ProviderError('Mail server temporarily unavailable', { retryable: true, code: 'PROVIDER_DOWN' })
    if (to.endsWith('9999900001')) throw new ProviderError('Invalid destination number', { retryable: false, code: 'INVALID_NUMBER' })
    if (to.endsWith('9999900002')) throw new ProviderError('Temporary provider outage', { retryable: true, code: 'PROVIDER_DOWN' })
    if (to.endsWith('9999900003')) throw new ProviderError('Rate limit exceeded', { retryable: true, code: 'RATE_LIMIT', retryAfterSec: 1, rateLimited: true })
    const id = 'mock_' + crypto.randomUUID()
    this.outbox.push({ id, to, body, channel, subject, attachments: (attachments || []).map((a) => ({ filename: a.filename, size: a.content?.length || 0 })), at: new Date() })
    if (!config.isTest) console.log(`[mock ${channel}] -> ${to}: ${body.split('\n')[0]} …`)
    return { providerMessageId: id }
  },
}

// ---------------- Twilio (SMS + WhatsApp) ----------------
export const twilio = (channel) => ({
  name: channel === 'whatsapp' ? 'twilio-whatsapp' : 'twilio-sms',
  isConfigured: () => !!(config.twilio.accountSid && config.twilio.authToken && (channel === 'whatsapp' ? config.twilio.whatsappFrom : config.twilio.smsFrom)),
  async send({ to, body }) {
    const t = config.twilio
    const form = new URLSearchParams({
      To: channel === 'whatsapp' ? `whatsapp:${to}` : to,
      From: channel === 'whatsapp' ? `whatsapp:${t.whatsappFrom.replace(/^whatsapp:/, '')}` : t.smsFrom,
      Body: body,
    })
    if (t.statusCallbackUrl) form.set('StatusCallback', t.statusCallbackUrl)
    let res
    try {
      res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${t.accountSid}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: 'Basic ' + Buffer.from(`${t.accountSid}:${t.authToken}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: AbortSignal.timeout(15000),
      })
    } catch (e) {
      throw new ProviderError(`Network error: ${e.message}`, { retryable: true, code: 'NETWORK' })
    }
    const data = await res.json().catch(() => ({}))
    if (res.ok) return { providerMessageId: data.sid }
    const retryAfterSec = parseInt(res.headers.get('retry-after') || '', 10) || null
    if (res.status === 429) throw new ProviderError('Twilio rate limit', { retryable: true, code: 'RATE_LIMIT', retryAfterSec, rateLimited: true })
    if (res.status >= 500) throw new ProviderError(`Twilio server error ${res.status}`, { retryable: true, code: 'PROVIDER_5XX' })
    if (res.status === 401 || res.status === 403) throw new ProviderError('Twilio credentials rejected', { retryable: false, code: 'PROVIDER_AUTH' })
    const invalidNumber = [21211, 21214, 21614, 63007, 21408].includes(data.code)
    throw new ProviderError(data.message || `Twilio error ${res.status}`, { retryable: false, code: invalidNumber ? 'INVALID_NUMBER' : String(data.code || 'REJECTED') })
  },
})

// ---------------- Meta WhatsApp Business Cloud API ----------------
// WhatsApp requires pre-approved templates for business-initiated messages. Parameters are sent in the
// order listed in TEMPLATE_PARAMS, which MUST match the placeholders {{1}}..{{n}} of the template you registered.
export const TEMPLATE_PARAMS = {
  booking_confirmation: ['customer_name', 'booking_reference', 'hall_name', 'event_type', 'event_date', 'start_time', 'end_time', 'total_amount', 'advance_amount', 'remaining_balance'],
  booking_changed: ['customer_name', 'booking_reference', 'hall_name', 'event_date', 'start_time', 'end_time', 'remaining_balance', 'restaurant_phone'],
  bill_ready: ['customer_name', 'invoice_number', 'reference', 'event_date', 'total_amount', 'restaurant_phone'],
  thank_you: ['customer_name', 'event_type', 'event_date', 'restaurant_phone'],
  catering_confirmation: ['customer_name', 'order_reference', 'event_date', 'delivery_time', 'plates', 'total_amount', 'advance_amount', 'remaining_balance'],
}
export const metaWhatsapp = {
  name: 'meta-whatsapp',
  isConfigured: () => !!(config.metaWhatsapp.phoneNumberId && config.metaWhatsapp.accessToken),
  async send({ to, body, templateName, templateKey, language, variables }) {
    const m = config.metaWhatsapp
    const payload = { messaging_product: 'whatsapp', to: to.replace('+', '') }
    if (templateName) {
      const order = TEMPLATE_PARAMS[templateKey] || []
      payload.type = 'template'
      payload.template = {
        name: templateName,
        language: { code: language === 'ta' ? 'ta' : 'en' },
        components: order.length ? [{ type: 'body', parameters: order.map((k) => ({ type: 'text', text: String(variables?.[k] ?? '-') })) }] : [],
      }
    } else {
      payload.type = 'text' // only deliverable inside the 24h customer-service window
      payload.text = { body }
    }
    let res
    try {
      res = await fetch(`https://graph.facebook.com/${m.apiVersion}/${m.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${m.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      })
    } catch (e) {
      throw new ProviderError(`Network error: ${e.message}`, { retryable: true, code: 'NETWORK' })
    }
    const data = await res.json().catch(() => ({}))
    if (res.ok && data.messages?.[0]?.id) return { providerMessageId: data.messages[0].id }
    const code = data.error?.code
    const retryAfterSec = parseInt(res.headers.get('retry-after') || '', 10) || null
    if (res.status === 429 || [4, 80007, 130429, 131056].includes(code)) throw new ProviderError(data.error?.message || 'WhatsApp rate limit', { retryable: true, code: 'RATE_LIMIT', retryAfterSec, rateLimited: true })
    if (res.status >= 500) throw new ProviderError(`WhatsApp server error ${res.status}`, { retryable: true, code: 'PROVIDER_5XX' })
    if ([190, 10].includes(code) || res.status === 401) throw new ProviderError('WhatsApp credentials rejected', { retryable: false, code: 'PROVIDER_AUTH' })
    if ([131026, 131030, 131021].includes(code)) throw new ProviderError(data.error?.message || 'Number not on WhatsApp', { retryable: false, code: 'INVALID_NUMBER' })
    if ([132000, 132001, 132005, 132007, 132012, 132015, 132016].includes(code)) throw new ProviderError(data.error?.message || 'Template problem', { retryable: false, code: 'TEMPLATE_REJECTED' })
    throw new ProviderError(data.error?.message || `WhatsApp error ${res.status}`, { retryable: false, code: String(code || 'REJECTED') })
  },
}

// ---------------- Email over SMTP (nodemailer) ----------------
let transporter
const mailer = () => {
  const c = config.smtp
  transporter ||= nodemailer.createTransport({
    host: c.host, port: c.port, secure: c.secure, requireTLS: !c.secure && c.requireTls,
    auth: c.user ? { user: c.user, pass: c.pass } : undefined,
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
  })
  return transporter
}
export const resetMailer = () => { transporter?.close?.(); transporter = undefined }
export const smtpEmail = {
  name: 'smtp-email',
  isConfigured: () => !!(config.smtp.host && config.smtp.from),
  async send({ to, subject, body, html, attachments }) {
    let info
    try {
      info = await mailer().sendMail({ from: config.smtp.from, replyTo: config.smtp.replyTo || undefined, to, subject, text: body, html, attachments })
    } catch (e) {
      const rc = e.responseCode
      if (e.code === 'EAUTH' || rc === 535 || rc === 534 || rc === 530) throw new ProviderError('Email server rejected the login (check SMTP_USER / SMTP_PASS)', { retryable: false, code: 'PROVIDER_AUTH' })
      if (rc >= 500 && rc < 600) throw new ProviderError(`Email rejected: ${e.response || e.message}`.slice(0, 300), { retryable: false, code: [550, 551, 552, 553, 554, 501].includes(rc) ? 'INVALID_EMAIL' : 'REJECTED' })
      throw new ProviderError(`Email server problem: ${e.message}`, { retryable: true, code: rc >= 400 ? 'PROVIDER_4XX' : 'NETWORK' })
    }
    if (info.rejected?.length) throw new ProviderError(`Recipient rejected: ${info.rejected.join(', ')}`, { retryable: false, code: 'INVALID_EMAIL' })
    return { providerMessageId: info.messageId }
  },
}

/** Resolve the adapter configured in Settings for a channel. */
export function providerFor(channel, settings) {
  if (channel === 'email') return settings.emailProvider === 'smtp' ? smtpEmail : mock
  const choice = channel === 'whatsapp' ? settings.whatsappProvider : settings.smsProvider
  if (choice === 'twilio') return twilio(channel)
  if (choice === 'meta' && channel === 'whatsapp') return metaWhatsapp
  return mock
}

export const providerStatus = () => ({
  twilioSms: twilio('sms').isConfigured(),
  twilioWhatsapp: twilio('whatsapp').isConfigured(),
  metaWhatsapp: metaWhatsapp.isConfigured(),
  smtpEmail: smtpEmail.isConfigured(),
  paymentWebhook: !!config.paymentWebhookSecret,
})
