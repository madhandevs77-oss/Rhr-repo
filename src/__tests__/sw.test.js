// Runs public/sw.js in a sandbox with a fake Cache Storage and checks what it will and will not store.
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { beforeEach, describe, expect, test } from 'vitest'

const src = fs.readFileSync(path.resolve(process.cwd(), 'public/sw.js'), 'utf8')
const ORIGIN = 'https://rhr.example'

function makeEnv({ network }) {
  const stores = new Map() // cacheName -> Map(key -> response)
  const listeners = {}
  const keyOf = (r) => (typeof r === 'string' ? r : new URL(r.url).pathname + new URL(r.url).search)
  const openCache = (name) => {
    if (!stores.has(name)) stores.set(name, new Map())
    const m = stores.get(name)
    return Promise.resolve({
      put: (k, v) => { m.set(keyOf(k), v); return Promise.resolve() },
      add: (k) => { m.set(keyOf(typeof k === 'string' ? k : k), { ok: true, status: 200, headers: new Headers(), clone() { return this } }); return Promise.resolve() },
    })
  }
  const caches = {
    open: openCache,
    keys: () => Promise.resolve([...stores.keys()]),
    delete: (k) => Promise.resolve(stores.delete(k)),
    match: (k) => { for (const m of stores.values()) if (m.has(keyOf(k))) return Promise.resolve(m.get(keyOf(k))); return Promise.resolve(undefined) },
  }
  const fetchCalls = []
  const sandbox = {
    self: { location: { origin: ORIGIN }, addEventListener: (t, fn) => { listeners[t] = fn }, skipWaiting() {}, clients: { claim: () => Promise.resolve() } },
    caches, URL, Request: class { constructor(u) { this.url = new URL(u, ORIGIN).href } }, Response: { error: () => ({ error: true }) },
    fetch: (req) => { fetchCalls.push(req.url); return network(req) },
    Headers,
  }
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox)
  const fire = async (type, ev) => { let p; listeners[type]({ ...ev, waitUntil: (x) => { p = x }, respondWith: (x) => { p = x; ev._responded = true } }); return p }
  const req = (path, o = {}) => ({ url: ORIGIN + path, method: 'GET', mode: 'cors', ...o })
  const fetchEvent = async (r) => {
    let responded = false, p
    listeners.fetch({ request: r, respondWith: (x) => { responded = true; p = x } })
    return { responded, res: responded ? await p : undefined }
  }
  return { stores, fire, req, fetchEvent, fetchCalls }
}
const okRes = (headers = {}) => ({ ok: true, status: 200, type: 'basic', headers: new Headers(headers), clone() { return this } })
let env
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('service worker privacy', () => {
  beforeEach(() => { env = makeEnv({ network: async () => okRes() }) })

  test('API, uploads, health and other private paths are never intercepted or stored', async () => {
    for (const p of ['/api/bookings', '/api/payments/pending', '/api/customers?q=a', '/api/invoices/123/pdf', '/uploads/halls/x.webp', '/healthz']) {
      const r = await env.fetchEvent(env.req(p)); await flush()
      expect(r.responded, p).toBe(false)
    }
    expect([...env.stores.values()].every((m) => m.size === 0)).toBe(true)
  })
  test('non-GET requests and cross-origin requests bypass the worker', async () => {
    expect((await env.fetchEvent(env.req('/assets/a.js', { method: 'POST' }))).responded).toBe(false)
    expect((await env.fetchEvent({ url: 'https://evil.example/assets/a.js', method: 'GET', mode: 'cors' })).responded).toBe(false)
  })
  test('static assets are cached and still served when the network is down', async () => {
    await env.fire('install', {})
    await env.fetchEvent(env.req('/assets/index-abc.js')); await flush()
    const off = makeEnv({ network: async () => { throw new Error('offline') } })
    for (const [k, v] of env.stores) off.stores.set(k, v)
    const r = await off.fetchEvent(off.req('/assets/index-abc.js'))
    expect(r.responded).toBe(true); expect(r.res.ok).toBe(true)
  })
  test('the app shell is served offline for page navigations', async () => {
    await env.fire('install', {})
    const off = makeEnv({ network: async () => { throw new Error('offline') } })
    for (const [k, v] of env.stores) off.stores.set(k, v)
    const r = await off.fetchEvent(off.req('/bookings', { mode: 'navigate' }))
    expect(r.res.ok).toBe(true)
  })
  test('responses marked no-store/private are not stored even for static paths', async () => {
    const e = makeEnv({ network: async () => okRes({ 'Cache-Control': 'private, no-store' }) })
    await e.fetchEvent(e.req('/assets/secret.js')); await flush()
    expect([...e.stores.values()].every((m) => m.size === 0)).toBe(true)
  })
  test('activation deletes every older cache (including ones that held API data)', async () => {
    env.stores.set('rhr-booking-v2', new Map([['/api/customers', okRes()]]))
    env.stores.set('rhr-booking-v1', new Map())
    await env.fire('install', {})
    await env.fire('activate', {})
    expect([...env.stores.keys()]).toEqual(['rhr-static-v3'])
  })
  test('CLEAR_CACHES message (sent at logout) removes all caches', async () => {
    await env.fire('install', {})
    await env.fire('message', { data: { type: 'CLEAR_CACHES' } })
    expect(env.stores.size).toBe(0)
  })
})
