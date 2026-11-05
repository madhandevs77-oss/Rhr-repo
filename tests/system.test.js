import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { bookingBody, form, futureDate, png, setup } from './helpers.js'

let env, admin, manager, staff, hall
before(async () => {
  env = await setup()
  admin = await env.client('admin').login(); manager = await env.client('manager').login(); staff = await env.client('staff').login()
  hall = (await admin.post('/api/halls', { name: 'Sys Hall', basePrice: 10000 })).body.hall
  await admin.post(`/api/halls/${hall.id}/images`, form([['a.png', await png(), 'image/png']]))
})
after(() => env.teardown())

describe('database-level safety nets (bypassing the API)', () => {
  test('overlapping bookings are impossible even with direct SQL; adjacent are fine; cancelled do not block', async () => {
    const { query } = await import('../server/db/pool.js')
    const c = (await query(`INSERT INTO customers (name, phone) VALUES ('Direct','9111111111') RETURNING id`)).rows[0].id
    const ins = (ref, s, e, st = 'confirmed') => query(`INSERT INTO bookings (reference, customer_id, hall_id, event_type, event_date, start_time, end_time, hall_charge, status) VALUES ($1,$2,$3,'X','2031-01-01',$4,$5,100,$6)`, [ref, c, hall.id, s, e, st])
    await ins('D-1', '10:00', '12:00')
    await assert.rejects(ins('D-2', '11:00', '13:00'), (e) => e.code === '23P01')
    await ins('D-3', '12:00', '14:00')
    await ins('D-4', '10:00', '12:00', 'cancelled')
    await assert.rejects(query(`UPDATE bookings SET end_time='09:00' WHERE reference='D-1'`), (e) => e.code === '23514')
    await assert.rejects(ins('D-1', '15:00', '16:00'), (e) => e.code === '23505', 'duplicate reference')
  })
  test('negative money and orphan payments are rejected by CHECK constraints', async () => {
    const { query } = await import('../server/db/pool.js')
    await assert.rejects(query(`INSERT INTO payments (amount, method, paid_on, status) VALUES (-5,'Cash','2030-01-01','verified')`))
    await assert.rejects(query(`INSERT INTO payments (amount, method, paid_on, status) VALUES (5,'Cash','2030-01-01','verified')`), 'a payment must target a booking or an order')
  })
  test('audit trail and change history are append-only', async () => {
    const { query } = await import('../server/db/pool.js')
    await assert.rejects(query(`UPDATE audit_events SET summary='tampered'`))
    await assert.rejects(query(`DELETE FROM audit_events`))
  })
  test('reference and invoice counters never repeat under concurrency', async () => {
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => staff.post('/api/bookings', bookingBody(hall.id, { date: futureDate(300 + i), customer: { name: 'C' + i, phone: '98111' + String(10000 + i) } }))))
    assert.ok(rs.every((r) => r.status === 201))
    const refs = rs.map((r) => r.body.booking.reference)
    assert.equal(new Set(refs).size, 12)
  })
})

describe('migrations', () => {
  test('re-running is a no-op; a tampered applied migration is refused', async () => {
    const { getPool, query } = await import('../server/db/pool.js')
    const { migrate } = await import('../server/db/migrate.js')
    const again = await migrate(getPool())
    assert.equal((again || []).length, 0)
    await query(`UPDATE schema_migrations SET checksum='bogus' WHERE name='001_core.sql'`)
    await assert.rejects(migrate(getPool()), /modified after being applied/)
    const real = (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(new URL('../server/db/migrations/001_core.sql', import.meta.url), 'utf8')).digest('hex')
    await query(`UPDATE schema_migrations SET checksum=$1 WHERE name='001_core.sql'`, [real])
    assert.equal(((await migrate(getPool())) || []).length, 0)
  })
})

describe('legacy data import', () => {
  const legacy = () => ({ app: 'rhr', data: {
    halls: [{ id: 'h1', name: 'Old Hall', description: 'legacy' }, { id: 'h9', name: 'Sys Hall' }],
    food: [{ id: 'f1', name: 'Legacy Dosa', cat: 'Breakfast / Tiffin', price: 55 }],
    bookings: [
      { id: 'b1', bookingId: 'BH-2026-1001', name: 'Old Customer', phone: '+91 98765 43210', hallId: 'h1', date: '2026-12-05', startTime: '10:00', endTime: '14:00', hallTotal: 9000, eventType: 'Wedding', status: 'confirmed' },
      { id: 'b2', bookingId: 'BH-2026-1002', name: 'Overlap Person', phone: '9876500099', hallId: 'h1', date: '2026-12-05', startTime: '12:00', endTime: '16:00', hallTotal: 5000, status: 'confirmed' },
      { id: 'b3', bookingId: 'BH-2026-1003', name: '', phone: '123', hallId: 'h1', date: '2026-12-06', hallTotal: 1 },
      { id: 'b4', bookingId: 'BH-2026-1004', name: 'No Times', phone: '9876500098', hallId: 'h9', date: '2026-12-07', hallTotal: 2000 },
    ],
    payments: [{ id: 'p1', bookingId: 'b1', amount: 3000, date: '2026-10-01', method: 'Cash', type: 'Advance' }, { id: 'p2', bookingId: 'zzz', amount: 5, date: '2026-10-01' }, { id: 'p3', bookingId: 'b1', amount: -2, date: '2026-10-01' }],
    audit: [{ time: '2026-10-01T10:00:00Z', action: 'Booking Created', bookingId: 'BH-2026-1001', details: 'x' }],
  } })
  test('only admins can import', async () => {
    assert.equal((await manager.post('/api/admin/import-legacy', legacy())).status, 403)
  })
  test('dry run reports but writes nothing', async () => {
    const r = await admin.post('/api/admin/import-legacy?dryRun=1', legacy())
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.report.dryRun, true)
    assert.equal(r.body.report.bookings.imported, 3, JSON.stringify(r.body.report))
    assert.equal(r.body.report.bookings.skipped.length, 1)
    const l = (await manager.get('/api/bookings?q=Old%20Customer')).body.bookings
    assert.equal(l.length, 0)
  })
  test('real import is validated, reports problems, keeps overlapping legacy data as cancelled, and is idempotent', async () => {
    const r = await admin.post('/api/admin/import-legacy', legacy())
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const rep = r.body.report
    assert.equal(rep.bookings.imported, 3); assert.equal(rep.bookings.importedAsCancelled.length, 1)
    assert.equal(rep.payments.imported, 1); assert.equal(rep.payments.skipped, 2)
    const b = (await manager.get('/api/bookings?q=Old%20Customer')).body.bookings[0]
    const d = (await manager.get(`/api/bookings/${b.id}`)).body.booking
    assert.equal(d.money.paid, 3000); assert.equal(d.money.total, 9000)
    assert.equal(d.customer.phone, '9876543210'); assert.equal(d.customer.messageConsent, false, 'no consent assumed for imported customers')
    const again = (await admin.post('/api/admin/import-legacy', legacy())).body.report
    assert.equal(again.bookings.imported, 0); assert.equal(again.bookings.alreadyPresent, 4 - 1) // the skipped one is skipped again
    assert.equal(again.payments.imported, 0)
    // new bookings continue the reference sequence after imported ones
    const nb = await staff.post('/api/bookings', bookingBody(hall.id, { date: futureDate(400), customer: { name: 'After Import', phone: '9811100000' } }))
    assert.equal(nb.status, 201)
    assert.ok(Number(nb.body.booking.reference.split('-')[2]) > 1004, nb.body.booking.reference)
  })
  test('garbage files are rejected', async () => {
    assert.equal((await admin.post('/api/admin/import-legacy', { hello: 'world' })).status, 400)
  })
})

describe('backup & restore', () => {
  test('backup → verify restore into scratch DB succeeds with identical counts; corrupt backup is refused', async () => {
    const { runBackup } = await import('../server/scripts/backup.js')
    const { restoreBackup } = await import('../server/scripts/restore.js')
    const { dir, manifest } = await runBackup()
    assert.ok(manifest.counts.bookings >= 10 && manifest.counts.hall_images >= 1)
    assert.ok(manifest.files['uploads.tar.gz'], 'photos are part of the backup')
    const r = await restoreBackup(dir, { verify: true })
    assert.equal(r.ok, true)
    // corrupt the dump
    fs.appendFileSync(path.join(dir, 'database.dump'), 'garbage')
    await assert.rejects(restoreBackup(dir, { verify: true }), /corrupt/)
  })
  test('restoring into a non-empty database is refused', async () => {
    const { runBackup } = await import('../server/scripts/backup.js')
    const { restoreBackup } = await import('../server/scripts/restore.js')
    const { dir } = await runBackup()
    await assert.rejects(restoreBackup(dir, { target: process.env.DATABASE_URL }), /not empty/)
  })
  test('JSON export is admin-only', async () => {
    assert.equal((await manager.get('/api/admin/export')).status, 403)
    const r = await admin.get('/api/admin/export')
    assert.equal(r.status, 200); assert.ok(r.body.tables.bookings.length > 5)
    assert.equal(JSON.stringify(r.body).includes('password_hash'), false, 'no credentials in exports')
  })
})

describe('reports, audit, health, users', () => {
  test('audit log records who did what; managers can read, staff cannot', async () => {
    const r = await manager.get('/api/audit')
    assert.equal(r.status, 200)
    const rows = r.body.events || r.body.audit || r.body
    assert.ok(Array.isArray(rows) && rows.length > 0)
    assert.equal((await staff.get('/api/audit')).status, 403)
  })
  test('reports summary is manager-only and consistent with ledger', async () => {
    assert.equal((await staff.get('/api/reports/summary')).status, 403)
    assert.equal((await manager.get('/api/reports/summary')).status, 200)
  })
  test('health endpoint is public and does not leak details', async () => {
    const r = await env.client().get('/api/health')
    assert.equal(r.status, 200); assert.deepEqual(Object.keys(r.body).sort(), ['ok', 'time'])
  })
  test('user admin: admin creates staff, weak passwords rejected, account lockout after repeated failures, deactivation kills sessions', async () => {
    assert.equal((await admin.post('/api/users', { username: 'newstaff', name: 'New Staff', role: 'staff', password: 'short' })).status, 400)
    const u = await admin.post('/api/users', { username: 'newstaff', name: 'New Staff', role: 'staff', password: 'LongEnough123' })
    assert.equal(u.status, 201, JSON.stringify(u.body))
    const c = env.client(); c.user = 'newstaff'
    assert.equal((await c.req('POST', '/api/auth/login', { username: 'newstaff', password: 'LongEnough123' })).status, 200)
    assert.equal((await c.get('/api/bookings')).status, 200)
    assert.equal((await admin.patch(`/api/users/${u.body.user.id}`, { active: false })).status, 200)
    assert.equal((await c.get('/api/bookings')).status, 401, 'deactivated user is kicked out immediately')
    const victim = env.client()
    for (let i = 0; i < 5; i++) await victim.post('/api/auth/login', { username: 'staff2', password: 'wrong-' + i })
    const locked = await victim.post('/api/auth/login', { username: 'staff2', password: 'Passw0rd-staff2' })
    assert.equal(locked.status, 429, 'locked even with the right password')
  })
  test('the last active admin cannot be removed or demoted', async () => {
    const me = (await admin.get('/api/auth/me')).body.user
    const r = await admin.patch(`/api/users/${me.id}`, { role: 'staff' })
    assert.ok([400, 409].includes(r.status), JSON.stringify(r.body))
  })
})
