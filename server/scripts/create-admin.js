// npm run create-admin -- <username> <password> ["Full Name"] [role]
import { closePool, query } from '../db/pool.js'
import { checkPasswordStrength, hashPassword } from '../lib/auth.js'
const [username, password, name = 'Administrator', role = 'admin'] = process.argv.slice(2)
if (!username || !password) { console.error('Usage: npm run create-admin -- <username> <password> ["Full Name"] [admin|manager|staff]'); process.exit(2) }
const weak = checkPasswordStrength(password)
if (weak) { console.error(weak); process.exit(2) }
if (!['admin', 'manager', 'staff'].includes(role)) { console.error('Role must be admin, manager or staff'); process.exit(2) }
try {
  await query(`INSERT INTO users (username, name, role, password_hash) VALUES ($1,$2,$3,$4) ON CONFLICT (lower(username)) DO UPDATE SET password_hash=EXCLUDED.password_hash, role=EXCLUDED.role, active=true, failed_logins=0, locked_until=NULL`, [username, name, role, await hashPassword(password)])
  console.log(`User "${username}" (${role}) created or password reset.`)
} finally { await closePool() }
