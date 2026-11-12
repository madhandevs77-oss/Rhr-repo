// Outsource sections: date and time are optional; a start time brings an automatic 3-hour end (with next-day rollover).
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { futureDate, setup } from './helpers.js'

let env, query, staff, manager, out, mand, seq = 0
const person = () => ({ name: 'Opt ' + ++seq, phone: '94000' + String(10000 + seq), messageConsent: true })
const body = (hall, o = {}) => ({ customer: person(), hallId: hall.id, fulfilment: 'takeaway', ...o })

before(async () => {
  env = await setup(); ({ query } = await import('../server/db/pool.js'))
  staff = await env.client('staff').login(); manager = await env.client('manager').login()
  const halls = (await staff.get('/api/halls')).body.halls
  out = halls.filter((h) => h.kind === 'outsource')[0]; mand = halls.find((h) => h.name === 'Mandapam')
  assert.ok(out && mand)
})
after(() => env.teardown())
const create = (o, hall = out) => staff.post('/api/bookings', body(hall, o))
const row = async (id) => (await query('SELECT event_date, start_time, end_time, ends_next_day, starts_at, ends_at FROM bookings WHERE id=$1', [id])).rows[0]

describe('Outsource: date and time are optional', () => {
  test('1. no date and no time at all: accepted (field omitted, empty string, or null) and stored as NULL', async () => {
    for (const extra of [{}, { date: '', startTime: '', endTime: '' }, { date: null, startTime: null, endTime: null }]) {
      const r = await create(extra); assert.equal(r.status, 201, JSON.stringify(r.body))
      const b = r.body.booking
      assert.equal(b.date, null); assert.equal(b.startTime, null); assert.equal(b.endTime, null); assert.equal(b.endsNextDay, false)
      const db = await row(b.id); assert.equal(db.event_date, null); assert.equal(db.start_time, null); assert.equal(db.starts_at, null)
    }
  })
  test('undated bookings can be read, listed (only when asked), and do not appear on the calendar or in availability checks', async () => {
    const b = (await create({})).body.booking
    assert.equal((await staff.get(`/api/bookings/${b.id}`)).body.booking.date, null)
    const mine = (res) => res.body.bookings.some((x) => x.id === b.id)
    assert.equal(mine(await staff.get(`/api/bookings?from=2000-01-01&to=2100-01-01&includeUndated=1`)), true)
    assert.equal(mine(await staff.get(`/api/bookings?from=2000-01-01&to=2100-01-01`)), false, 'availability style queries never see undated rows')
    assert.equal(mine(await staff.get(`/api/bookings?q=${encodeURIComponent(b.customer.name)}`)), true, 'search finds it')
    const month = (await staff.get(`/api/calendar?month=${futureDate(30).slice(0, 7)}`)).body
    assert.ok(Object.values(month.days).every((n) => Number.isInteger(n)))
  })
  test('many undated bookings in the same section never clash with each other or with timed ones', async () => {
    const date = futureDate(60)
    assert.equal((await create({ date, startTime: '10:00', endTime: '13:00' })).status, 201)
    for (let i = 0; i < 3; i++) assert.equal((await create({})).status, 201)
    assert.equal((await create({ date })).status, 201, 'date only')
  })
  test('date only, and time only, are accepted', async () => {
    const d = (await create({ date: futureDate(61) })).body.booking; assert.equal(d.date, futureDate(61)); assert.equal(d.startTime, null)
    const t = (await create({ startTime: '09:00' })).body.booking; assert.equal(t.date, null); assert.equal(t.startTime, '09:00'); assert.equal(t.endTime, '12:00')
  })
  test('an end time without a start time is refused (400)', async () => {
    assert.equal((await create({ endTime: '12:00' })).status, 400)
  })
  test('other sections still REQUIRE date and times (unchanged)', async () => {
    assert.equal((await create({}, mand)).status, 400)
    assert.equal((await create({ date: futureDate(62) }, mand)).status, 400)
    assert.equal((await create({ startTime: '10:00', endTime: '13:00' }, mand)).status, 400)
    assert.equal((await create({ date: futureDate(62), startTime: '10:00', endTime: '13:00' }, mand)).status, 201)
  })
  test('a past date is still refused when a date is given', async () => {
    assert.equal((await create({ date: '2020-01-01' })).status, 400)
  })
})

describe('Outsource: end time = start + exactly 3 hours', () => {
  test('2. end defaults to start + 3h when only the start time is sent', async () => {
    for (const [i, [start, end]] of [['10:00', '13:00'], ['09:15', '12:15'], ['00:00', '03:00'], ['20:59', '23:59']].entries()) {
      const r = await create({ date: futureDate(100 + i * 3), startTime: start }); assert.equal(r.status, 201, JSON.stringify(r.body))
      assert.equal(r.body.booking.endTime, end, start); assert.equal(r.body.booking.endsNextDay, false, start)
    }
  })
  test('3. midnight rollover: the end falls on the next day and is flagged', async () => {
    for (const [i, [start, end]] of [['22:30', '01:30'], ['21:00', '00:00'], ['23:59', '02:59'], ['21:01', '00:01']].entries()) {
      const r = await create({ date: futureDate(130 + i * 3), startTime: start }); assert.equal(r.status, 201, JSON.stringify(r.body))
      assert.equal(r.body.booking.endTime, end, start); assert.equal(r.body.booking.endsNextDay, true, start)
      const db = await row(r.body.booking.id)
      assert.equal(new Date(db.ends_at) > new Date(db.starts_at), true, 'ends_at is after starts_at')
      assert.equal(Math.round((new Date(db.ends_at + 'Z') - new Date(db.starts_at + 'Z')) / 60000), 180, `${start} lasts exactly 3 hours in the database`)
    }
  })
  test('an explicit end earlier than the start is read as the next day for Outsource; equal times are refused', async () => {
    const r = await create({ date: futureDate(72), startTime: '22:00', endTime: '01:00' }); assert.equal(r.status, 201)
    assert.equal(r.body.booking.endsNextDay, true)
    assert.equal((await create({ date: futureDate(72), startTime: '10:00', endTime: '10:00' })).status, 400)
  })
  test('an explicit same-day end is kept as given', async () => {
    const r = await create({ date: futureDate(73), startTime: '10:00', endTime: '15:30' }); assert.equal(r.body.booking.endTime, '15:30'); assert.equal(r.body.booking.endsNextDay, false)
  })
  test('overlap checks understand next-day ends (same section)', async () => {
    const d = futureDate(80), d2 = futureDate(81)
    const hall = (await staff.get('/api/halls')).body.halls.filter((h) => h.kind === 'outsource')[1]
    assert.equal((await create({ date: d, startTime: '22:30' }, hall)).status, 201)          // 22:30 -> 01:30 next day
    assert.equal((await create({ date: d, startTime: '23:00', endTime: '23:30' }, hall)).status, 409, 'inside the late slot')
    assert.equal((await create({ date: d2, startTime: '00:30', endTime: '01:00' }, hall)).status, 409, 'next morning inside the same slot')
    assert.equal((await create({ date: d2, startTime: '01:30', endTime: '03:00' }, hall)).status, 201, 'adjacent: starts exactly when the late slot ends')
    assert.equal((await create({ date: d, startTime: '19:00', endTime: '22:30' }, hall)).status, 201, 'adjacent before')
  })
})

describe('editing and the rest of the app with undated / next-day bookings', () => {
  test('add a date and time to an undated booking, then remove them again; schedule fields follow', async () => {
    const b = (await create({})).body.booking
    const put = (o, v) => manager.put(`/api/bookings/${b.id}`, { ...body(out, o), customer: { name: b.customer.name, phone: b.customer.phone }, expectedVersion: v })
    const a = await put({ date: futureDate(90), startTime: '22:00' }, b.version); assert.equal(a.status, 200, JSON.stringify(a.body))
    let d = (await manager.get(`/api/bookings/${b.id}`)).body.booking
    assert.equal(d.date, futureDate(90)); assert.equal(d.endTime, '01:00'); assert.equal(d.endsNextDay, true)
    const c = await put({}, d.version); assert.equal(c.status, 200, JSON.stringify(c.body))
    d = (await manager.get(`/api/bookings/${b.id}`)).body.booking
    assert.equal(d.date, null); assert.equal(d.startTime, null); assert.equal(d.endsNextDay, false)
  })
  test('bill, invoice, receipt, kitchen sheet and messages work for a paid undated booking (no "Invalid Date"/null text)', async () => {
    const r = await manager.post('/api/bookings', body(out, { foodItems: [{ name: 'Idli' }], foodAmount: 1000, advance: { amount: 1000, method: 'Cash', verify: true } }))
    assert.equal(r.status, 201, JSON.stringify(r.body)); const b = r.body.booking
    assert.equal((await staff.req('GET', `/api/bookings/${b.id}/bill.pdf`)).status, 200)
    const kitchen = await staff.get(`/api/meal-menu/booking/${b.id}`); assert.equal(kitchen.status, 200); assert.equal(kitchen.body.date, null); assert.equal(kitchen.body.startTime, null)
    assert.equal((await staff.req('GET', `/api/meal-menu/booking/${b.id}/pdf`)).status, 200)
    const inv = await manager.post(`/api/bookings/${b.id}/invoices/issue`, {}); assert.equal(inv.status, 200, JSON.stringify(inv.body))
    const detail = (await manager.get(`/api/bookings/${b.id}`)).body.booking
    const pid = detail.payments?.[0]?.id; assert.ok(pid, 'payment exists')
    assert.equal((await staff.req('GET', `/api/payments/${pid}/receipt.pdf`)).status, 200)
    const text = JSON.stringify(detail) + JSON.stringify(inv.body)
    assert.ok(!/Invalid Date|NaN/.test(text))
    const msgs = (await query(`SELECT body FROM notification_events WHERE booking_id=$1`, [b.id])).rows.map((x) => x.body || '').join('\n')
    assert.ok(!/Invalid Date|null|NaN/.test(msgs), 'queued messages contain no broken date/time text')
  })
  test('existing timed bookings in the database were not changed by the migration (old rows keep date, times and no next-day flag)', async () => {
    const date = futureDate(95)
    const b = (await create({ date, startTime: '10:00', endTime: '13:00' }, mand)).body.booking
    const db = await row(b.id)
    assert.equal(db.event_date, date); assert.equal(db.start_time.slice(0, 5), '10:00'); assert.equal(db.end_time.slice(0, 5), '13:00'); assert.equal(db.ends_next_day, false)
  })
  test('message text for missing / next-day schedules (templates use "Booking Time: {{start_time}} - {{end_time}}")', async () => {
    const { bookingVars, render } = await import('../server/services/notifications.js')
    const st = { totals: { total: 100000 }, settle: { paidTotal: 0, balance: 100000 } }
    const tpl = 'Event Date: {{event_date}}\nBooking Time: {{start_time}} - {{end_time}}\nTotal'
    const cust = { name: 'C' }
    const none = render(tpl, bookingVars({ reference: 'R', hall_name: 'O', event_type: 'x', event_date: null, start_time: null, end_time: null }, cust, st, {}))
    assert.equal(none, 'Event Date: To be confirmed\nBooking Time: To be confirmed\nTotal')
    const nxt = render(tpl, bookingVars({ reference: 'R', hall_name: 'O', event_type: 'x', event_date: '2027-03-01', start_time: '22:30:00', end_time: '01:30:00', ends_next_day: true }, cust, st, {}))
    assert.match(nxt, /Booking Time: 10:30 PM - 1:30 AM \(next day\)/)
    const normal = render(tpl, bookingVars({ reference: 'R', hall_name: 'O', event_type: 'x', event_date: '2027-03-01', start_time: '10:00:00', end_time: '13:00:00', ends_next_day: false }, cust, st, {}))
    assert.match(normal, /Booking Time: 10:00 AM - 1:00 PM\nTotal/)
  })
})
