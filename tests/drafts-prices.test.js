// Catering menu + prices, catering orders from the managed menu, and drafts.
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { bookingBody, futureDate, setup } from './helpers.js'

let env, admin, manager, staff, hall, cat, items
before(async () => {
  env = await setup()
  admin = await env.client('admin').login(); manager = await env.client('manager').login(); staff = await env.client('staff').login()
  hall = (await admin.post('/api/halls', { name: 'Draft Hall', basePrice: 7000 })).body.hall
  cat = (await admin.post('/api/meal-menu/categories', { name: 'Snacks' })).body.category
  items = []
  for (const n of ['Samosa', 'Vada', 'Bonda']) items.push((await admin.post('/api/meal-menu/items', { categoryId: cat.id, name: n })).body.item)
})
after(() => env.teardown())

const orderBody = (o = {}) => ({
  serviceOptionId: undefined, customer: { name: 'Cat Cust', phone: '9811111111', messageConsent: true }, eventType: 'Wedding', date: futureDate(20), plates: 50,
  pricingMode: 'item_based', items: [], ...o,
})
let optId
const opt = async () => optId || (optId = (await staff.get('/api/catering/options')).body.options.find((o) => o.active).id)

describe('catering prices', () => {
  test('price is set per Catering Menu item by a manager; staff can read but not set', async () => {
    assert.equal((await staff.put(`/api/catering-prices/${items[0].id}`, { unit: 'plate', unitPrice: 20 })).status, 403)
    assert.equal((await manager.put(`/api/catering-prices/${items[0].id}`, { unit: 'piece', unitPrice: 15 })).status, 200)
    assert.equal((await admin.put(`/api/catering-prices/${items[1].id}`, { unit: 'piece', unitPrice: 10 })).status, 200)
    const p = (await staff.get('/api/catering-prices')).body.prices
    assert.deepEqual(p[items[0].id], { unit: 'piece', unitPrice: 15 })
    assert.equal(p[items[2].id], undefined, 'unpriced item has no row')
    assert.equal((await admin.put('/api/catering-prices/00000000-0000-0000-0000-000000000000', { unit: 'plate', unitPrice: 1 })).status, 404)
    assert.equal((await admin.put(`/api/catering-prices/${items[0].id}`, { unit: 'plate', unitPrice: -5 })).status, 400)
  })
  test('the booking menu endpoint stays price-free', async () => {
    const c = (await staff.get('/api/meal-menu')).body.categories.find((x) => x.name === 'Snacks')
    assert.ok(c.items.every((i) => !('unitPrice' in i) && !('price' in i)))
  })
  test('order lines come from the managed menu: price + unit from Catering Prices, quantity from the user', async () => {
    const r = await staff.post('/api/catering', orderBody({ serviceOptionId: await opt(), items: [{ mealItemId: items[0].id, quantity: 100 }, { mealItemId: items[1].id, quantity: 40 }] }))
    assert.equal(r.status, 201, JSON.stringify(r.body))
    const o = r.body.order
    assert.equal(o.money.subtotal, 100 * 15 + 40 * 10)
    assert.deepEqual(o.items.map((i) => [i.name, i.unit, i.unitPrice, i.quantity]), [['Samosa', 'piece', 15, 100], ['Vada', 'piece', 10, 40]])
    assert.ok(o.items.every((i) => i.mealItemId))
  })
  test('unpriced item: staff blocked, manager can enter a price; staff cannot override a menu price', async () => {
    const base = { serviceOptionId: await opt(), items: [{ mealItemId: items[2].id, quantity: 10 }] }
    const a = await staff.post('/api/catering', orderBody(base))
    assert.equal(a.status, 400); assert.match(JSON.stringify(a.body), /Catering Prices/)
    const b = await staff.post('/api/catering', orderBody({ ...base, items: [{ mealItemId: items[2].id, quantity: 10, unitPrice: 5 }] }))
    assert.equal(b.status, 403)
    const c = await manager.post('/api/catering', orderBody({ ...base, items: [{ mealItemId: items[2].id, quantity: 10, unitPrice: 5 }] }))
    assert.equal(c.status, 201, JSON.stringify(c.body)); assert.equal(c.body.order.money.subtotal, 50)
    const d = await staff.post('/api/catering', orderBody({ serviceOptionId: await opt(), items: [{ mealItemId: items[0].id, quantity: 1, unitPrice: 1 }] }))
    assert.equal(d.status, 403)
  })
  test('deactivated items and categories cannot be added to new orders; an order that already has the item can still be edited', async () => {
    const r = await staff.post('/api/catering', orderBody({ serviceOptionId: await opt(), items: [{ mealItemId: items[1].id, quantity: 5 }] }))
    const o = r.body.order
    await admin.put(`/api/meal-menu/items/${items[1].id}`, { categoryId: cat.id, name: 'Vada', active: false })
    assert.equal((await staff.post('/api/catering', orderBody({ serviceOptionId: await opt(), items: [{ mealItemId: items[1].id, quantity: 5 }] }))).status, 400)
    const edit = await staff.put(`/api/catering/${o.id}`, { ...orderBody({ serviceOptionId: await opt(), items: [{ mealItemId: items[1].id, quantity: 8 }] }), expectedVersion: o.version })
    assert.equal(edit.status, 200, JSON.stringify(edit.body))
    const listed = (await staff.get('/api/meal-menu')).body.categories.find((x) => x.name === 'Snacks').items.map((i) => i.name)
    assert.ok(!listed.includes('Vada'), 'inactive item hidden from the active menu list')
  })
  test('deleting a menu item removes its price but keeps old orders readable (name/unit/price are frozen on the order)', async () => {
    const tmp = (await admin.post('/api/meal-menu/items', { categoryId: cat.id, name: 'Temp Sweet' })).body.item
    await admin.put(`/api/catering-prices/${tmp.id}`, { unit: 'kg', unitPrice: 300 })
    const o = (await staff.post('/api/catering', orderBody({ serviceOptionId: await opt(), items: [{ mealItemId: tmp.id, quantity: 2 }] }))).body.order
    assert.equal((await admin.del(`/api/meal-menu/items/${tmp.id}`)).status, 200)
    assert.equal((await staff.get('/api/catering-prices')).body.prices[tmp.id], undefined)
    const again = (await staff.get(`/api/catering/${o.id}`)).body.order
    assert.deepEqual(again.items.map((i) => [i.name, i.unit, i.unitPrice, i.mealItemId]), [['Temp Sweet', 'kg', 300, null]])
  })
})

describe('drafts', () => {
  const dbody = (o = {}) => ({ kind: 'booking', hallId: hall.id, customerName: 'Half Done', data: { f: { name: 'Half Done', phone: '98' }, selected: [] }, ...o })
  let d1
  test('save a half-filled booking as a draft: no booking is created, no date is blocked', async () => {
    const r = await staff.post('/api/drafts', dbody())
    assert.equal(r.status, 201, JSON.stringify(r.body))
    d1 = r.body.draft
    assert.equal(d1.category, 'Hall'); assert.equal(d1.hallName, 'Draft Hall'); assert.equal(d1.customerName, 'Half Done'); assert.equal(d1.status, 'draft')
    assert.equal((await staff.get('/api/bookings')).body.bookings.length, 0)
    assert.equal((await staff.get('/api/calendar?month=' + futureDate(5).slice(0, 7))).body.days[futureDate(5)], undefined)
  })
  test('outsource and catering drafts are labelled; list is newest first; contents come back exactly', async () => {
    const out = (await admin.get('/api/sections')).body.sections.find((s) => s.kind === 'outsource')
    const o = await staff.post('/api/drafts', dbody({ hallId: out.id, customerName: '' }))
    assert.equal(o.body.draft.category, 'Outsource')
    const c = await staff.post('/api/drafts', { kind: 'catering', customerName: 'Cat', data: { f: { plates: 120 } } })
    assert.equal(c.body.draft.category, 'Catering')
    const list = (await staff.get('/api/drafts')).body.drafts
    assert.deepEqual(list.map((x) => x.category), ['Catering', 'Outsource', 'Hall'])
    const got = (await staff.get(`/api/drafts/${d1.id}`)).body
    assert.deepEqual(got.data, { f: { name: 'Half Done', phone: '98' }, selected: [] })
  })
  test('update keeps one draft (no duplicates) and bumps the saved time', async () => {
    const r = await staff.put(`/api/drafts/${d1.id}`, dbody({ data: { f: { name: 'Half Done', phone: '9876543210' } } }))
    assert.equal(r.status, 200)
    assert.equal((await staff.get('/api/drafts')).body.drafts.length, 3)
    assert.equal((await staff.get(`/api/drafts/${d1.id}`)).body.data.f.phone, '9876543210')
    assert.ok(new Date(r.body.draft.updatedAt) >= new Date(d1.updatedAt))
  })
  test('submitting a draft creates the real booking and removes only that draft', async () => {
    const r = await staff.post('/api/bookings', { ...bookingBody(hall.id, { date: futureDate(33), hallCharge: 7000 }), draftId: d1.id })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal((await staff.get(`/api/drafts/${d1.id}`)).status, 404)
    assert.equal((await staff.get('/api/drafts')).body.drafts.length, 2)
    assert.equal((await staff.get('/api/bookings')).body.bookings.length, 1)
  })
  test('a failed submit (e.g. clash) keeps the draft', async () => {
    const d = (await staff.post('/api/drafts', dbody())).body.draft
    const bad = await staff.post('/api/bookings', { ...bookingBody(hall.id, { date: futureDate(33), hallCharge: 7000 }), draftId: d.id })
    assert.equal(bad.status, 409)
    assert.equal((await staff.get(`/api/drafts/${d.id}`)).status, 200)
    await staff.del(`/api/drafts/${d.id}`)
  })
  test('catering draft is consumed by creating the order', async () => {
    const cd = (await staff.get('/api/drafts')).body.drafts.find((x) => x.category === 'Catering')
    const r = await staff.post('/api/catering', { ...orderBody({ serviceOptionId: await opt(), items: [{ mealItemId: items[0].id, quantity: 2 }] }), draftId: cd.id })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal((await staff.get(`/api/drafts/${cd.id}`)).status, 404)
  })
  test('delete removes only the chosen draft; others cannot delete it unless manager; unknown id is 404; oversized data is rejected', async () => {
    const mine = (await staff.post('/api/drafts', dbody({ customerName: 'Mine' }))).body.draft
    const other = (await staff.get('/api/drafts')).body.drafts.find((x) => x.id !== mine.id)
    const staff2 = await env.client('staff2').login()
    assert.equal((await staff2.del(`/api/drafts/${mine.id}`)).status, 403)
    assert.equal((await staff.del(`/api/drafts/${mine.id}`)).status, 200)
    assert.equal((await manager.del(`/api/drafts/${other.id}`)).status, 200)
    assert.equal((await staff.del(`/api/drafts/${mine.id}`)).status, 404)
    assert.equal((await staff.get('/api/drafts/not-an-id')).status, 404)
    const huge = await staff.post('/api/drafts', dbody({ data: { blob: 'x'.repeat(450000) } }))
    assert.ok(huge.status >= 400, 'oversized draft rejected')
  })
})

describe('data export covers the new tables', () => {
  test('menu categories, items, catering prices, payment splits and drafts are in the JSON export', async () => {
    const r = await admin.get('/api/admin/export')
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200))
    for (const t of ['menu_categories', 'meal_menu_items', 'catering_prices', 'payment_splits', 'drafts']) assert.ok(Array.isArray(r.body.tables[t]), `export missing ${t}`)
    assert.ok(r.body.tables.catering_prices.length >= 2)
  })
})
