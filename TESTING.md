# Testing guide

## What is used
- **Backend / API / database:** Node's built-in test runner (`node --test`), no extra framework. Each test file creates its **own temporary PostgreSQL database**, migrates it from scratch, runs, and drops it. Nothing touches your real or production (Neon) database.
- **Browser end-to-end:** Playwright (Python scripts in `e2e/`) against a running app.
- **Lint:** ESLint 9 (`eslint.config.js`).
- **Coverage:** Node's built-in coverage (`--experimental-test-coverage`).
- **Frontend components:** Vitest + jsdom + React Testing Library (`src/__tests__`, `npm run test:frontend`). Currently 31 tests: money/format helpers, the Login form, shared components, the service worker (run in a sandbox with a fake Cache Storage), logout/expiry state clearing, role-based menu and the change-password form. Booking/payment forms and role-based UI are covered only by the Playwright scripts, not by component tests.

## Prerequisites
1. Node 22+ and PostgreSQL 14+ running locally.
2. A database user that is allowed to create databases. By default tests connect as `rhr` / `rhr_dev_pw` on `127.0.0.1:5432`. Create it once:
   ```sql
   CREATE ROLE rhr LOGIN PASSWORD 'rhr_dev_pw' CREATEDB;
   ```
   To use another server or user set `TEST_ADMIN_DATABASE_URL` (a connection string allowed to `CREATE DATABASE`). Never point it at Neon production.
3. `npm ci --include=dev`

Tests use mock providers only: **no real emails, SMS, WhatsApp messages or payments are ever sent.** The Supabase storage tests talk to a small in-process HTTP server that imitates Supabase's routes, not to a real Supabase project.

## Commands
| Command | What it does |
|---|---|
| `npm test` | All backend tests (unit, API, database, security) |
| `npm run test:coverage` | Same, with line/branch/function coverage of `server/` |
| `npm run test:routes` | Runs the suite while logging requests, then prints which API routes were / were not called and which have both a success and an error test |
| `npm run test:frontend` | Vitest component/helper tests |
| `npm run lint` | ESLint (0 errors expected; a few unused-variable warnings remain) |
| `npm run build` | Production build of the React app |
| `npm audit` | Dependency vulnerabilities |

## Browser end-to-end scripts
They need `pip install playwright` + Chromium, a built app (`npm run build`) and a running server with an admin login (the scripts use the development admin shown in their first lines; change it if yours differs).
```bash
npm run build
npm start                       # or: node server/index.js   (default http://localhost:3001)
python3 e2e/booking-flow.py     # create / clash / edit / cancel / re-book
python3 e2e/sections-flow.py    # section booking, food picker, split advance, calendar, bill
python3 e2e/outsource-orders.py # footer tabs, Orders view, Outsource delivery/takeaway
python3 e2e/catering-drafts.py  # catering menu/prices, orders from the menu, drafts
python3 e2e/optional-and-split.py  # optional outsource date/time, +3h end, pickup fields, multi-method advance
python3 e2e/menu-tab.py  e2e/selectall.py  e2e/bill-ui.py  e2e/sweep.py  e2e/mobile-overflow.py
```
The scripts create test records in the database they run against. **Run them only against a development or throw-away database.** Screenshots are written to the session scratch folder set at the top of each script (edit `S=` if you run them elsewhere).

## Test files
| File | Area |
|---|---|
| `tests/unit.test.js` | money/paise parsing, rounding, totals, settlement maths |
| `tests/core.test.js` | auth, CSRF, permissions, hall images, bookings, overlaps, concurrency, cancel/restore, search |
| `tests/finance.test.js` | payments, allocations, verification (four-eyes), refunds, reversals, invoices |
| `tests/audit-fixes.test.js` | duplicate-bucket allocation, idempotency across bookings, concurrent payments, password change |
| `tests/sections.test.js` | sections/outsource, kitchen sheet, extras, calendar, food menu |
| `tests/outsource-fulfilment.test.js` | delivery/takeaway rules |
| `tests/catering.test.js`, `tests/drafts-prices.test.js` | catering orders, price snapshots, drafts, menu prices |
| `tests/bill.test.js`, `tests/bill-receipt.test.js` | PDFs, notifications through a local SMTP server |
| `tests/system.test.js` | users, settings, reports, audit, import, backup/restore, notification queue, lockout |
| `tests/security.test.js` | session expiry, deactivated users, injection, CORS, headers, data exposure, upload validation |
| `tests/api-gaps.test.js` | every protected route refuses anonymous callers; previously untested endpoints; report edge cases |
| `tests/storage-supabase.test.js` | Supabase storage driver incl. failure cleanup |
| `tests/login-hardening.test.js` | atomic failed-login counting, lockout and expiry, shared DB rate limits, fail-closed, proxy trust |
| `tests/migrations.test.js` | upgrade of an old database with data, failed/retried migration, tamper refusal, concurrent migrators |
| `tests/booking-integrity.test.js` | invalid hall/dates/blackout, anonymous refusal, ledger untouched by edit/cancel/restore |
| `tests/outsource-optional.test.js` | Outsource optional date/time, +3 h end, midnight rollover, overlaps, editing, bill/kitchen/messages |
| `tests/bulk-advance-splits.test.js` | bulk-order advance with 1–6 methods, rejected splits, DB rows, reports |
| `tests/calendar-catering.test.js` | catering orders on the calendar |
| `tests/storage-s3.test.js` | S3 driver against an in-process imitation of S3 (put/get/delete, no-overwrite, failure cleanup) |
| `tests/deploy-config.test.js` | production start-up refusals (placeholder DB, s3/supabase settings, missing CA file) |

## Troubleshooting
- `permission denied to create database` – the test user needs `CREATEDB`.
- Tests hang at start – PostgreSQL is not running or the URL/password is wrong.
- `Cannot find package …` after `npm ci` on Windows – close editors/terminals that hold files in `node_modules` and try again (see DEPLOYMENT.md troubleshooting).

Note: login attempts are rate limited per IP (30/15 min) and per username (10/15 min). Running the browser scripts repeatedly against one development database can hit that limit; clear it with `DELETE FROM rate_limits;` in the development database.
