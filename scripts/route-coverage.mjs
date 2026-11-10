// API endpoint coverage: lists every route registered by the app and which ones the test suite really called.
//   ROUTE_COVERAGE_FILE=/tmp/hits.txt npm test && node scripts/route-coverage.mjs /tmp/hits.txt
import fs from 'node:fs'
process.env.NODE_ENV ||= 'test'
const { createApp } = await import('../server/app.js')
const app = createApp()
const prefixOf = (layer) => {
  const src = layer.regexp.source.replace('^\\/?(?=\\/|$)', '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/^\^/, '').replace(/\\\//g, '/')
  return src.replace(/\(\?:\(\[\^\/\]\+\?\)\)/g, ':p')
}
const routes = []
const walk = (stack, prefix) => {
  for (const l of stack) {
    if (l.route) for (const m of Object.keys(l.route.methods)) routes.push(`${m.toUpperCase()} ${prefix}${l.route.path}`)
    else if (l.name === 'router' && l.handle.stack) walk(l.handle.stack, prefix + prefixOf(l))
  }
}
walk(app._router.stack, '')
// Attribute each logged request to the FIRST registered route that matches it (Express's own rule).
const compiled = [...new Set(routes)].filter((r) => r.includes(' /api') || r.includes(' /healthz')).map((r) => {
  const [m, p] = r.split(' ')
  return { r, m, re: new RegExp('^' + p.replace(/\/$/, '').replace(/:[A-Za-z]+/g, '[^/]+') + '/?$') }
})
const hits = new Map()
const lines = fs.existsSync(process.argv[2] || '') ? fs.readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean) : []
for (const line of lines) {
  const [m, p, st] = line.split(' ')
  const hit = compiled.find((c) => c.m === m && c.re.test(p))
  if (hit) hits.set(hit.r, (hits.get(hit.r) || new Set()).add(Number(st)))
}
const rows = [...new Set(routes)].filter((r) => !r.includes('(?!')).map((r) => ({ r, st: [...(hits.get(r) || [])].sort() }))
const tested = rows.filter((x) => x.st.length), missing = rows.filter((x) => !x.st.length)
console.log(`API endpoints: ${rows.length}, called by tests: ${tested.length} (${((tested.length / rows.length) * 100).toFixed(1)}%)`)
console.log(`With both a success (2xx) and a client-error (4xx) case: ${tested.filter((x) => x.st.some((s) => s < 300) && x.st.some((s) => s >= 400 && s < 500)).length}`)
console.log('\nNOT called by any test:'); for (const x of missing) console.log('  ' + x.r)
console.log('\nCALLED but only success cases (no 4xx):'); for (const x of tested.filter((x) => !x.st.some((s) => s >= 400 && s < 500))) console.log(`  ${x.r}  [${x.st.join(',')}]`)
if (process.argv[3] === '--all') { console.log('\nCALLED:'); for (const x of tested) console.log(`  ${x.r}  [${x.st.join(',')}]`) }
process.exit(0)
