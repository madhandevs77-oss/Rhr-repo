import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { setup } from './helpers.js'

let env, query, seq = 0
const mkUser = async (extra = '') => {
  const name = `lg${++seq}x${extra}`
  const { hashPassword } = await import('../server/lib/auth.js')
  await query('INSERT INTO users (username,name,role,password_hash) VALUES ($1,$2,$3,$4)', [name, name, 'staff', await hashPassword('GoodPass-' + name)])
  return name
}
const login = (c, username, password) => c.req('POST', '/api/auth/login', { username, password })
const row = async (u) => (await query('SELECT failed_logins, locked_until, active FROM users WHERE username=$1', [u])).rows[0]
const ipOf = (n) => ({ 'x-forwarded-for': n }) // ignored unless TRUST_PROXY is on (see below)

before(async () => { env = await setup(); ({ query } = await import('../server/db/pool.js')) })
after(() => env.teardown())
const fresh = async () => { await query('DELETE FROM rate_limits') } // each test starts with clean limiter counters

describe('failed logins are counted atomically', () => {
  test('sequential wrong passwords lock at 5; the 6th is refused even with the right password; generic wording', async () => {
    await fresh(); const u = await mkUser(); const c = env.client()
    for (let i = 1; i <= 4; i++) { const r = await login(c, u, 'bad' + i); assert.equal(r.status, 401); assert.equal(r.body.error.message, 'Invalid username or password') }
    assert.equal((await row(u)).failed_logins, 4)
    assert.equal((await login(c, u, 'bad5')).status, 401)
    const st = await row(u); assert.equal(st.failed_logins, 5); assert.ok(st.locked_until && new Date(st.locked_until) > new Date())
    const locked = await login(c, u, 'GoodPass-' + u)
    assert.equal(locked.status, 429)
  })
  test('20 simultaneous wrong passwords: exactly 5 are verified, the rest are refused, the count is 5 (no lost updates)', async () => {
    await fresh(); const u = await mkUser(); const c = env.client()
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => login(c, u, 'wrong' + i)))
    const s401 = rs.filter((r) => r.status === 401).length, s429 = rs.filter((r) => r.status === 429).length
    assert.equal(s401, 5, `statuses: ${rs.map((r) => r.status)}`); assert.equal(s429, 15)
    const st = await row(u); assert.equal(st.failed_logins, 5); assert.ok(new Date(st.locked_until) > new Date())
  })
  test('simultaneous requests cannot bypass the threshold: right password among a burst after 4 failures', async () => {
    await fresh(); const u = await mkUser(); const c = env.client()
    for (let i = 0; i < 4; i++) await login(c, u, 'bad' + i)
    const rs = await Promise.all([login(c, u, 'x1'), login(c, u, 'x2'), login(c, u, 'x3'), login(c, u, 'x4')])
    assert.equal(rs.filter((r) => r.status === 401).length <= 1, true, 'at most the one remaining attempt is verified')
  })
  test('successful login resets the counter and any stale lock', async () => {
    await fresh(); const u = await mkUser(); const c = env.client()
    for (let i = 0; i < 3; i++) await login(c, u, 'bad' + i)
    assert.equal((await login(c, u, 'GoodPass-' + u)).status, 200)
    const st = await row(u); assert.equal(st.failed_logins, 0); assert.equal(st.locked_until, null)
  })
  test('after the lock expires the right password works, and one new mistake does not re-lock immediately', async () => {
    await fresh(); const u = await mkUser(); const c = env.client()
    for (let i = 0; i < 5; i++) await login(c, u, 'bad' + i)
    assert.equal((await login(c, u, 'GoodPass-' + u)).status, 429)
    await query(`UPDATE users SET locked_until = now() - interval '1 minute' WHERE username=$1`, [u])
    const wrong = await login(c, u, 'bad-after-expiry')
    assert.equal(wrong.status, 401); assert.equal((await row(u)).failed_logins, 1, 'count restarts after expiry')
    assert.equal((await login(c, u, 'GoodPass-' + u)).status, 200)
    // and the plain expiry + correct password path (fresh limiter counters: this test has used up the per-username allowance)
    await fresh()
    for (let i = 0; i < 5; i++) await login(c, u, 'bad' + i)
    await query(`UPDATE users SET locked_until = now() - interval '1 second' WHERE username=$1`, [u])
    assert.equal((await login(c, u, 'GoodPass-' + u)).status, 200)
  })
  test('deactivated account: generic 401 even with the right password, and nothing is counted', async () => {
    await fresh(); const u = await mkUser(); const c = env.client()
    await query('UPDATE users SET active=false WHERE username=$1', [u])
    const r = await login(c, u, 'GoodPass-' + u)
    assert.equal(r.status, 401); assert.equal(r.body.error.message, 'Invalid username or password')
    assert.equal((await row(u)).failed_logins, 0)
  })
  test('locked accounts look exactly like rate-limited ones, so account existence is not revealed', async () => {
    await fresh(); const u = await mkUser(); const c = env.client()
    for (let i = 0; i < 5; i++) await login(c, u, 'bad' + i)
    const locked = await login(c, u, 'x')
    const unknown = []; for (let i = 0; i < 11; i++) unknown.push(await login(env.client(), 'nobody-here', 'x' + i))
    assert.equal(unknown[10].status, 429)
    assert.equal(locked.status, unknown[10].status); assert.equal(locked.body.error.message, unknown[10].body.error.message); assert.equal(locked.body.error.code, unknown[10].body.error.code)
    assert.equal(unknown[0].status, 401); assert.equal(unknown[0].body.error.message, 'Invalid username or password')
  })
})

describe('shared (database) rate limits', () => {
  test('per-username limit is shared state in PostgreSQL, so a second app instance sees it', async () => {
    await fresh(); const c = env.client()
    for (let i = 0; i < 10; i++) await login(c, 'ghost-user', 'p' + i)
    const rows = (await query(`SELECT key, hits FROM rate_limits WHERE key LIKE 'login-user:%'`)).rows
    assert.equal(rows.length, 1); assert.equal(rows[0].hits, 10)
    assert.ok(!rows[0].key.includes('ghost'), 'keys are hashed')
    // "another task": a brand-new app object backed by the same database is limited too
    const { createApp } = await import('../server/app.js')
    const other = createApp().listen(0); await new Promise((r) => other.once('listening', r))
    try {
      const res = await fetch(`http://127.0.0.1:${other.address().port}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'rhr' }, body: JSON.stringify({ username: 'GHOST-user ', password: 'again' }) })
      assert.equal(res.status, 429, 'username is normalised (case/whitespace) and the counter is shared')
      assert.ok(res.headers.get('retry-after'))
    } finally { await new Promise((r) => other.close(r)) }
  })
  test('per-IP limit: 30 attempts per window across different usernames', async () => {
    await fresh(); const c = env.client(); let last
    for (let i = 0; i < 31; i++) last = await login(c, 'name' + i, 'x')
    assert.equal(last.status, 429)
  })
  test('window expiry resets the counter', async () => {
    await fresh(); const c = env.client()
    for (let i = 0; i < 10; i++) await login(c, 'ghost2', 'x')
    assert.equal((await login(c, 'ghost2', 'x')).status, 429)
    await query(`UPDATE rate_limits SET reset_at = now() - interval '1 second'`)
    assert.equal((await login(c, 'ghost2', 'x')).status, 401)
  })
  test('fails closed: if the counter table is unavailable the request is refused, never allowed unlimited', async () => {
    await fresh(); const c = env.client()
    await query('ALTER TABLE rate_limits RENAME TO rate_limits_x')
    try { assert.equal((await login(c, 'someone', 'x')).status, 503) } finally { await query('ALTER TABLE rate_limits_x RENAME TO rate_limits') }
  })
  test('a client-supplied X-Forwarded-For is ignored when no proxy is trusted (cannot dodge the IP limit)', async () => {
    await fresh(); const c = env.client(); let last
    for (let i = 0; i < 31; i++) last = await c.req('POST', '/api/auth/login', { username: 'xff' + i, password: 'x' }, { headers: ipOf('10.0.0.' + i) })
    assert.equal(last.status, 429)
  })
  test('with one trusted proxy hop only the right-most X-Forwarded-For entry is believed; without trust the header is ignored', async () => {
    const { config } = await import('../server/config.js')
    const { createApp } = await import('../server/app.js')
    const u = await mkUser('p')
    const ipOfLast = async () => (await query(`SELECT ip FROM audit_events WHERE action='Login Failed' ORDER BY id DESC LIMIT 1`)).rows[0].ip
    const hit = async (trust) => {
      config.trustProxy = trust; const srv = createApp().listen(0); await new Promise((r) => srv.once('listening', r))
      try { await fetch(`http://127.0.0.1:${srv.address().port}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'rhr', 'x-forwarded-for': '6.6.6.6, 9.9.9.9' }, body: JSON.stringify({ username: u, password: 'nope' }) }) } finally { await new Promise((r) => srv.close(r)); config.trustProxy = 0 }
      return ipOfLast()
    }
    await fresh()
    assert.equal(await hit(1), '9.9.9.9', 'spoofed left-hand entry ignored')
    assert.match(await hit(0), /127\.0\.0\.1$/, 'header ignored when no proxy is trusted')
  })
})
