import { closePool, runMigrations } from '../db/pool.js'
import { migrate } from '../db/migrate.js'
try {
  const ran = await runMigrations(migrate, { log: console.log })
  console.log('Migrations applied:', ran?.length ?? 0)
} catch (e) {
  console.error('Migration failed:', e.message)
  process.exitCode = 1
} finally {
  await closePool()
}
