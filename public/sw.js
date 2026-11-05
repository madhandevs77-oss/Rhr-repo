// Minimal offline cache: network-first for the app shell, cache fallback when offline.
const CACHE = 'rhr-booking-v2'

self.addEventListener('install', (e) => {
  self.skipWaiting()
    e.waitUntil(
    caches.open(CACHE).then((c) =>
      Promise.all(['./', './manifest.webmanifest', './images/logo.png'].map((u) => c.add(u).catch(() => {}))),
    ),
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url)
  // Never cache authenticated API data or uploaded files: always go to the network.
    if (u.pathname.startsWith('/@vite') || u.pathname.startsWith('/@react-refresh') || u.pathname.startsWith('/@id/') || u.pathname.startsWith('/@fs/') || u.pathname.startsWith('/src/') || u.pathname.startsWith('/node_modules/') || u.pathname.startsWith('/__vite') || u.searchParams.has('t') || u.searchParams.has('import')) return
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)) }
        return res
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./'))),
  )
})
