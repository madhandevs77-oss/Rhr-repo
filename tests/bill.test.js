// Bill + thank-you messages (SMS/WhatsApp text and email with the invoice PDF), against the mock provider and a real SMTP server.
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { SMTPServer } from 'smtp-server'
import { simpleParser } from 'mailparser'
import { bookingBody, futureDate, setup } from './helpers.js'

let env, admin, manager, staff, hall, mock, runWorker, scanThankYous, query, config, seq = 0, day = 200
const phone = () => '95000' + String(10000 + ++seq)
const today = () => futureDate(0)
const newBooking = async ({ email = `cust${seq + 1}@example.com`, consent = true, date } = {}) => {
  const customer = { name: 'Bill Cust ' + (seq + 1), phone: phone(), messageConsent: consent }
  if (email) customer.email = email
  const r = await staff.post('/api/bookings', bookingBody(hall.id, { date: date || futureDate(day++), customer }))
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return r.body.booking
}
const payFull = async (b, amount = 10000) => {
  const p = await staff.post(`/api/bookings/${b.id}/payments`, { amount, method: 'Cash', paidOn: today(), stage: 'final' })
  assert.equal(p.status, 201, JSON.stringify(p.body))
  const v = await manager.post(`/api/payments/${p.body.payment.id}/verify`)
  assert.equal(v.status, 200, JSON.stringify(v.body))
}
const detail = async (b) => (await manager.get(`/api/bookings/${b.id}`)).body.booking
const ofType = (d, type) => d.notifications.filter((n) => n.templateKey === type)
const drain = async () => { for (let i = 0; i < 3; i++) await runWorker() }
const setNotif = async (patch) => {
  const cur = (await admin.get('/api/settings')).body.notifications
  const r = await admin.put('/api/settings/notifications', { ...cur, ...patch })
  assert.equal(r.status, 200, JSON.stringify(r.body))
}

before(async () => {
  env = await setup()
  admin = await env.client('admin').login(); manager = await env.client('manager').login(); staff = await env.client('staff').login()
  hall = (await admin.post('/api/halls', { name: 'Bill Hall', basePrice: 10000 })).body.hall
  mock = (await import('../server/providers/index.js')).mock
  const n = await import('../server/services/notifications.js')
  runWorker = n.runWorkerOnce; scanThankYous = n.scanThankYous
  ;({ query } = await import('../server/db/pool.js'))
  ;({ config } = await import('../server/config.js'))
  await drain(); mock.reset()
})
after(() => env.teardown())

describe('bill after full payment', () => {
  test('nothing is sent for a part payment; text + email (with PDF) are sent when the bill is paid in full', async () => {
    const b = await newBooking()
    await payFull(b, 4000)
    await drain()
    assert.equal(ofType(await detail(b), 'bill_ready').length, 0, 'no bill before it is fully paid')
    await payFull(b, 6000)
    const d = await detail(b)
    const bills = ofType(d, 'bill_ready')
    assert.deepEqual(bills.map((x) => x.channel).sort(), ['email', 'sms'])
    mock.reset()
    await drain()
    const emails = mock.outbox.filter((m) => m.channel === 'email' && m.to === b.customer.email)
    assert.equal(emails.length, 1)
    assert.match(emails[0].subject, /^Your invoice INV\//)
    assert.equal(emails[0].attachments.length, 1)
    assert.match(emails[0].attachments[0].filename, /^INV_.*\.pdf$/)
    assert.ok(emails[0].attachments[0].size > 1500, 'PDF is attached')
    const sms = mock.outbox.find((m) => m.channel === 'sms' && m.to === '+91' + b.customer.phone)
    assert.match(sms.body, /Invoice No: INV\//)
    assert.match(sms.body, /sent to your email/)
    assert.doesNotMatch(sms.body + emails[0].body, /UPI|card|account number/i)
    const after = await detail(b)
    assert.ok(ofType(after, 'bill_ready').every((x) => ['sent', 'delivered'].includes(x.status)), JSON.stringify(after.notifications.map((n) => n.status)))
  })

  test('no email on file -> only the text message, which says a printed copy is available', async () => {
    const b = await newBooking({ email: null })
    await payFull(b)
    mock.reset(); await drain()
    const bills = ofType(await detail(b), 'bill_ready')
    assert.deepEqual(bills.map((x) => x.channel), ['sms'])
    assert.match(mock.outbox.find((m) => m.to === '+91' + b.customer.phone && /Invoice No/.test(m.body)).body, /printed copy/)
  })

  test('customer without consent: nothing is sent (recorded as skipped)', async () => {
    const b = await newBooking({ consent: false })
    await payFull(b)
    mock.reset(); await drain()
    assert.equal(mock.outbox.filter((m) => /Invoice No/.test(m.body)).length, 0)
    assert.ok(ofType(await detail(b), 'bill_ready').every((x) => x.status === 'skipped' && x.skippedReason === 'no_consent'))
  })

  test('never duplicated: re-running the worker and re-issuing the invoice sends nothing more', async () => {
    const b = await newBooking()
    await payFull(b); await drain(); mock.reset()
    await manager.post(`/api/bookings/${b.id}/invoices/issue`)
    await drain(); await drain()
    assert.equal(mock.outbox.length, 0)
    assert.equal(ofType(await detail(b), 'bill_ready').length, 2)
  })

  test('a corrected (second) invoice is NOT auto-sent; staff can send it deliberately', async () => {
    const b = await newBooking()
    await payFull(b); await drain()
    let d = await detail(b)
    const body = { ...bookingBody(hall.id, { date: d.date, customer: { name: d.customer.name, phone: d.customer.phone, email: b.customer.email, messageConsent: true }, hallCharge: 11000 }), expectedVersion: d.version }
    assert.equal((await manager.put(`/api/bookings/${b.id}`, { ...body, confirm: { financial: true, invoice: true }, reason: 'Decoration added' })).status, 200)
    await payFull(b, 1000)
    mock.reset(); await drain()
    d = await detail(b)
    assert.equal(ofType(d, 'bill_ready').length, 2, 'still only the first invoice\'s two messages')
    const live = d.invoices.find((i) => i.status === 'issued')
    const sent = await staff.post(`/api/invoices/${live.id}/send`, {})
    assert.equal(sent.status, 201, JSON.stringify(sent.body))
    await drain()
    assert.equal(mock.outbox.filter((m) => m.channel === 'email').length, 1)
    assert.match(mock.outbox.find((m) => m.channel === 'email').subject, new RegExp(live.number.replace('/', '\\/')))
  })
})

describe('manual "send to customer"', () => {
  test('sends again on request, but not twice at once; validates channel, invoice state and permissions', async () => {
    const b = await newBooking(); await payFull(b); await drain()
    const inv = (await detail(b)).invoices[0]
    mock.reset()
    const a = await staff.post(`/api/invoices/${inv.id}/send`, { channels: ['email'] })
    assert.equal(a.status, 201); assert.equal(a.body.notifications.length, 1); assert.equal(a.body.notifications[0].channel, 'email')
    const dup = await staff.post(`/api/invoices/${inv.id}/send`, { channels: ['email'] })
    assert.equal(dup.status, 409); assert.equal(dup.body.error.code, 'ALREADY_SENDING')
    await drain()
    assert.equal(mock.outbox.filter((m) => m.channel === 'email').length, 1)
    assert.equal((await staff.post(`/api/invoices/${inv.id}/send`, { channels: ['email'] })).status, 201, 'a later re-send is allowed')
    // customer with no email
    const b2 = await newBooking({ email: null }); await payFull(b2); await drain()
    const inv2 = (await detail(b2)).invoices[0]
    const noMail = await staff.post(`/api/invoices/${inv2.id}/send`, { channels: ['email'] })
    assert.equal(noMail.status, 409); assert.equal(noMail.body.error.code, 'NO_EMAIL')
    // voided invoice cannot be sent
    assert.equal((await admin.post(`/api/invoices/${inv2.id}/void`, { reason: 'Test void' })).status, 200)
    assert.equal((await staff.post(`/api/invoices/${inv2.id}/send`, {})).status, 409)
    assert.equal((await env.client('nobody').post(`/api/invoices/${inv.id}/send`, {})).status, 401)
    assert.equal((await staff.post(`/api/invoices/${inv.id}/send`, { channels: ['pigeon'] })).status, 400)
  })
})

describe('failures never touch the booking or the money', () => {
  test('a rejected mailbox fails the email only; the text goes out, the invoice and payment stay intact; retry works after fixing the address', async () => {
    const b = await newBooking({ email: 'permfail@example.com' })
    await payFull(b); mock.reset(); await drain()
    const d = await detail(b)
    const email = ofType(d, 'bill_ready').find((x) => x.channel === 'email')
    const sms = ofType(d, 'bill_ready').find((x) => x.channel === 'sms')
    assert.equal(email.status, 'failed'); assert.match(email.lastError, /INVALID_EMAIL/)
    assert.equal(sms.status, 'sent')
    assert.equal(d.money.state, 'paid'); assert.equal(d.invoices.filter((i) => i.status === 'issued').length, 1)
    // a temporary outage keeps retrying
    const b2 = await newBooking({ email: 'tempfail@example.com' })
    await payFull(b2); await drain()
    const t = ofType(await detail(b2), 'bill_ready').find((x) => x.channel === 'email')
    assert.equal(t.status, 'queued'); assert.ok(t.attempts >= 1)
  })
})

describe('thank-you message', () => {
  let slot = 0 // every past booking gets its own hour so the no-overlap constraint is never in the way
  const makePast = (b, daysAgo = 1) => { const h = (slot++ % 20) + 1; return query(`UPDATE bookings SET event_date = $2::date, start_time=$3::time, end_time=$4::time WHERE id=$1`, [b.id, futureDate(-daysAgo), `${h}:00`, `${h}:30`]) }
  const confirmed = async (o) => { const b = await newBooking(o); await payFull(b, 3000); return b }

  test('sent once after the event has ended, by text and email; not before; not for cancelled bookings; never duplicated', async () => {
    const future = await confirmed()
    const past = await confirmed()
    const cancelled = await confirmed()
    await manager.post(`/api/bookings/${cancelled.id}/cancel`, { reason: 'Customer cancelled', confirm: true })
    await makePast(past); await makePast(cancelled)
    await drain(); mock.reset()
    const n = await scanThankYous()
    assert.ok(n >= 2, 'text + email for the past booking')
    assert.equal(await scanThankYous(), 0, 'second scan adds nothing')
    await drain()
    assert.equal(ofType(await detail(future), 'thank_you').length, 0)
    assert.equal(ofType(await detail(cancelled), 'thank_you').length, 0)
    const t = ofType(await detail(past), 'thank_you')
    assert.deepEqual(t.map((x) => x.channel).sort(), ['email', 'sms'])
    const em = mock.outbox.find((m) => m.channel === 'email' && m.subject === 'Thank you from RHR Veg Restaurant')
    assert.ok(em); assert.match(em.body, /pleasure serving you/); assert.equal(em.attachments.length, 0)
  })

  test('old events are not mass-messaged (3-day look-back) and the switch in Settings turns it off', async () => {
    const old = await confirmed(); await makePast(old, 10)
    const recent = await confirmed(); await makePast(recent, 1)
    await setNotif({ sendThankYou: false })
    assert.equal(await scanThankYous(), 0)
    await setNotif({ sendThankYou: true })
    await scanThankYous()
    assert.equal(ofType(await detail(old), 'thank_you').length, 0)
    assert.equal(ofType(await detail(recent), 'thank_you').length, 2)
  })

  test('the delay setting is respected', async () => {
    await setNotif({ thankYouDelayHours: 72 })
    const b = await confirmed()
    await makePast(b, 1)
    assert.equal(await scanThankYous(), 0, 'event ended yesterday but the delay is 72h')
    await setNotif({ thankYouDelayHours: 2 })
  })

  test('staff can re-send manually only once the event has happened', async () => {
    const b = await confirmed()
    const early = await staff.post(`/api/bookings/${b.id}/thank-you`, {})
    assert.equal(early.status, 409); assert.equal(early.body.error.code, 'TOO_EARLY')
    await makePast(b)
    const ok = await staff.post(`/api/bookings/${b.id}/thank-you`, {})
    assert.equal(ok.status, 201, JSON.stringify(ok.body)); assert.equal(ok.body.notifications.length, 2)
    assert.equal((await staff.post(`/api/bookings/${b.id}/thank-you`, {})).status, 409, 'already being sent')
  })

  test('catering order: thank-you goes out once when the order is delivered', async () => {
    const opts = Object.fromEntries((await staff.get('/api/catering/options')).body.options.map((o) => [o.code, o]))
    const r = await staff.post('/api/catering', { customer: { name: 'Cat Thanks', phone: phone(), email: 'cat@example.com', messageConsent: true }, serviceOptionId: opts.A.id, eventType: 'Birthday', date: futureDate(40),
      deliveryTime: '11:00', servingTime: '12:00', venueName: 'Hall', deliveryAddress: '12 Main Rd', plates: 50, pricingMode: 'per_plate', pricePerPlate: 100, taxRate: 0 })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    const o = r.body.order
    for (const to of ['confirmed', 'preparation', 'ready_for_dispatch']) assert.equal((await staff.post(`/api/catering/${o.id}/status`, { to })).status, 200, to)
    assert.equal((await manager.get(`/api/catering/${o.id}`)).body.order.notifications.filter((n) => n.templateKey === 'thank_you').length, 0)
    assert.equal((await staff.post(`/api/catering/${o.id}/status`, { to: 'delivered' })).status, 200)
    assert.equal((await manager.post(`/api/catering/${o.id}/status`, { to: 'completed' })).status, 200)
    const th = (await manager.get(`/api/catering/${o.id}`)).body.order.notifications.filter((n) => n.templateKey === 'thank_you')
    assert.deepEqual(th.map((x) => x.channel).sort(), ['email', 'sms'], 'once, even though delivered and completed both qualify')
  })
})

describe('template editing', () => {
  test('email templates need a subject; unknown placeholders and payment details are refused; staff cannot edit', async () => {
    const tpls = (await admin.get('/api/notification-templates')).body.templates
    const em = tpls.find((t) => t.key === 'bill_ready' && t.channel === 'email' && t.language === 'en')
    assert.ok(em.subject && em.variables.includes('invoice_number'))
    assert.equal((await admin.put(`/api/notification-templates/${em.id}`, { body: em.body, subject: '' })).status, 400)
    assert.equal((await admin.put(`/api/notification-templates/${em.id}`, { body: em.body + ' {{secret}}', subject: em.subject })).status, 400)
    assert.equal((await admin.put(`/api/notification-templates/${em.id}`, { body: em.body, subject: 'Bill {{nonsense}}' })).status, 400)
    assert.equal((await admin.put(`/api/notification-templates/${em.id}`, { body: em.body + '\nPay to account number 123', subject: em.subject })).status, 400)
    assert.equal((await staff.put(`/api/notification-templates/${em.id}`, { body: em.body, subject: em.subject })).status, 403)
    assert.equal((await admin.put(`/api/notification-templates/${em.id}`, { body: em.body, subject: 'Invoice {{invoice_number}} from us' })).status, 200)
    await admin.put(`/api/notification-templates/${em.id}`, { body: em.body, subject: em.subject })
  })
})

describe('real SMTP delivery', () => {
  let smtp, port, inbox = [], rejectDomain = null
  before(async () => {
    smtp = new SMTPServer({
      authOptional: true, disabledCommands: ['STARTTLS'],
      onRcptTo(addr, _s, cb) { if (rejectDomain && addr.address.endsWith(rejectDomain)) { const e = new Error('550 No such user here'); e.responseCode = 550; return cb(e) } cb() },
      onData(stream, _s, cb) { simpleParser(stream).then((m) => { inbox.push(m); cb() }, cb) },
    })
    await new Promise((r) => smtp.listen(0, '127.0.0.1', r))
    port = smtp.server.address().port
    Object.assign(config.smtp, { host: '127.0.0.1', port, secure: false, requireTls: false, from: 'RHR Veg Restaurant <bills@rhr.test>', replyTo: 'help@rhr.test' })
    await setNotif({ emailProvider: 'smtp' })
  })
  after(async () => { await setNotif({ emailProvider: 'mock' }); await new Promise((r) => smtp.close(r)) })

  test('the customer receives a real email with the invoice PDF attached', async () => {
    const b = await newBooking({ email: 'real.customer@example.com' })
    await payFull(b); inbox.length = 0; await drain()
    const m = inbox.find((x) => x.to.text.includes('real.customer@example.com'))
    assert.ok(m, 'email arrived at the SMTP server')
    assert.equal(m.from.value[0].name, 'RHR Veg Restaurant'); assert.equal(m.from.value[0].address, 'bills@rhr.test'); assert.equal(m.replyTo.value[0].address, 'help@rhr.test')
    assert.match(m.subject, /^Your invoice INV\//)
    assert.match(m.text, /Dear Bill Cust/); assert.match(m.text, /Total Paid: ₹10,000/)
    assert.match(m.html, /Dear Bill Cust/)
    assert.equal(m.attachments.length, 1)
    assert.equal(m.attachments[0].contentType, 'application/pdf')
    assert.equal(m.attachments[0].content.subarray(0, 5).toString(), '%PDF-')
    assert.ok(m.attachments[0].content.length > 2000)
    const d = await detail(b)
    assert.equal(ofType(d, 'bill_ready').find((x) => x.channel === 'email').status, 'sent')
    assert.equal(ofType(d, 'bill_ready').find((x) => x.channel === 'email').provider, 'smtp-email')
  })

  test('a mailbox the server refuses is a permanent failure; a dead server is retried and then succeeds', async () => {
    rejectDomain = '@bounce.test'
    const b = await newBooking({ email: 'ghost@bounce.test' })
    await payFull(b); await drain()
    const e = ofType(await detail(b), 'bill_ready').find((x) => x.channel === 'email')
    assert.equal(e.status, 'failed'); assert.match(e.lastError, /INVALID_EMAIL/)
    rejectDomain = null
    // server down
    const good = port
    config.smtp.port = 1; (await import('../server/providers/index.js')).resetMailer()
    const b2 = await newBooking({ email: 'later@example.com' })
    await payFull(b2); await drain()
    let e2 = ofType(await detail(b2), 'bill_ready').find((x) => x.channel === 'email')
    assert.equal(e2.status, 'queued'); assert.match(e2.lastError, /NETWORK/)
    // server back; the event becomes due again
    config.smtp.port = good; (await import('../server/providers/index.js')).resetMailer()
    await query(`UPDATE notification_events SET next_attempt_at=now() WHERE id=$1`, [e2.id])
    inbox.length = 0; await drain()
    e2 = ofType(await detail(b2), 'bill_ready').find((x) => x.channel === 'email')
    assert.equal(e2.status, 'sent'); assert.equal(inbox.filter((x) => x.to.text.includes('later@example.com')).length, 1)
  })
})
