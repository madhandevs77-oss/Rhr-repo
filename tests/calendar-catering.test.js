import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { futureDate, setup } from './helpers.js'

let env, admin, staff, optA
before(async () => {
  env = await setup()
  admin = await env.client('admin').login(); staff = await env.client('staff').login()
  optA = (await staff.get('/api/catering/options')).body.options.find((o) => o.code === 'A')
})
after(() => env.teardown())

const mk = (date, extra = {}) => staff.post('/api/catering', {
  customer: { name: 'Cal Caterer', phone: '9600099001', messageConsent: true }, serviceOptionId: optA.id, eventType: 'Party', date,
  deliveryTime: '11:00', servingTime: '12:30', venueName: 'Temple Hall', deliveryAddress: '5 Park Rd, Sulur', plates: 80, pricingMode: 'per_plate', pricePerPlate: 120, taxRate: 0, ...extra })

describe('calendar shows catering orders', () => {
  test('a catering order marks its day and appears in the day view; cancelling removes the mark', async () => {
    const date = futureDate(40)
    const r = await mk(date); assert.equal(r.status, 201, JSON.stringify(r.body))
    const month = (await staff.get(`/api/calendar?month=${date.slice(0, 7)}`)).body
    assert.equal(month.days[date], 1)
    const day = (await staff.get(`/api/calendar/day?date=${date}`)).body
    assert.equal(day.cateringTotal, 1); assert.equal(day.bookingTotal, 0); assert.equal(day.total, 1)
    const o = day.catering[0]
    assert.equal(o.id, r.body.order.id); assert.equal(o.plates, 80); assert.equal(o.deliveryTime, '11:00'); assert.equal(o.servingTime, '12:30')
    assert.equal(o.fulfilment, 'delivery'); assert.equal(o.deliveryAddress, '5 Park Rd, Sulur'); assert.equal(o.customer, 'Cal Caterer')
    assert.equal((await admin.post(`/api/catering/${r.body.order.id}/status`, { to: 'cancelled', reason: 'test' })).status, 200)
    assert.equal((await staff.get(`/api/calendar?month=${date.slice(0, 7)}`)).body.days[date], undefined)
    assert.equal((await staff.get(`/api/calendar/day?date=${date}`)).body.cateringTotal, 0)
  })
  test('pickup shows as takeaway; a hall filter or "Halls only" hides catering orders', async () => {
    const date = futureDate(41)
    assert.equal((await mk(date, { fulfilmentMethod: 'pickup' })).status, 201)
    const day = (await staff.get(`/api/calendar/day?date=${date}`)).body
    assert.equal(day.catering[0].fulfilment, 'takeaway')
    assert.equal((await staff.get(`/api/calendar/day?date=${date}&group=halls`)).body.cateringTotal, 0)
    assert.equal((await staff.get(`/api/calendar?month=${date.slice(0, 7)}&group=halls`)).body.days[date], undefined)
    assert.equal((await staff.get(`/api/calendar?month=${date.slice(0, 7)}&group=outsource`)).body.days[date], 1)
  })
})
