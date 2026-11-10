// Security behaviour: sessions, account status, injection, uploads, CORS, CSRF, headers, data exposure.
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { form, futureDate, png, setup } from './helpers.js'

let env, admin, staff, anon, query, hall
before(async () => {
  env = await setup()
  admin = await env.client('admin').login(); staff = await env.client('staff').login(); anon = env.client('admin')
  ;({ query } = await import('../server/db/pool.js'))
  hall = (await admin.post('/api/halls', { name: 'Sec Hall', basePrice: 1000 })).body.hall
})
after(() => env.teardown())

describe('sessions', () => {
  test('an expired session is rejected and the user is signed out', async () => {
    const c = await env.client('staff2').login()
    assert.equal((await c.get('/api/halls')).status, 200)
    await query(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id = (SELECT id FROM users WHERE username='staff2')`)
    assert.equal((await c.get('/api/halls')).status, 401)
  })
  test('a deactivated account cannot log in and its live session stops working', async () => {
    const u = (await admin.post('/api/users', { username: 'secoff', name: 'Sec Off', role: 'staff', password: 'Passw0rd-secoff' })).body.user
    const c = await env.client('secoff').login()
    assert.equal((await c.get('/api/halls')).status, 200)
    assert.equal((await admin.patch(`/api/users/${u.id}`, { active: false })).status, 200)
    assert.equal((await c.get('/api/halls')).status, 401)
    const again = await env.client('secoff').req('POST', '/api/auth/login', { username: 'secoff', password: 'Passw0rd-secoff' })
    assert.ok(again.status === 401 || again.status === 403, String(again.status))
  })
  test('wrong password and unknown user give the same answer (no account enumeration)', async () => {
    const a = await anon.req('POST', '/api/auth/login', { username: 'admin', password: 'definitely-wrong' })
    const b = await anon.req('POST', '/api/auth/login', { username: 'no-such-user-xyz', password: 'definitely-wrong' })
    assert.equal(a.status, 401)
    assert.equal(b.status, 401)
    assert.deepEqual(a.body, b.body)
  })
  test('session cookie is HttpOnly and SameSite=Strict', async () => {
    const res = await fetch(env.url + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'rhr' }, body: JSON.stringify({ username: 'manager', password: 'Passw0rd-manager' }) })
    const sc = res.headers.get('set-cookie') || ''
    assert.match(sc, /HttpOnly/i)
    assert.match(sc, /SameSite=Strict/i)
  })
})

describe('CSRF, CORS and headers', () => {
  test('a state-changing request without the custom header is refused', async () => {
    const r = await staff.req('POST', '/api/drafts', { kind: 'booking', data: {} }, { csrf: false })
    assert.equal(r.status, 403)
  })
  test('no cross-origin access is granted', async () => {
    const res = await fetch(env.url + '/api/halls', { headers: { Origin: 'https://evil.example', Cookie: staff.cookie } })
    assert.equal(res.headers.get('access-control-allow-origin'), null)
    const pre = await fetch(env.url + '/api/halls', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } })
    assert.equal(pre.headers.get('access-control-allow-origin'), null)
  })
  test('security headers are present and the server does not advertise Express', async () => {
    const res = await fetch(env.url + '/healthz')
    assert.match(res.headers.get('content-security-policy') || '', /default-src 'self'/)
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(res.headers.get('x-powered-by'), null)
  })
})

describe('injection and data exposure', () => {
  const payloads = ["' OR 1=1 --", "'; DROP TABLE bookings; --", '" OR ""="', '%', '\\', '<script>alert(1)</script>', "Robert'); DROP TABLE users;--"]
  test('search/filter inputs never cause a server error and never drop data', async () => {
    const paths = (q) => [`/api/bookings?q=${q}`, `/api/bookings?hallId=${q}`, `/api/customers?q=${q}`, `/api/catering?q=${q}`, `/api/catering?status=${q}`, `/api/invoices?q=${q}`, `/api/audit?q=${q}`, `/api/notifications?status=${q}`, `/api/calendar/day?date=${q}`]
    const bad = []
    for (const p of payloads) for (const url of paths(encodeURIComponent(p))) {
      const r = await admin.get(url)
      if (r.status >= 500) bad.push(`${url} -> ${r.status}`)
    }
    assert.deepEqual(bad, [])
    assert.equal((await query('SELECT count(*)::int n FROM users')).rows[0].n >= 4, true)
    assert.equal((await query(`SELECT to_regclass('public.bookings') IS NOT NULL ok`)).rows[0].ok, true)
  })
  test('injection text in body fields is stored as plain text, not executed', async () => {
    const evil = "Robert'); DROP TABLE customers;-- <img src=x onerror=alert(1)>"
    const r = await staff.post('/api/bookings', { customer: { name: evil, phone: '9611111111', messageConsent: true }, hallId: hall.id, eventType: 'Wedding', date: futureDate(900), startTime: '10:00', endTime: '12:00', discount: 0, charges: [], foodItems: [], catering: null, notes: '<script>1</script>' })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(r.body.booking.customer.name, evil)
    assert.equal((await query(`SELECT to_regclass('public.customers') IS NOT NULL ok`)).rows[0].ok, true)
  })
  test('no API response exposes password hashes, tokens or session data', async () => {
    const urls = ['/api/users', '/api/auth/me', '/api/audit', '/api/settings', '/api/halls', '/api/customers']
    for (const u of urls) {
      const r = await admin.get(u)
      assert.ok(!/password_hash|passwordHash|\$argon|\$2[aby]\$|scrypt\$|token_hash/i.test(JSON.stringify(r.body)), `${u} leaks a credential field`)
    }
    const login = await anon.req('POST', '/api/auth/login', { username: 'admin', password: 'Passw0rd-admin' })
    assert.ok(!/hash|token/i.test(JSON.stringify(login.body)))
  })
  test('errors do not leak stack traces or SQL', async () => {
    const r = await admin.get('/api/bookings/not-a-uuid')
    assert.ok(r.status === 400 || r.status === 404, String(r.status))
    assert.ok(!/at .*\.js:\d+|SELECT |syntax error|pg_/i.test(JSON.stringify(r.body)))
  })
})

describe('image upload validation', () => {
  const url = () => `/api/halls/${hall.id}/images`
  test('a text file renamed .jpg is rejected', async () => {
    const r = await admin.post(url(), form([['fake.jpg', Buffer.from('this is not an image at all'), 'image/jpeg']]))
    assert.equal(r.status, 400, JSON.stringify(r.body))
  })
  test('SVG with script is rejected', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    const r = await admin.post(url(), form([['x.svg', svg, 'image/svg+xml']]))
    assert.equal(r.status, 400, JSON.stringify(r.body))
  })
  test('an oversized file is rejected with 413/400 and leaves nothing behind', async () => {
    const big = Buffer.alloc(9 * 1024 * 1024, 1)
    const r = await admin.post(url(), form([['big.png', big, 'image/png']]))
    assert.ok(r.status === 413 || r.status === 400, String(r.status))
    assert.equal((await admin.get('/api/halls')).body.halls.find((h) => h.id === hall.id).images.length, 0)
  })
  test('staff cannot upload; a valid PNG is accepted', async () => {
    assert.equal((await staff.post(url(), form([['a.png', await png(), 'image/png']]))).status, 403)
    const ok = await admin.post(url(), form([['a.png', await png(), 'image/png']]))
    assert.equal(ok.status, 201, JSON.stringify(ok.body))
  })
})
