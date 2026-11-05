import pg from 'pg'
import { config } from '../config.js'

// Return DATE and TIME columns as plain strings ('2026-10-15', '14:30:00') — no timezone shifting.
pg.types.setTypeParser(1082, (v) => v)
pg.types.setTypeParser(1083, (v) => v)
// NUMERIC stays a string; all arithmetic goes through lib/money.js (integer paise).

let pool
export function getPool(url = config.databaseUrl) {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: url,
      max: config.dbPoolMax,
      connectionTimeoutMillis: config.dbConnectTimeoutMs,
      idleTimeoutMillis: 30000, // release idle sockets before a serverless database suspends them
      keepAlive: true,
      ...(config.dbSsl === undefined ? {} : { ssl: config.dbSsl ? { rejectUnauthorized: true } : false }),
    })
    // An idle client can be killed by the database (autosuspend, failover). Without a handler this crashes the process.
    pool.on('error', (e) => console.error('[db] idle client error:', e.message))
  }
  return pool
}
export async function closePool() {
  if (pool) await pool.end()
  pool = undefined
}
export const query = (text, params) => getPool().query(text, params)

/** Run fn inside a transaction. Retries on serialization/deadlock failures. */
export async function tx(fn, { retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      const out = await fn(client)
      await client.query('COMMIT')
      return out
    } catch (e) {
      try { await client.query('ROLLBACK') } catch {}
      if ((e.code === '40001' || e.code === '40P01') && attempt < retries) continue
      throw e
    } finally {
      client.release()
    }
  }
}

/** Retry the first connection: serverless databases (Neon) need a few seconds to wake from autosuspend. */
export async function waitForDb(p = getPool(), { attempts = 6, delayMs = 3000, log = () => {} } = {}) {
  for (let i = 1; ; i++) {
    try {
      await p.query('SELECT 1')
      return
    } catch (e) {
      if (i >= attempts) throw new Error(`Cannot connect to the database after ${attempts} attempts: ${e.message}`)
      log(`database not reachable yet (${e.message}); retrying in ${delayMs / 1000}s [${i}/${attempts}]`)
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
}

/**
 * Run all pending migrations on a short-lived DIRECT connection (MIGRATE_DATABASE_URL, else DATABASE_URL).
 * Advisory locks do not work through a transaction-mode pooler, so this never reuses the app pool.
 * Throws on any failure so a bad migration stops the deployment.
 */
export async function runMigrations(migrate, { log = () => {} } = {}) {
  const url = config.migrateDatabaseUrl || config.databaseUrl
  const p = new pg.Pool({
    connectionString: url, max: 1, connectionTimeoutMillis: config.dbConnectTimeoutMs,
    ...(config.dbSsl === undefined ? {} : { ssl: config.dbSsl ? { rejectUnauthorized: true } : false }),
  })
  p.on('error', (e) => console.error('[db] migration client error:', e.message))
  try {
    await waitForDb(p, { log })
    return await migrate(p, { log })
  } finally {
    await p.end()
  }
}
