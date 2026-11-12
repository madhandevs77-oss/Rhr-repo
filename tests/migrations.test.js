// Migration safety: upgrade of an existing database, failure + retry, tamper detection, idempotence, concurrency. Real PostgreSQL, throw-away databases.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import pg from 'pg'
import { migrate } from '../server/db/migrate.js'

const adminUrl = process.env.TEST_ADMIN_DATABASE_URL || 'postgres://rhr:rhr_dev_pw@127.0.0.1:5432/postgres'
const REAL = path.resolve('server/db/migrations')
const made = []
let admin
before(async () => { admin = new pg.Client({ connectionString: adminUrl }); await admin.connect() })
after(async () => { for (const n of made) await admin.query(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`); await admin.end() })

async function freshDb() {
  const name = `rhr_mig_${process.pid}_${crypto.randomBytes(3).toString('hex')}`
  await admin.query(`CREATE DATABASE ${name}`); made.push(name)
  const u = new URL(adminUrl); u.pathname = '/' + name
  const pool = new pg.Pool({ connectionString: u.toString(), max: 4 })
  return pool
}
const tmpDir = (files) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rhr-mig-')); for (const [n, sql] of Object.entries(files)) fs.writeFileSync(path.join(d, n), sql); return d }
const realFiles = () => fs.readdirSync(REAL).filter((f) => f.endsWith('.sql')).sort()

describe('upgrading an existing database', () => {
  test('data written under an older schema survives the upgrade to the latest schema', async () => {
    const pool = await freshDb()
    const all = realFiles(); assert.ok(all.length >= 13)
    // "old version" = everything up to 011 (before the outsource fulfilment columns and the rate-limit table)
    const old = Object.fromEntries(all.filter((f) => f < '012').map((f) => [f, fs.readFileSync(path.join(REAL, f), 'utf8')]))
    await migrate(pool, { dir: tmpDir(old) })
    const hall = (await pool.query(`INSERT INTO halls (name) VALUES ('Old Hall') RETURNING id`)).rows[0].id
    const cust = (await pool.query(`INSERT INTO customers (name, phone) VALUES ('Old Customer','9876500001') RETURNING id`)).rows[0].id
    await pool.query(`INSERT INTO bookings (reference, customer_id, hall_id, event_type, event_date, start_time, end_time) VALUES ('OLD-1',$1,$2,'Wedding','2027-03-01','09:00','12:00')`, [cust, hall])
    const before = (await pool.query('SELECT * FROM bookings')).rows[0]
    const ran = await migrate(pool) // real folder: applies only what is new
    assert.deepEqual(ran, all.filter((f) => f >= '012'))
    const after = (await pool.query('SELECT * FROM bookings')).rows[0]
    for (const k of Object.keys(before)) assert.deepEqual(after[k], before[k], `column ${k} unchanged`)
    assert.equal(after.fulfilment, null); assert.equal(after.delivery_address, '')
    assert.equal((await pool.query('SELECT count(*)::int n FROM customers')).rows[0].n, 1)
    assert.equal((await pool.query('SELECT count(*)::int n FROM rate_limits')).rows[0].n, 0)
    await pool.end()
  })
  test('re-running is a no-op and records each migration exactly once', async () => {
    const pool = await freshDb()
    const first = await migrate(pool); assert.equal(first.length, realFiles().length)
    assert.deepEqual(await migrate(pool), [])
    const rows = (await pool.query('SELECT name FROM schema_migrations')).rows
    assert.equal(rows.length, realFiles().length); assert.equal(new Set(rows.map((r) => r.name)).size, rows.length)
    await pool.end()
  })
  test('two instances starting at once (two ECS tasks): each migration is applied once, nobody fails', async () => {
    const pool = await freshDb()
    const [a, b] = await Promise.all([migrate(pool), migrate(pool)])
    assert.equal(a.length + b.length, realFiles().length)
    assert.equal((await pool.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n, realFiles().length)
    await pool.end()
  })
})

describe('failure handling', () => {
  test('a failing migration is rolled back completely, earlier ones stay, and a corrected file applies on retry', async () => {
    const pool = await freshDb()
    const good = '001_a.sql', bad = '002_b.sql'
    const dir = tmpDir({ [good]: 'CREATE TABLE t_a (id int);', [bad]: 'CREATE TABLE t_b (id int); INSERT INTO t_missing VALUES (1);' })
    await assert.rejects(() => migrate(pool, { dir }), /Migration 002_b\.sql failed/)
    assert.equal((await pool.query(`SELECT to_regclass('t_a') AS x`)).rows[0].x, 't_a', 'earlier migration kept')
    assert.equal((await pool.query(`SELECT to_regclass('t_b') AS x`)).rows[0].x, null, 'no half-applied table from the failed file')
    assert.deepEqual((await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name), [good])
    fs.writeFileSync(path.join(dir, bad), 'CREATE TABLE t_b (id int);') // the failed file was never recorded, so it may be corrected
    assert.deepEqual(await migrate(pool, { dir }), [bad])
    assert.equal((await pool.query(`SELECT to_regclass('t_b') AS x`)).rows[0].x, 't_b')
    await pool.end()
  })
  test('editing an already-applied migration is refused (schema drift protection) and nothing else runs', async () => {
    const pool = await freshDb()
    const dir = tmpDir({ '001_a.sql': 'CREATE TABLE t_a (id int);' })
    await migrate(pool, { dir })
    fs.writeFileSync(path.join(dir, '001_a.sql'), 'CREATE TABLE t_a (id int, extra int);')
    fs.writeFileSync(path.join(dir, '002_b.sql'), 'CREATE TABLE t_b (id int);')
    await assert.rejects(() => migrate(pool, { dir }), /modified after being applied/)
    assert.equal((await pool.query(`SELECT to_regclass('t_b') AS x`)).rows[0].x, null)
    await pool.end()
  })
})
