// Offline shell for the PWA. PRIVACY RULE: only public, static files are ever cached.
// Never cached: /api/*, /uploads/*, health checks, non-GET requests, cross-origin requests, anything the server marks no-store/private.
const CACHE = 'rhr-static-v3'
const SHELL = ['/', '/manifest.webmanifest', '/images/logo.png']

// Same-origin GET for build output / public static files only.
const STATIC = /^\/(assets\/|images\/|icons\/|fonts\/)|^\/(manifest\.webmanifest|favicon\.[a-z]+)$/
const PRIVATE = /^\/(api|uploads|healthz)(\/|$)/

function isCacheableRequest(req) {
  if (req.method !== 'GET') return false
  const u = new URL(req.url)
  if (u.origin !== self.location.origin) return false
  if (PRIVATE.test(u.pathname)) return false
  return req.mode === 'navigate' || STATIC.test(u.pathname)
}
function isCacheableResponse(res) {
  if (!res || !res.ok || res.type === 'opaque' || res.status !== 200) return false
  const cc = (res.headers.get('Cache-Control') || '').toLowerCase()
  if (/no-store|private/.test(cc)) return false
  if (res.headers.get('Set-Cookie') || res.headers.get('Authorization')) return false
  return true
}

self.addEventListener('install', (e) => {
  self.skipWaiting()
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {})))))
})

// Delete EVERY other cache, including the earlier versions that stored API responses (customer, payment and invoice data).
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()))
})

// The page asks for a wipe on logout (defence in depth: nothing private is stored anyway).
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'CLEAR_CACHES') e.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))))
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (!isCacheableRequest(req)) return // browser handles it: straight to the network, no cache involved
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (isCacheableResponse(res)) {
          const copy = res.clone()
          // navigations all share the one app shell entry
          caches.open(CACHE).then((c) => c.put(req.mode === 'navigate' ? '/' : req, copy)).catch(() => {})
        }
        return res
      })
      .catch(() => caches.match(req.mode === 'navigate' ? '/' : req).then((r) => r || (req.mode === 'navigate' ? caches.match('/') : Response.error()))),
  )
})
