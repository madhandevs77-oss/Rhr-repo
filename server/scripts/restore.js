// Restore a backup made by `npm run backup`.
//   npm run restore -- <backup-dir> --verify              restore into a scratch database, compare row counts, drop it (safe; run regularly)
//   npm run restore -- <backup-dir> --target <DATABASE_URL> [--uploads-to <dir>]   restore into an EMPTY database
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { config } from '../config.js'
import { COUNT_TABLES } from './backup.js'

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')

export async function restoreBackup(dir, { target, verify = false, uploadsTo } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  for (const [f, sum] of Object.entries(manifest.files)) {
    if (sha(path.join(dir, f)) !== sum) throw new Error(`Backup file ${f} is corrupt (checksum mismatch). Nothing was restored.`)
  }
  const base = new URL(config.databaseUrl)
  let scratch
  if (verify) {
    scratch = `rhr_verify_${Date.now()}`
    const admin = new pg.Client({ connectionString: Object.assign(new URL(config.databaseUrl), { pathname: '/postgres' }).toString() })
    await admin.connect(); await admin.query(`CREATE DATABASE ${scratch}`); await admin.end()
    base.pathname = '/' + scratch
    target = base.toString()
  }
  if (!target) throw new Error('Specify --target <DATABASE_URL> (an empty database) or --verify')
  const client = new pg.Client({ connectionString: target })
  await client.connect()
  try {
    const existing = (await client.query(`SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'`)).rows[0].n
    if (existing > 0) throw new Error('The target database is not empty. Restore only into a new, empty database.')
    execFileSync('pg_restore', ['--no-owner', '--exit-on-error', '--dbname', target, path.join(dir, 'database.dump')], { stdio: ['ignore', 'inherit', 'inherit'] })
    const mism = []
    for (const t of COUNT_TABLES) {
      const n = (await client.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n
      if (manifest.counts[t] === undefined) continue // table did not exist when this older backup was made
      if (n !== manifest.counts[t]) mism.push(`${t}: backup ${manifest.counts[t]} vs restored ${n}`)
    }
    // invariants that must hold after a restore
    const bad = (await client.query(`SELECT count(*)::int n FROM bookings a JOIN bookings b ON a.id<b.id AND a.hall_id=b.hall_id AND a.status<>'cancelled' AND b.status<>'cancelled' AND a.starts_at < b.ends_at AND b.starts_at < a.ends_at`)).rows[0].n
    if (bad) mism.push(`${bad} overlapping bookings after restore`)
    if (mism.length) throw new Error('Restore verification FAILED: ' + mism.join('; '))
    if (uploadsTo && manifest.files['uploads.tar.gz']) { fs.mkdirSync(uploadsTo, { recursive: true }); execFileSync('tar', ['-xzf', path.join(dir, 'uploads.tar.gz'), '-C', uploadsTo]) }
    return { ok: true, counts: manifest.counts, verifiedIn: scratch || target }
  } finally {
    await client.end()
    if (scratch) {
      const admin = new pg.Client({ connectionString: Object.assign(new URL(config.databaseUrl), { pathname: '/postgres' }).toString() })
      await admin.connect(); await admin.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`); await admin.end()
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2)
  const dir = a.find((x) => !x.startsWith('--') && a[a.indexOf(x) - 1] !== '--target' && a[a.indexOf(x) - 1] !== '--uploads-to')
  const opt = (n) => (a.includes(n) ? a[a.indexOf(n) + 1] : undefined)
  if (!dir) { console.error('Usage: npm run restore -- <backup-dir> (--verify | --target <DATABASE_URL> [--uploads-to <dir>])'); process.exit(2) }
  try {
    const r = await restoreBackup(path.resolve(dir), { target: opt('--target'), verify: a.includes('--verify'), uploadsTo: opt('--uploads-to') })
    console.log('OK — backup restored and verified.', r.verifiedIn)
  } catch (e) { console.error('FAILED:', e.message); process.exit(1) }
}
