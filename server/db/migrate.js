import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')

/**
 * Forward-only, checksummed migrations. Each file runs in its own transaction.
 * An already-applied file whose content changed is refused (prevents silent schema drift).
 */
export async function migrate(pool, { log = () => {} } = {}) {
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock(727274)') // one migrator at a time
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`)
    const applied = new Map((await client.query('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [r.name, r.checksum]))
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    const ran = []
    for (const f of files) {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8')
      const sum = sha(sql)
      if (applied.has(f)) {
        if (applied.get(f) !== sum) throw new Error(`Migration ${f} was modified after being applied. Add a new migration instead.`)
        continue
      }
      try {
        await client.query('BEGIN')
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1,$2)', [f, sum])
        await client.query('COMMIT')
        ran.push(f)
        log(`applied ${f}`)
      } catch (e) {
        await client.query('ROLLBACK')
        throw new Error(`Migration ${f} failed: ${e.message}`)
      }
    }
    return ran
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(727274)') } catch {}
    client.release()
  }
}
