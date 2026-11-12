import { Router } from 'express'
import { query } from '../db/pool.js'
import { checkPasswordStrength, clearCookie, createSession, destroySession, hashPassword, permissionsFor, rateLimiter, requireAuth, requirePerm, sessionToken, setCookie, verifyPassword } from '../lib/auth.js'
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js'
import { parse, z } from '../lib/validate.js'
import { audit } from '../services/support.js'

export const authRouter = Router()
const ctxOf = (req) => ({ user: req.user, ip: req.ip })
const TOO_MANY = 'Too many sign-in attempts. Try again later.'
// Two shared (database-backed) limits: per client IP, and per normalised username (applies equally to names that do not exist, so it reveals nothing).
const ipLimiter = rateLimiter({ name: 'login-ip', windowMs: 15 * 60 * 1000, max: 30, message: TOO_MANY })
const userLimiter = rateLimiter({ name: 'login-user', windowMs: 15 * 60 * 1000, max: 10, message: TOO_MANY, key: (req) => (typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase().slice(0, 100) : '') })
const LOCK_AFTER = 5
const LOCK_MINUTES = 15
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64')

export const userView = (u) => ({ id: u.id, username: u.username, name: u.name, role: u.role, permissions: permissionsFor(u) })

authRouter.post('/login', ipLimiter, userLimiter, async (req, res) => {
  const { username, password } = parse(z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(200) }), req.body)
  const r = await query('SELECT * FROM users WHERE lower(username)=lower($1)', [username])
  const u = r.rows[0]
  const generic = badRequest('Invalid username or password', undefined, 'BAD_CREDENTIALS')
  generic.status = 401
  if (!u || !u.active) {
    await verifyPassword(password, DUMMY_HASH).catch(() => {}) // equalise timing
    throw generic
  }
  // Reserve one attempt atomically BEFORE checking the password: concurrent requests cannot overwrite each other's count, and no more than
  // LOCK_AFTER guesses can be in flight. An expired lock restarts the count at 1. A correct password resets everything below.
  const attempt = await query(
    // the new count is computed INSIDE the UPDATE from the current row (not from a value read earlier), so concurrent attempts serialise on the row lock
    `UPDATE users SET
       failed_logins = CASE WHEN locked_until IS NOT NULL AND locked_until <= now() THEN 1 ELSE failed_logins + 1 END,
       locked_until  = CASE WHEN (CASE WHEN locked_until IS NOT NULL AND locked_until <= now() THEN 1 ELSE failed_logins + 1 END) >= $2::int
                            THEN now() + make_interval(mins => $3::int) ELSE NULL END
     WHERE id=$1 AND active AND (locked_until IS NULL OR locked_until <= now()) RETURNING failed_logins`,
    [u.id, LOCK_AFTER, LOCK_MINUTES])
  if (!attempt.rowCount) {
    await verifyPassword(password, DUMMY_HASH).catch(() => {}) // locked accounts take as long as any other and answer like the rate limiter
    throw new AppError(429, 'RATE_LIMITED', TOO_MANY)
  }
  if (!(await verifyPassword(password, u.password_hash))) {
    await audit({ query }, { ip: req.ip, system: true }, { action: 'Login Failed', entityType: 'user', entityId: u.id, summary: `Failed sign-in for ${u.username}` })
    throw generic
  }
  await query('UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1', [u.id])
  const token = await createSession(u.id, req)
  setCookie(res, token)
  await audit({ query }, { user: u, ip: req.ip }, { action: 'Login', entityType: 'user', entityId: u.id, summary: `${u.username} signed in` })
  res.json({ user: userView(u) })
})

authRouter.post('/logout', async (req, res) => {
  const t = sessionToken(req)
  if (t) await destroySession(t)
  clearCookie(res)
  res.json({ ok: true })
})

authRouter.get('/me', (req, res) => {
  res.json({ user: req.user ? userView(req.user) : null })
})

authRouter.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = parse(z.object({ currentPassword: z.string(), newPassword: z.string() }), req.body)
  const weak = checkPasswordStrength(newPassword)
  if (weak) throw badRequest(weak)
  const u = (await query('SELECT * FROM users WHERE id=$1', [req.user.id])).rows[0]
  if (!(await verifyPassword(currentPassword, u.password_hash))) throw badRequest('Current password is incorrect', undefined, 'BAD_CREDENTIALS')
  await query('UPDATE users SET password_hash=$2, updated_at=now() WHERE id=$1', [u.id, await hashPassword(newPassword)])
  await query('DELETE FROM sessions WHERE user_id=$1 AND token_hash <> $2', [u.id, '']) // sign out everywhere (including this device -> re-login)
  clearCookie(res)
  await audit({ query }, ctxOf(req), { action: 'Password Changed', entityType: 'user', entityId: u.id })
  res.json({ ok: true, signedOut: true })
})

// ---------- user administration (admin only) ----------
export const usersRouter = Router()
usersRouter.use(requirePerm('users.manage'))
const userBody = z.object({
  username: z.string().trim().min(3).max(50).regex(/^[A-Za-z0-9._-]+$/, 'Letters, numbers, . _ - only'),
  name: z.string().trim().min(1).max(100),
  role: z.enum(['admin', 'manager', 'staff']),
  password: z.string().optional(),
  active: z.boolean().optional(),
})

usersRouter.get('/', async (_req, res) => {
  const r = await query('SELECT id, username, name, role, active, created_at FROM users ORDER BY created_at')
  res.json({ users: r.rows.map((u) => ({ id: u.id, username: u.username, name: u.name, role: u.role, active: u.active, createdAt: u.created_at })) })
})
usersRouter.post('/', async (req, res) => {
  const b = parse(userBody, req.body)
  const weak = checkPasswordStrength(b.password)
  if (weak) throw badRequest(weak)
  try {
    const r = await query('INSERT INTO users (username, name, role, password_hash) VALUES ($1,$2,$3,$4) RETURNING id, username, name, role, active', [b.username, b.name, b.role, await hashPassword(b.password)])
    await audit({ query }, ctxOf(req), { action: 'User Created', entityType: 'user', entityId: r.rows[0].id, summary: `${b.username} (${b.role})` })
    res.status(201).json({ user: r.rows[0] })
  } catch (e) {
    if (e.code === '23505') throw conflict('That username is already taken', 'DUPLICATE')
    throw e
  }
})
usersRouter.patch('/:id', async (req, res) => {
  const b = parse(userBody.partial(), req.body)
  const cur = (await query('SELECT * FROM users WHERE id=$1', [req.params.id])).rows[0]
  if (!cur) throw notFound('User')
  if (cur.id === req.user.id && ((b.role && b.role !== 'admin') || b.active === false)) throw badRequest('You cannot demote or deactivate your own account')
  if (b.password) {
    const weak = checkPasswordStrength(b.password)
    if (weak) throw badRequest(weak)
  }
  const r = await query(
    `UPDATE users SET name=COALESCE($2,name), role=COALESCE($3,role), active=COALESCE($4,active),
       password_hash=COALESCE($5,password_hash), updated_at=now() WHERE id=$1 RETURNING id, username, name, role, active`,
    [cur.id, b.name ?? null, b.role ?? null, b.active ?? null, b.password ? await hashPassword(b.password) : null],
  )
  if (b.active === false || b.password || b.role) await query('DELETE FROM sessions WHERE user_id=$1', [cur.id])
  await audit({ query }, ctxOf(req), { action: 'User Updated', entityType: 'user', entityId: cur.id, summary: `${cur.username}`, details: { role: b.role, active: b.active, passwordReset: !!b.password } })
  res.json({ user: r.rows[0] })
})
