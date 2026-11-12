import { createApp } from './app.js'
import { config } from './config.js'
import { closePool, query, runMigrations, waitForDb } from './db/pool.js'
import { migrate } from './db/migrate.js'
import { checkPasswordStrength, hashPassword, purgeExpiredRateLimits, purgeExpiredSessions } from './lib/auth.js'
import { startWorker, stopWorker } from './services/notifications.js'

async function bootstrapAdmin() {
  const n = (await query('SELECT count(*)::int AS n FROM users')).rows[0].n
  if (n > 0 || !config.adminUsername || !config.adminPassword) return
  const weak = checkPasswordStrength(config.adminPassword)
  if (weak) throw new Error(`ADMIN_PASSWORD rejected: ${weak}`) // never create a weak first admin
  await query(`INSERT INTO users (username, name, role, password_hash) VALUES ($1,$2,'admin',$3)`, [config.adminUsername, 'Administrator', await hashPassword(config.adminPassword)])
  console.log(`Created first admin user "${config.adminUsername}". Change the password after signing in.`)
}

const log = (m) => console.log(m)
await waitForDb(undefined, { log })
await runMigrations(migrate, { log }) // a failed migration throws here and stops the deploy
await bootstrapAdmin()
const server = createApp().listen(config.port, () => console.log(`RHR server listening on :${config.port} (${config.env})`))
if (config.notifyWorker) startWorker()
// housekeeping: expired sessions and old rate-limit rows (safe to run from every instance)
const sweep = () => Promise.all([purgeExpiredSessions(), purgeExpiredRateLimits()]).catch((e) => console.error('housekeeping failed:', e.message))
sweep()
const sweepTimer = setInterval(sweep, 60 * 60 * 1000)
sweepTimer.unref()
let closing = false
const shutdown = async () => {
  if (closing) return
  closing = true
  setTimeout(() => process.exit(1), 10000).unref() // hard stop if requests do not drain
  stopWorker()
  await new Promise((r) => server.close(r)) // finish in-flight requests
  await closePool()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
