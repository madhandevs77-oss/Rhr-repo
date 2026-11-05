import crypto from 'node:crypto'
import { promisify } from 'node:util'
import { config } from '../config.js'
import { query } from '../db/pool.js'
import { AppError, forbidden, unauthorized } from './errors.js'

const scrypt = promisify(crypto.scrypt)
const COOKIE = 'rhr_session'

// ---------- passwords (scrypt, per-user salt) ----------
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 })
  return `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`
}
export async function verifyPassword(password, stored) {
  const [alg, N, r, p, saltB64, keyB64] = String(stored).split('$')
  if (alg !== 'scrypt') return false
  const key = Buffer.from(keyB64, 'base64')
  const test = await scrypt(password, Buffer.from(saltB64, 'base64'), key.length, { N: +N, r: +r, p: +p })
  return crypto.timingSafeEqual(key, test)
}
export function checkPasswordStrength(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters'
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Password must contain letters and numbers'
  return null
}

// ---------- roles & permissions (enforced server-side on every route) ----------
const ALL = ['admin', 'manager', 'staff']
const MGR = ['admin', 'manager']
const ADM = ['admin']
export const PERMS = {
  'bookings.view': ALL, 'bookings.create': ALL, 'bookings.edit': ALL, 'bookings.editFinancial': MGR, 'bookings.cancel': MGR,
  'customers.view': ALL, 'customers.edit': ALL,
  'payments.record': ALL, 'payments.verify': MGR, 'payments.refund': MGR, 'payments.reverse': ADM,
  'invoices.view': ALL, 'invoices.issue': MGR, 'invoices.void': ADM, 'invoices.send': ALL, 'messages.send': ALL,
  'halls.view': ALL, 'halls.manage': ADM,
  'menu.view': ALL, 'menu.manage': MGR, 'mealmenu.view': ALL, 'mealmenu.manage': MGR,
  'notifications.view': MGR, 'notifications.retry': MGR, 'notifications.config': ADM,
  'catering.view': ALL, 'catering.create': ALL, 'catering.edit': ALL, 'catering.approveChange': MGR, 'catering.cancel': MGR,
  'catering.progress': ALL, 'catering.complete': MGR, 'catering.priceOverride': MGR,
  'vendors.view': ALL, 'vendors.manage': MGR,
  'settings.view': MGR, 'settings.edit': ADM, 'users.manage': ADM, 'audit.view': MGR, 'reports.view': MGR, 'data.admin': ADM,
}
export const can = (user, perm) => !!user && (PERMS[perm] || []).includes(user.role)
export const permissionsFor = (user) => Object.keys(PERMS).filter((p) => can(user, p))

export function requirePerm(...perms) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized())
    if (!perms.every((p) => can(req.user, p))) return next(forbidden())
    next()
  }
}

// ---------- sessions ----------
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex')

export async function createSession(userId, req) {
  const token = crypto.randomBytes(32).toString('base64url')
  await query(
    `INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent) VALUES ($1,$2, now() + ($3 || ' hours')::interval, $4, $5)`,
    [userId, sha(token), String(config.sessionHours), req.ip, (req.headers['user-agent'] || '').slice(0, 200)],
  )
  return token
}
export const destroySession = (token) => query('DELETE FROM sessions WHERE token_hash=$1', [sha(token)])

export function setCookie(res, token) {
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, maxAge: config.sessionHours * 3600 * 1000, path: '/' })
}
export const clearCookie = (res) => res.clearCookie(COOKIE, { path: '/' })

function readCookie(req, name) {
  const h = req.headers.cookie
  if (!h) return null
  for (const part of h.split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return null
}
export const sessionToken = (req) => readCookie(req, COOKIE)

/** Attach req.user from the session cookie (if valid). Does not reject. */
export async function authenticate(req, _res, next) {
  try {
    const token = sessionToken(req)
    if (token) {
      const r = await query(
        `SELECT u.id, u.username, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash=$1 AND s.expires_at > now() AND u.active`,
        [sha(token)],
      )
      if (r.rows[0]) {
        req.user = r.rows[0]
        // sliding expiry, written at most once a minute
        query(`UPDATE sessions SET last_seen_at=now() WHERE token_hash=$1 AND last_seen_at < now() - interval '1 minute'`, [sha(token)]).catch(() => {})
      }
    }
    next()
  } catch (e) {
    next(e)
  }
}
export const requireAuth = (req, _res, next) => (req.user ? next() : next(unauthorized()))

/** CSRF: cookies are SameSite=Strict AND every state-changing request must carry a custom header. */
export function csrfGuard(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
  if (req.path.startsWith('/webhooks/') || req.path.startsWith('/integrations/')) return next() // signature-verified instead
  if (req.headers['x-requested-with'] !== 'rhr') return next(new AppError(403, 'CSRF', 'Missing X-Requested-With header'))
  next()
}

// ---------- tiny in-memory rate limiter (per key) ----------
export function rateLimiter({ windowMs, max, key = (req) => req.ip, message = 'Too many requests, slow down' }) {
  const hits = new Map()
  return (req, _res, next) => {
    const now = Date.now()
    const k = key(req)
    const arr = (hits.get(k) || []).filter((t) => now - t < windowMs)
    if (arr.length >= max) return next(new AppError(429, 'RATE_LIMITED', message))
    arr.push(now)
    hits.set(k, arr)
    if (hits.size > 5000) for (const [kk, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(kk)
    next()
  }
}
