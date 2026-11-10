// Cross-platform runner for `npm run test:routes`: runs the suite with request logging on, then prints the route report.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const file = path.join(os.tmpdir(), 'rhr-route-hits.txt')
fs.rmSync(file, { force: true })
const env = { ...process.env, ROUTE_COVERAGE_FILE: file }
const t = spawnSync(process.execPath, ['--test', '--test-concurrency=1', 'tests/*.test.js'], { env, stdio: 'inherit', shell: false })
const r = spawnSync(process.execPath, ['scripts/route-coverage.mjs', file], { env, stdio: 'inherit' })
process.exit(t.status || r.status || 0)
