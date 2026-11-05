// Backup: pg_dump (custom format) + uploaded photos + manifest with checksums and row counts.
//   npm run backup                -> storage/backups/rhr-<timestamp>/
// Restore/verify: npm run restore -- <backup-dir> [--target <DATABASE_URL>] [--verify]
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { closePool, query } from '../db/pool.js'

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
export const COUNT_TABLES = ['users', 'halls', 'hall_images', 'customers', 'bookings', 'booking_charges', 'booking_changes', 'payments', 'payment_allocations', 'payment_splits', 'menu_categories', 'meal_menu_items', 'catering_prices', 'drafts', 'invoices', 'catering_orders', 'catering_order_items', 'catering_order_versions', 'catering_quotations', 'vendors', 'vendor_assignments', 'notification_events', 'notification_attempts', 'audit_events']

export async function rowCounts(q = query) {
  const out = {}
  for (const t of COUNT_TABLES) out[t] = (await q(`SELECT count(*)::int n FROM ${t}`)).rows[0].n
  return out
}

export async function runBackup({ dir = config.backupDir } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const out = path.join(dir, `rhr-${stamp}`)
  fs.mkdirSync(out, { recursive: true, mode: 0o700 })
  const dump = path.join(out, 'database.dump')
  execFileSync('pg_dump', ['--format=custom', '--no-owner', '--file', dump, config.migrateDatabaseUrl || config.databaseUrl], { stdio: ['ignore', 'inherit', 'inherit'] })
  const files = { 'database.dump': sha(dump) }
  if (fs.existsSync(config.uploadDir) && fs.readdirSync(config.uploadDir).length) {
    const tar = path.join(out, 'uploads.tar.gz')
    execFileSync('tar', ['-czf', tar, '-C', config.uploadDir, '.'])
    files['uploads.tar.gz'] = sha(tar)
  }
  const manifest = { app: 'rhr', createdAt: new Date().toISOString(), schemaMigrations: (await query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name), counts: await rowCounts(), files }
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 })
  return { dir: out, manifest }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { dir, manifest } = await runBackup()
    console.log(`Backup written to ${dir}`)
    console.log(JSON.stringify(manifest.counts))
    console.log('Next: run `npm run restore -- ' + dir + ' --verify` regularly to prove the backup restores.')
  } finally { await closePool() }
}
