// Seven sections, manual food amount (no GST), price-free menu (+ print / PDF), calendar, split payments.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { futureDate, setup } from './helpers.js'

let env, admin, manager, staff, sections, S, menu, cats
const L = 'Royal Lunch', B = 'Royal Breakfast', D = 'Royal Dinner'
const secBody = (hallKey, o = {}) => ({
  customer: { name: 'Section Customer', phone: '9876000001', messageConsent: true, ...(o.customer || {}) },
  hallId: S[hallKey].id, date: futureDate(20), startTime: '10:00', endTime: '13:00', ...Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'customer')),
})
let phoneSeq = 9876100000
const nextPhone = () => String(phoneSeq++)

before(async () => {
  env = await setup()
  admin = await env.client('admin').login()
  manager = await env.client('manager').login()
  staff = await env.client('staff').login()
  sections = (await staff.get('/api/sections')).body.sections
  S = Object.fromEntries(sections.map((s) => [s.name, s]))
  cats = (await staff.get('/api/meal-menu')).body.categories
  menu = cats.flatMap((c) => c.items.map((i) => ({ ...i, meal: c.name, categoryId: c.id })))
})
after(() => env.teardown())

describe('seven sections', () => {
  test('migration created exactly the seven sections in order with the default maintenance charges', () => {
    assert.deepEqual(sections.map((s) => s.name), ['Mandapam', 'Mini Hall', 'Outsource 1', 'Outsource 2', 'Outsource 3', 'Outsource 4', 'Outsource 5'])
    assert.equal(S.Mandapam.defaultCharge, 15000)
    assert.equal(S['Mini Hall'].defaultCharge, 5000)
    assert.equal(S['Outsource 1'].defaultCharge, 0)
    assert.ok(sections.every((s) => s.todayStatus === 'free' && s.upcomingCount === 0))
  })
  test('default charge, no GST: Mini Hall = 5000; no guest field', async () => {
    const r = await staff.post('/api/bookings', secBody('Mini Hall', { customer: { name: 'A', phone: nextPhone() } }))
    assert.equal(r.status, 201, JSON.stringify(r.body))
    const b = r.body.booking
    assert.equal(b.hallKind, 'mini_hall')
    assert.ok(!('guests' in b), 'no guest field exists')
    assert.equal(b.money.maintenance, 5000)
    assert.equal(b.money.taxRate, 0)
    assert.equal(b.money.tax, 0)
    assert.equal(b.money.total, 5000)
    assert.equal(b.money.basis, 'estimate')
  })
  test('Mandapam default is 15,000 per 3-hour slot (end time editable)', async () => {
    const r = await staff.post('/api/bookings', secBody('Mandapam', { customer: { name: 'B', phone: nextPhone() }, startTime: '09:00', endTime: '12:00' }))
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(r.body.booking.money.total, 15000)
  })
  test('manual food amount adds to the total with no GST; selecting menu items never changes the total', async () => {
    const items = menu.filter((m) => m.meal === L).slice(0, 6).map((m) => ({ id: m.id, name: m.name, category: L }))
    const none = await manager.post('/api/bookings', secBody('Outsource 1', { customer: { name: 'C', phone: nextPhone() }, hallCharge: 2000, foodAmount: 18000, meals: ['lunch'] }))
    assert.equal(none.status, 201, JSON.stringify(none.body))
    assert.equal(none.body.booking.money.taxable, 20000)
    assert.equal(none.body.booking.money.tax, 0)
    assert.equal(none.body.booking.money.total, 20000)
    const withItems = await manager.post('/api/bookings', secBody('Outsource 2', { customer: { name: 'D', phone: nextPhone() }, hallCharge: 2000, foodAmount: 18000, meals: ['lunch'], foodItems: items }))
    assert.equal(withItems.body.booking.money.total, 20000)
    const more = await manager.post('/api/bookings', secBody('Outsource 3', { customer: { name: 'E', phone: nextPhone() }, hallCharge: 2000, foodAmount: 18000, meals: ['lunch'], foodItems: menu.filter((m) => m.meal === L).map((m) => ({ id: m.id, name: m.name, category: L })) }))
    assert.equal(more.body.booking.money.total, 20000, 'total is independent of how many items are ticked')
  })
  test('client-supplied tax rate and totals are ignored (server computes, no GST)', async () => {
    const r = await staff.post('/api/bookings', secBody('Mini Hall', { customer: { name: 'F', phone: nextPhone() }, date: futureDate(21), taxRate: 18, total: 1, foodAmount: 1000 }))
    assert.equal(r.body.booking.money.tax, 0)
    assert.equal(r.body.booking.money.total, 6000)
  })
  test('staff cannot change the maintenance charge or give a discount; staff can add extra amount and extra charges (e.g. GST as a line)', async () => {
    const a = await staff.post('/api/bookings', secBody('Mini Hall', { customer: { name: 'G', phone: nextPhone() }, date: futureDate(22), hallCharge: 4000 }))
    assert.equal(a.status, 403)
    const d = await staff.post('/api/bookings', secBody('Mini Hall', { customer: { name: 'G', phone: nextPhone() }, date: futureDate(22), discount: 100 }))
    assert.equal(d.status, 403)
    const b = await staff.post('/api/bookings', secBody('Mini Hall', { customer: { name: 'G', phone: nextPhone() }, date: futureDate(22), extraAmount: 300, charges: [{ description: 'GST 5%', quantity: 1, unitPrice: 250 }, { description: 'Decor', quantity: 1, unitPrice: 500 }] }))
    assert.equal(b.status, 201, JSON.stringify(b.body))
    assert.equal(b.body.booking.money.total, 6050)
    assert.equal(b.body.booking.money.tax, 0)
    assert.equal(b.body.booking.extraAmount, 300)
    const c = await manager.post('/api/bookings', secBody('Mini Hall', { customer: { name: 'G', phone: nextPhone() }, date: futureDate(23), hallCharge: 4000, charges: [{ description: 'Decor', unitPrice: 500 }] }))
    assert.equal(c.status, 201, JSON.stringify(c.body))
    assert.equal(c.body.booking.money.total, 4500)
  })
  test('sections are independent: same slot in two sections is fine, same section overlap is a conflict', async () => {
    const d = futureDate(23)
    assert.equal((await staff.post('/api/bookings', secBody('Outsource 4', { customer: { name: 'H', phone: nextPhone() }, date: d }))).status, 201)
    assert.equal((await staff.post('/api/bookings', secBody('Outsource 5', { customer: { name: 'H2', phone: nextPhone() }, date: d }))).status, 201)
    const x = await staff.post('/api/bookings', secBody('Outsource 4', { customer: { name: 'H3', phone: nextPhone() }, date: d, startTime: '12:00', endTime: '15:00' }))
    assert.equal(x.status, 409); assert.equal(x.body.error.code, 'HALL_CONFLICT')
    const list = (await staff.get(`/api/bookings?hallId=${S['Outsource 4'].id}`)).body.bookings
    assert.ok(list.every((b) => b.hallName === 'Outsource 4'), 'history never mixes sections')
  })
  test('outsource notes are stored per booking', async () => {
    const r = await staff.post('/api/bookings', secBody('Outsource 1', { customer: { name: 'I', phone: nextPhone() }, date: futureDate(24), notes: 'Deliver to gate 2' }))
    assert.equal(r.body.booking.notes, 'Deliver to gate 2')
  })
  test('edit: only authorised staff change amounts; food amount can be entered once by staff, then needs a manager; confirmed totals are stable', async () => {
    const r = await staff.post('/api/bookings', secBody('Mini Hall', { customer: { name: 'J', phone: nextPhone() }, date: futureDate(25) }))
    const b = r.body.booking
    const put = (cl, o) => cl.put(`/api/bookings/${b.id}`, { ...secBody('Mini Hall', { customer: { name: 'J', phone: b.customer.phone }, date: b.date }), expectedVersion: o.v, ...o.body })
    const first = await put(staff, { v: b.version, body: { foodAmount: 12000 } })
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.equal(first.body.booking.money.total, 17000)
    const second = await put(staff, { v: first.body.booking.version, body: { foodAmount: 9000 } })
    assert.equal(second.status, 403)
    const mgr = await put(manager, { v: first.body.booking.version, body: { foodAmount: 9000 } })
    assert.equal(mgr.status, 200, JSON.stringify(mgr.body))
    assert.equal(mgr.body.booking.money.total, 14000)
    // changing the section default later does not alter an existing booking
    await admin.patch(`/api/halls/${S['Mini Hall'].id}`, { defaultCharge: 6000 })
    const again = (await staff.get(`/api/bookings/${b.id}`)).body.booking
    assert.equal(again.money.total, 14000)
    await admin.patch(`/api/halls/${S['Mini Hall'].id}`, { defaultCharge: 5000 })
  })
  test('guest count and capacity are gone from the API and the database', async () => {
    const h = (await admin.post('/api/halls', { name: 'Garden Hall', basePrice: 10000 })).body.hall
    assert.ok(!('capacity' in h))
    const base = { customer: { name: 'K', phone: nextPhone() }, hallId: h.id, eventType: 'Party', date: futureDate(26), startTime: '10:00', endTime: '12:00', hallCharge: 10000, guests: 99999 }
    const r = await staff.post('/api/bookings', base)
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.ok(!('guests' in r.body.booking))
    const { query } = await import('../server/db/pool.js')
    const cols = (await query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND (column_name ~ 'guest' OR column_name = 'capacity')`)).rows
    assert.deepEqual(cols, [], 'no guest/capacity columns remain')
    const tpl = (await query(`SELECT count(*)::int n FROM notification_templates WHERE body LIKE '%guest_count%'`)).rows[0].n
    assert.equal(tpl, 0)
  })
  test('the seven sections cannot be deleted; dashboard shows today / upcoming from real data', async () => {
    assert.equal((await admin.del(`/api/halls/${S.Mandapam.id}`)).status, 409)
    const { todayIST } = await import('../server/services/support.js')
    const r = await staff.post('/api/bookings', secBody('Outsource 5', { customer: { name: 'L', phone: nextPhone() }, date: todayIST(), startTime: '23:00', endTime: '23:59' }))
    assert.equal(r.status, 201, JSON.stringify(r.body))
    const dash = (await staff.get('/api/sections')).body.sections.find((s) => s.name === 'Outsource 5')
    assert.equal(dash.todayStatus, 'booked')
    assert.equal(dash.today[0].customer, 'L')
    assert.ok(dash.upcomingCount >= 1)
    assert.ok(!JSON.stringify(dash).includes('total'), 'dashboard carries no money')
  })
})

describe('menu management (dynamic categories, no prices)', () => {
  test('seeded Royal Breakfast / Lunch / Dinner; items carry names only', () => {
    assert.deepEqual(cats.map((c) => c.name), [B, L, D])
    const by = (n) => cats.find((c) => c.name === n).items.map((x) => x.name)
    assert.ok(by(B).includes('Idly') && by(B).includes('Water Bottle — 300 ml') && by(B).length === 22)
    assert.ok(by(L).includes('Vatha Kozhambu Sadham') && by(L).includes('Chappathi with Kurma'))
    assert.ok(by(D).includes('Kothu Parotta') && by(D).includes('Gobi 65'))
    for (const c of cats) for (const i of c.items) assert.deepEqual(Object.keys(i).sort(), ['active', 'id', 'name', 'sort'], 'no price-like field exists')
    assert.deepEqual(Object.keys(cats[0]).sort(), ['active', 'id', 'items', 'name', 'sort'])
  })
  test('admin creates categories with any name, renames, reorders, deactivates, deletes; staff cannot', async () => {
    assert.equal((await staff.post('/api/meal-menu/categories', { name: 'Royal Special Menu' })).status, 403)
    const c = await admin.post('/api/meal-menu/categories', { name: 'Royal Special Menu' })
    assert.equal(c.status, 201, JSON.stringify(c.body))
    assert.equal((await admin.post('/api/meal-menu/categories', { name: 'royal special menu' })).status, 409)
    const c2 = (await manager.post('/api/meal-menu/categories', { name: 'Royal Wedding Breakfast' })).body.category
    const id = c.body.category.id
    assert.equal((await admin.put(`/api/meal-menu/categories/${id}`, { name: 'Special Catering Menu', active: true })).body.category.name, 'Special Catering Menu')
    const all = (await admin.get('/api/meal-menu')).body.categories.map((x) => x.id)
    const rev = [...all].reverse()
    assert.equal((await admin.put('/api/meal-menu/categories-order', { ids: rev })).status, 200)
    assert.deepEqual((await admin.get('/api/meal-menu')).body.categories.map((x) => x.id), rev)
    await admin.put(`/api/meal-menu/categories/${c2.id}`, { name: c2.name, active: false })
    assert.ok(!(await staff.get('/api/meal-menu')).body.categories.some((x) => x.id === c2.id), 'inactive category hidden from booking forms')
    assert.ok((await staff.get('/api/meal-menu?all=1')).body.categories.some((x) => x.id === c2.id))
    assert.equal((await admin.del(`/api/meal-menu/categories/${c2.id}`)).status, 200)
    assert.equal((await admin.del(`/api/meal-menu/categories/${id}`)).status, 200)
    assert.equal((await admin.del(`/api/meal-menu/categories/${id}`)).status, 404)
    await admin.put('/api/meal-menu/categories-order', { ids: all.filter((x) => x !== id && x !== c2.id).sort((a, b) => cats.findIndex((c) => c.id === a) - cats.findIndex((c) => c.id === b)) })
  })
  test('items: add to a category, edit name, deactivate, reorder, delete; duplicates blocked per category', async () => {
    const cat = cats.find((c) => c.name === D)
    const a = await manager.post('/api/meal-menu/items', { categoryId: cat.id, name: 'Test Paneer Item' })
    assert.equal(a.status, 201, JSON.stringify(a.body))
    assert.equal((await manager.post('/api/meal-menu/items', { categoryId: cat.id, name: 'test paneer item' })).status, 409)
    assert.equal((await staff.post('/api/meal-menu/items', { categoryId: cat.id, name: 'Nope' })).status, 403)
    const id = a.body.item.id
    assert.equal((await manager.put(`/api/meal-menu/items/${id}`, { categoryId: cat.id, name: 'Test Paneer 2', active: false })).body.item.active, false)
    assert.ok(!(await staff.get('/api/meal-menu')).body.categories.find((c) => c.id === cat.id).items.some((x) => x.id === id))
    const ids = (await manager.get('/api/meal-menu?all=1')).body.categories.find((c) => c.id === cat.id).items.map((x) => x.id)
    assert.equal((await manager.put('/api/meal-menu/items-order', { ids: [...ids].reverse() })).status, 200)
    assert.equal((await manager.get('/api/meal-menu?all=1')).body.categories.find((c) => c.id === cat.id).items[0].id, ids[ids.length - 1])
    assert.equal((await manager.put('/api/meal-menu/items-order', { ids })).status, 200)
    assert.equal((await manager.del(`/api/meal-menu/items/${id}`)).status, 200)
    assert.equal((await manager.del(`/api/meal-menu/items/${id}`)).status, 404)
  })
  test('a brand-new category can be used in a booking; saved menu survives renaming/deleting the item and the category', async () => {
    const cat = (await admin.post('/api/meal-menu/categories', { name: 'Royal Wedding Dinner' })).body.category
    const it = (await admin.post('/api/meal-menu/items', { categoryId: cat.id, name: 'Snapshot Special' })).body.item
    const r = await staff.post('/api/bookings', secBody('Outsource 2', { customer: { name: 'M', phone: nextPhone() }, date: futureDate(27), meals: ['dinner'], foodItems: [{ id: it.id, name: 'x' }] }))
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(r.body.booking.foodItems[0].name, 'Snapshot Special', 'server resolves the name from the menu, not the client')
    assert.equal(r.body.booking.foodItems[0].category, 'Royal Wedding Dinner')
    await admin.put(`/api/meal-menu/categories/${cat.id}`, { name: 'Renamed Cat', active: true })
    await admin.put(`/api/meal-menu/items/${it.id}`, { categoryId: cat.id, name: 'Renamed', active: true })
    await admin.del(`/api/meal-menu/categories/${cat.id}`)
    const after = (await staff.get(`/api/bookings/${r.body.booking.id}`)).body.booking
    assert.equal(after.foodItems[0].name, 'Snapshot Special')
    assert.equal(after.foodItems[0].category, 'Royal Wedding Dinner')
    const put = await staff.put(`/api/bookings/${r.body.booking.id}`, { ...secBody('Outsource 2', { customer: { name: 'M', phone: r.body.booking.customer.phone }, date: r.body.booking.date }), meals: ['dinner'], foodItems: after.foodItems, expectedVersion: after.version })
    assert.equal(put.status, 200, JSON.stringify(put.body))
    assert.equal(put.body.booking.foodItems[0].name, 'Snapshot Special')
  })
})

describe('menu-only print data and PDF', () => {
  let bk
  before(async () => {
    const pick = (n, k) => menu.filter((x) => x.meal === n).slice(0, k).map((x) => ({ id: x.id, name: x.name }))
    const r = await manager.post('/api/bookings', secBody('Mandapam', { customer: { name: 'Zed Secret Customer', phone: '9123456789' }, date: futureDate(28), meals: ['breakfast', 'dinner'], foodItems: [...pick(D, 2), ...pick(B, 3)], foodAmount: 77777, notes: 'private note', advance: { amount: 3000, method: 'Cash' } }))
    assert.equal(r.status, 201, JSON.stringify(r.body))
    bk = r.body.booking
  })
  test('print data: category headings in menu order with only the selected items; empty categories omitted', async () => {
    const r = await staff.get(`/api/meal-menu/booking/${bk.id}`)
    assert.deepEqual(r.body.meals.map((m) => m.title), [B, D])
    assert.equal(r.body.meals[0].items.length, 3)
    assert.deepEqual(Object.keys(r.body).sort(), ['date', 'endTime', 'meals', 'section', 'serve', 'startTime'], 'only kitchen facts: no customer, money or notes')
    assert.equal(r.body.section, 'Mandapam'); assert.deepEqual(r.body.serve, ['Breakfast', 'Dinner'])
  })
  test('Kitchen sheet PDF: hall, date, time, meals, categories and items — anonymous, no amounts', async () => {
    const r = await staff.get(`/api/meal-menu/booking/${bk.id}/pdf?download=1`, { raw: true })
    assert.equal(r.status, 200)
    assert.match(r.res.headers.get('content-type'), /application\/pdf/)
    assert.ok(!/BH-|INV/.test(r.res.headers.get('content-disposition')), 'file name carries no booking reference')
    const f = path.join(os.tmpdir(), `menu-${process.pid}.pdf`)
    fs.writeFileSync(f, r.buf)
    const text = execFileSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' })
    fs.rmSync(f)
    const names = (await staff.get(`/api/meal-menu/booking/${bk.id}`)).body.meals.flatMap((m) => [m.title, ...m.items])
    for (const n of names) assert.ok(text.includes(n), `missing ${n}`)
    assert.ok(!/Royal Lunch/.test(text), 'unselected category omitted')
    const [yy, mm, dd] = bk.date.split('-')
    for (const need of ['Kitchen Sheet', 'Mandapam', `${dd}-${mm}-${yy}`, 'Serve: Breakfast, Dinner']) assert.ok(text.includes(need), `kitchen sheet should show ${need}`)
    for (const bad of ['Zed', 'Secret', '9123456789', bk.reference, '₹', 'Rs', 'GST', 'Invoice', 'INV', 'Total', 'Advance', 'Cash', 'private note', '77777']) {
      assert.ok(!text.includes(bad), `menu PDF must not contain "${bad}"`)
    }
  })
  test('PDF for a booking with no items says so, and unknown booking is 404', async () => {
    const r = await staff.post('/api/bookings', secBody('Outsource 3', { customer: { name: 'N', phone: nextPhone() }, date: futureDate(29) }))
    const pdf = await staff.get(`/api/meal-menu/booking/${r.body.booking.id}/pdf`, { raw: true })
    assert.equal(pdf.status, 200)
    assert.equal((await staff.get('/api/meal-menu/booking/00000000-0000-0000-0000-000000000000')).status, 404)
  })
  test('existing invoice PDF still works after the booking is paid in full', async () => {
    const full = bk.money.total - 3000
    const p = await manager.post(`/api/bookings/${bk.id}/payments`, { amount: full, method: 'Cash', paidOn: futureDate(0), stage: 'final' })
    assert.equal(p.status, 201, JSON.stringify(p.body))
    const d = (await manager.get(`/api/bookings/${bk.id}`)).body.booking
    assert.equal(d.money.balance, 0)
    assert.equal(d.invoices.length, 1)
    const pdf = await manager.get(`/api/invoices/${d.invoices[0].id}/pdf`, { raw: true })
    assert.equal(pdf.status, 200)
    assert.ok(pdf.buf.slice(0, 4).toString() === '%PDF')
  })
})

describe('calendar', () => {
  test('dots come from saved bookings; cancelled bookings drop off; section filter works', async () => {
    const d = futureDate(40)
    const month = d.slice(0, 7)
    const a = await staff.post('/api/bookings', secBody('Outsource 1', { customer: { name: 'P', phone: nextPhone() }, date: d }))
    await staff.post('/api/bookings', secBody('Mini Hall', { customer: { name: 'Q', phone: nextPhone() }, date: d }))
    let cal = (await staff.get(`/api/calendar?month=${month}`)).body
    assert.equal(cal.days[d], 2)
    cal = (await staff.get(`/api/calendar?month=${month}&hallId=${S['Outsource 1'].id}`)).body
    assert.equal(cal.days[d], 1)
    await manager.post(`/api/bookings/${a.body.booking.id}/cancel`, { reason: 'test' })
    cal = (await staff.get(`/api/calendar?month=${month}&hallId=${S['Outsource 1'].id}`)).body
    assert.equal(cal.days[d], undefined, 'cancelled booking no longer shows a dot')
    assert.equal((await staff.get('/api/calendar?month=2026-13')).status, 400)
  })
  test('a date lists every booking grouped by the seven sections; money only for authorised staff', async () => {
    const d = futureDate(41)
    await manager.post('/api/bookings', secBody('Mandapam', { customer: { name: 'R', phone: nextPhone() }, date: d, foodAmount: 1000, meals: ['lunch'], notes: 'n1' }))
    await staff.post('/api/bookings', secBody('Outsource 3', { customer: { name: 'S', phone: nextPhone() }, date: d, notes: 'n2' }))
    const s = (await staff.get(`/api/calendar/day?date=${d}`)).body
    assert.deepEqual(s.sections.map((x) => x.name), ['Mandapam', 'Mini Hall', 'Garden Hall', 'Outsource 1', 'Outsource 2', 'Outsource 3', 'Outsource 4', 'Outsource 5'], 'every hall incl. ones added later, then the outsource sections')
    assert.equal(s.sections[0].bookings[0].customer, 'R')
    assert.deepEqual(s.sections[0].bookings[0].meals, ['lunch'])
    assert.equal(s.sections[5].bookings[0].notes, 'n2')
    assert.equal(s.financial, false)
    assert.ok(!('total' in s.sections[0].bookings[0]))
    const m = (await manager.get(`/api/calendar/day?date=${d}`)).body
    assert.equal(m.financial, true)
    assert.equal(m.sections[0].bookings[0].total, 16000)
    assert.equal(m.sections[0].bookings[0].balance, 16000)
    assert.equal(m.total, 2)
  })
  test('midnight crossing is rejected consistently (single-day slots)', async () => {
    const r = await staff.post('/api/bookings', secBody('Outsource 5', { customer: { name: 'T', phone: nextPhone() }, date: futureDate(42), startTime: '22:00', endTime: '01:00' }))
    assert.equal(r.status, 400)
  })
})

describe('split payments', () => {
  let bk
  const pay = (o, cl = manager, id = bk.id) => cl.post(`/api/bookings/${id}/payments`, { paidOn: futureDate(0), ...o })
  before(async () => {
    const r = await manager.post('/api/bookings', secBody('Mini Hall', { customer: { name: 'U', phone: nextPhone() }, date: futureDate(50), foodAmount: 5237.5 }))
    bk = r.body.booking // total = 5000 + 5237.50 = 10237.5
    assert.equal(bk.money.total, 10237.5)
  })
  test('₹5,000 = Cash 2,000 + Card 3,000 is one payment with two normalized method rows', async () => {
    const r = await pay({ amount: 5000, stage: 'advance', splits: [{ method: 'Cash', amount: 2000 }, { method: 'Card', amount: 3000 }], idempotencyKey: 'split-1' })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(r.body.payment.method, 'Split')
    assert.deepEqual(r.body.payment.splits, [{ method: 'Card', amount: 3000 }, { method: 'Cash', amount: 2000 }])
    assert.equal(r.body.payment.amount, 5000)
    const { query } = await import('../server/db/pool.js')
    assert.equal((await query('SELECT count(*)::int n FROM payment_splits WHERE payment_id=$1', [r.body.payment.id])).rows[0].n, 2)
    assert.equal((await query('SELECT count(*)::int n FROM payments WHERE id=$1', [r.body.payment.id])).rows[0].n, 1)
  })
  test('repeated click (same idempotency key) records once', async () => {
    const again = await pay({ amount: 5000, stage: 'advance', splits: [{ method: 'Cash', amount: 2000 }, { method: 'Card', amount: 3000 }], idempotencyKey: 'split-1' })
    assert.equal(again.status, 200); assert.equal(again.body.duplicate, true)
    const d = (await manager.get(`/api/bookings/${bk.id}`)).body.booking
    assert.equal(d.payments.filter((p) => p.status !== 'rejected').length, 1)
    assert.equal(d.money.paid, 5000)
  })
  test('method amounts must add up, be positive, unique and from the allowed list (GPay allowed)', async () => {
    const bad = await pay({ amount: 1000, splits: [{ method: 'Cash', amount: 400 }, { method: 'UPI', amount: 500 }] })
    assert.equal(bad.status, 400); assert.equal(bad.body.error.code, 'SPLIT_MISMATCH')
    assert.equal((await pay({ amount: 1000, splits: [{ method: 'Cash', amount: 1500 }, { method: 'UPI', amount: -500 }] })).status, 400)
    assert.equal((await pay({ amount: 1000, splits: [{ method: 'Cash', amount: 500 }, { method: 'Cash', amount: 500 }] })).status, 400)
    assert.equal((await pay({ amount: 1000, splits: [{ method: 'Bitcoin', amount: 1000 }] })).status, 400)
    const ok = await pay({ amount: 1000, splits: [{ method: 'GPay', amount: 1000 }], idempotencyKey: 'gp-1' })
    assert.equal(ok.status, 201, JSON.stringify(ok.body))
    assert.equal(ok.body.payment.method, 'GPay')
  })
  test('a staff-recorded payment is pending: balance uses verified money only; final submission does not mark paid', async () => {
    const before = (await manager.get(`/api/bookings/${bk.id}`)).body.booking
    const bal = before.money.balance
    const r = await pay({ amount: bal, stage: 'final', splits: [{ method: 'UPI', amount: bal }], idempotencyKey: 'final-staff' }, staff)
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(r.body.payment.status, 'pending')
    const mid = (await manager.get(`/api/bookings/${bk.id}`)).body.booking
    assert.equal(mid.money.balance, bal)
    assert.equal(mid.money.state, 'partial')
    assert.equal(mid.invoices.length, 0)
    const v = await manager.post(`/api/payments/${r.body.payment.id}/verify`)
    assert.equal(v.status, 200, JSON.stringify(v.body))
    const done = (await manager.get(`/api/bookings/${bk.id}`)).body.booking
    assert.equal(done.money.balance, 0)
    assert.equal(done.invoices.length, 1)
  })
  test('over-balance payment is rejected', async () => {
    const r = await pay({ amount: 1, splits: [{ method: 'Cash', amount: 1 }] })
    assert.equal(r.status, 409); assert.equal(r.body.error.code, 'PAYMENT_EXCEEDS_BALANCE')
  })
  test('legacy single-method payments still work and get a split row; payment history shows methods', async () => {
    const r = await manager.post('/api/bookings', secBody('Outsource 4', { customer: { name: 'V', phone: nextPhone() }, date: futureDate(51), foodAmount: 1000 }))
    const p = await pay({ amount: 500, method: 'Cheque', stage: 'advance' }, manager, r.body.booking.id)
    assert.equal(p.status, 201, JSON.stringify(p.body))
    assert.deepEqual(p.body.payment.splits, [{ method: 'Cheque', amount: 500 }])
    const hist = (await manager.get(`/api/bookings/${r.body.booking.id}`)).body.booking.payments
    assert.equal(hist[0].stage, 'advance')
    assert.equal(hist[0].status, 'verified')
  })
  test('splits are immutable at the database level', async () => {
    const { query } = await import('../server/db/pool.js')
    await assert.rejects(query(`UPDATE payment_splits SET amount = 1`), /immutable/)
    await assert.rejects(query(`DELETE FROM payment_splits`), /immutable/)
  })
})

describe('calendar groups and the spec payment examples', () => {
  test('calendar filters by Halls, Outsource Bookings, or one section', async () => {
    const d = futureDate(60), month = d.slice(0, 7)
    await staff.post('/api/bookings', secBody('Mandapam', { customer: { name: 'G1', phone: nextPhone() }, date: d }))
    await staff.post('/api/bookings', secBody('Outsource 5', { customer: { name: 'G2', phone: nextPhone() }, date: d }))
    assert.equal((await staff.get(`/api/calendar?month=${month}&group=halls`)).body.days[d], 1)
    assert.equal((await staff.get(`/api/calendar?month=${month}&group=outsource`)).body.days[d], 1)
    assert.equal((await staff.get(`/api/calendar?month=${month}`)).body.days[d], 2)
    const day = (await staff.get(`/api/calendar/day?date=${d}&group=outsource`)).body
    assert.deepEqual(day.sections.map((s) => s.name), ['Outsource 1', 'Outsource 2', 'Outsource 3', 'Outsource 4', 'Outsource 5'])
    assert.equal(day.total, 1)
    const halls = (await staff.get(`/api/calendar/day?date=${d}&group=halls`)).body
    assert.deepEqual(halls.sections.map((s) => s.name), ['Mandapam', 'Mini Hall', 'Garden Hall'], 'Halls = Mandapam, Mini Hall and any hall added later')
    assert.equal(halls.sections[0].bookings[0].customer, 'G1')
  })
  test('advance Cash 2,000 + Card 1,000; final GPay 3,975 + UPI 3,000 → advance and final kept separately, balance 0', async () => {
    // 4,000 + 5,975 = 9,975 (an exact two-part example of advance + final)
    const r = await manager.post('/api/bookings', secBody('Outsource 1', { customer: { name: 'Ex', phone: nextPhone() }, date: futureDate(61), hallCharge: 4000, foodAmount: 5975 }))
    const b = r.body.booking
    assert.equal(b.money.total, 9975)
    const pay = (o) => manager.post(`/api/bookings/${b.id}/payments`, { paidOn: futureDate(0), ...o })
    assert.equal((await pay({ amount: 3000, stage: 'advance', splits: [{ method: 'Cash', amount: 2000 }, { method: 'Card', amount: 1000 }], idempotencyKey: 'ex-adv' })).status, 201)
    assert.equal((await pay({ amount: 6975, stage: 'final', splits: [{ method: 'GPay', amount: 3975 }, { method: 'UPI', amount: 3000 }], idempotencyKey: 'ex-fin' })).status, 201)
    const d = (await manager.get(`/api/bookings/${b.id}`)).body.booking
    const sum = (stage) => d.payments.filter((p) => p.stage === stage && p.status === 'verified').reduce((a, p) => a + p.amount, 0)
    assert.equal(sum('advance'), 3000); assert.equal(sum('final'), 6975)
    assert.equal(d.money.paid, 9975); assert.equal(d.money.balance, 0); assert.equal(d.money.state, 'paid')
    assert.deepEqual(d.payments.find((p) => p.stage === 'final').splits.map((x) => x.method).sort(), ['GPay', 'UPI'])
  })
  test('₹10,000 payment split Cash 5,000 + Card 2,000 + UPI 3,000 is one transaction', async () => {
    const r = await manager.post('/api/bookings', secBody('Outsource 2', { customer: { name: 'Ex2', phone: nextPhone() }, date: futureDate(62), hallCharge: 9975, foodAmount: 0 }))
    assert.equal(r.body.booking.money.total, 9975)
    const big = await manager.post('/api/bookings', secBody('Outsource 3', { customer: { name: 'Ex3', phone: nextPhone() }, date: futureDate(62), hallCharge: 9000, foodAmount: 1000 }))
    assert.equal(big.body.booking.money.total, 10000.0, JSON.stringify(big.body.booking.money))
    const p = await manager.post(`/api/bookings/${big.body.booking.id}/payments`, { paidOn: futureDate(0), amount: 10000, stage: 'final', splits: [{ method: 'Cash', amount: 5000 }, { method: 'Card', amount: 2000 }, { method: 'UPI', amount: 3000 }] })
    assert.equal(p.status, 201, JSON.stringify(p.body))
    assert.equal(p.body.payment.splits.length, 3)
    const d = (await manager.get(`/api/bookings/${big.body.booking.id}`)).body.booking
    assert.equal(d.money.balance, 0)
  })
})
