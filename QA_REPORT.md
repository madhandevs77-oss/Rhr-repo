# QA report — RHR Booking

Date of the final run: 8 Nov 2026. Everything below was produced by commands actually run in the development sandbox (Node 22, PostgreSQL 16, Chromium via Playwright). Where something could not be run, it is marked **BLOCKED** or **NOT TESTED** with the reason.

## 1. Project audit

**Architecture.** React 18 + Vite (no router; navigation stack), Express 4 API (`server/routes`, `server/services`, `server/lib`), PostgreSQL (11 forward-only checksummed migrations → now 12), sessions in the database with an HttpOnly cookie, money in integer paise, append-only audit/payment tables, optimistic locking on bookings, a GiST exclusion constraint that makes overlapping bookings impossible at database level, Supabase/local image storage, mock-by-default notification providers.

**Major issues found (by priority)**
| Priority | Issue | Status |
|---|---|---|
| High | Payment allocation: duplicate bucket entries were checked one by one and could together exceed that bucket's balance | **Fixed** |
| High | `npm audit`: `zod` (<4.6.6) denial-of-service on oversized input; `body-parser`/`multer` advisories | **Fixed** (zod 4 upgrade, `npm audit fix`); `npm audit` now reports 0 vulnerabilities |
| Medium | `.gitignore` did not exclude `.env.*` variants or `backups/` (risk of committing secrets/backups) | **Fixed** |
| Medium | Hall image upload could leave an orphaned main file if the thumbnail write failed (upload and replace) | **Fixed** |
| Medium | No lint step existed; dead imports present | **Fixed** (ESLint added, unused imports removed; 8 unused-variable warnings remain) |
| Low | 4 browser (Playwright) scripts were out of date with the current UI | **Fixed** (3 updated, 1 rewritten, 1 obsolete script removed – see §2) |
| Info | The "sliding expiry" comment in `server/lib/auth.js` is misleading: sessions have a fixed expiry (only `last_seen_at` is refreshed). Behaviour is safe; comment not changed | Open (cosmetic) |

**Security issues.** No authentication bypass, SQL injection, XSS, CSRF, CORS, session or upload weaknesses were found by the tests in §3. Cookies are HttpOnly + SameSite=Strict (+Secure in production); passwords hashed; login lockout and rate limits present; API responses carry no credential fields. The one dependency finding is fixed above.

**Deployment blockers (resolved earlier in this project, see DEPLOYMENT.md).** Ephemeral Render disk (→ Supabase storage driver), Neon SSL/pooling/cold start (→ pool settings, direct migration connection, startup retry), proxy/cookie settings, health check, graceful shutdown, weak/dev credentials in production (→ start-up refusal).
**Still outstanding for real deployment:** the Render/Neon/Supabase accounts themselves were never exercised (BLOCKED – no accounts/credentials here); SMTP is blocked on Render free; see §5.

## 2. Bugs fixed (this and the preceding audit rounds)

| # | Bug | Root cause | File(s) | Fix | Test |
|---|---|---|---|---|---|
| 1 | Two `hall` allocations could together exceed the hall balance | `allocate()` compared each line to `remaining[bucket]` independently | `server/services/payments.js` | Sum per bucket first, then compare; stored as one row per bucket | `audit-fixes.test.js` "duplicate bucket allocations…" |
| 2 | Orphaned image file when thumbnail write failed | `writeProcessed()` wrote main then thumb with no cleanup | `server/routes/halls.js` | Remove both on failure | `storage-supabase.test.js` "thumbnail upload failure leaves no orphan…" |
| 3 | Vulnerable dependencies | zod 3.x, body-parser, multer | `package.json`, `package-lock.json`, `server/routes/drafts.js` (`z.record` needs 2 args in zod 4) | Upgraded; full suite re-run on the new version | whole suite |
| 4 | `.env.*`, `backups/` not ignored | Incomplete `.gitignore` | `.gitignore` | Added; `.env.example` stays tracked | n/a (file check) |
| 5 | Unused imports / no lint | — | `server/routes/catering.js`, `sections.js`, `services/bookings.js`, `src/screens/Admin.jsx`, `BookingDetail.jsx`; `eslint.config.js`, `package.json` | Removed; `npm run lint` added | `npm run lint` → 0 errors |
| 6 | Stale e2e scripts (old footer/tab names, old form) | UI changed in later rounds | `e2e/*.py` | Updated 4, rewrote `booking-flow.py` for the current UI, removed `menu-and-responsive.py` (superseded by `menu-tab.py` + `mobile-overflow.py`; its screens no longer exist) | all 9 scripts pass |
| 7 | Cancelled-booking **restore success** path, hall delete success, pending-payments list and catering invoice issue had only refusal tests | — | `tests/api-gaps.test.js` | Success-path tests added (no code bug found) | api-gaps |
| 8 | Test hook / run helpers missing | — | `server/app.js` (env-gated request log, off by default), `scripts/route-coverage.mjs`, `scripts/run-route-coverage.mjs` | Added API-coverage tooling | `npm run test:routes` |

No test was deleted or skipped to get a green run. The only removed test file is the obsolete e2e script named above.

## 3. Feature testing

Status key: PASS = automated test executed and passed in the final run. NOT TESTED / BLOCKED as stated.

| Feature | Result | Evidence |
|---|---|---|
| Admin/user login, wrong password, generic message, no account enumeration | PASS | core, security |
| Logout invalidates session; session expiry; deactivated user locked out; password change signs out all sessions | PASS | core, security, audit-fixes |
| Unauthorized access to **every** protected route (anonymous → 401/403) | PASS | api-gaps (route-by-route sweep) |
| Role permissions (staff/manager/admin) | PASS | core, finance, api-gaps, security |
| First-admin bootstrap, weak admin password refused, duplicate admin | PASS (bootstrap + weak password verified by a real production start-up run in the earlier deployment round; not part of `npm test`) | manual start-up run |
| User create/edit/deactivate | PASS | system, security |
| Hall create/edit/blackouts/deactivate | PASS | core, sections, api-gaps |
| Hall images: upload, reorder, cover, replace, delete, thumbnails, invalid/oversized/SVG/renamed files | PASS (local driver) | core, security |
| Hall images with Supabase storage | PASS against an imitation of Supabase's HTTP API; **BLOCKED against real Supabase** (no account) | storage-supabase |
| Images survive restart/redeploy | PASS for the Supabase design (objects live outside the server); local driver depends on a persistent disk. Not tested on real Render | — |
| Booking create/edit/cancel/restore, validations, references | PASS | core, sections, e2e booking-flow |
| Overlap prevention, adjacent slots, 10 concurrent requests → one winner | PASS | core |
| Outsource delivery/takeaway, address rule, calendar display | PASS | outsource-fulfilment, e2e |
| Payments: record, advance/partial/full, split methods, allocation limits, duplicate allocations, idempotency (incl. across bookings and under concurrency), balance never overshoots under concurrency | PASS | finance, audit-fixes |
| Verification (four-eyes), reject, refund, reversal, history preserved | PASS | finance |
| Invoices, corrected invoices, bill + per-payment receipt PDFs | PASS | finance, bill-receipt |
| Catering orders: create/edit/cancel/status, totals, tax, discount, vendor, quotations | PASS | catering, api-gaps |
| Menu/prices: activate/deactivate, rename, price change leaves old orders unchanged, inactive item safe | PASS | drafts-prices, catering |
| Drafts | PASS | drafts-prices |
| Reports/dashboard numbers consistent with the ledger; empty month; bad month | PASS | system, api-gaps |
| Notifications: queue, templates, retry, run, provider status (mock providers only) | PASS | system, bill, api-gaps |
| Real email/SMS/WhatsApp delivery | **NOT TESTED** (no credentials; Render free blocks SMTP) | — |
| Backup / restore / verify | PASS | system |
| Migrations on a fresh database | PASS (every test file migrates a new database) | all |
| Migrations on an existing database (upgrade from an older version) | PASS for 010→012 in the development database over this project's life; no automated upgrade-path test | — |
| Security headers, CORS, CSRF, cookie flags, injection payloads on 9 list/search endpoints, XSS text stored inertly, no credential fields in responses | PASS | security |
| Production start-up (fresh DB, migrations, health, SPA, admin login, SIGTERM, refusal cases) | PASS (manual run in the deployment round, not repeated after the later changes except through the e2e scripts) | manual |
| Browser flows: booking, sections, outsource, catering/menu/drafts, bill, mobile overflow | PASS (9 of 9 scripts) | e2e |
| Frontend component tests (jsdom, form validation in isolation) | **NOT TESTED** – no component test framework; forms are covered through the browser scripts only | — |
| Cross-browser (Safari/Firefox), Tamil text, real devices | **NOT TESTED** | — |

## 4. Test coverage (numbers from the final run)

| Item | Value |
|---|---|
| Backend tests executed | **186 passed, 0 failed, 0 skipped** (`npm test`) |
| – unit-style (money, totals, settlement) | 5 + parts of system (`unit.test.js`) |
| – API / integration / database / security | the remaining ~181, all run against a real PostgreSQL |
| Browser end-to-end scripts | **9 passed, 0 failed** |
| Line coverage of `server/` (tests excluded) | **95.03 %** |
| Branch coverage | **76.69 %** |
| Function coverage | **90.79 %** |
| API endpoint coverage | **104 of 105 routes called (99.0 %)**; the one not counted, `GET /healthz`, is called by a test but outside the logger's `/api` scope |
| Endpoints with both a success and a client-error (4xx) test | **97 of 105 (92.4 %)** |
| Frontend code coverage | **not measured** (no instrumentation for the browser scripts) |
| Feature coverage | no single honest percentage exists; see the table in §3 |

Lowest-covered server files: `server/index.js` (63.7 %) and `server/db/pool.js` (70.7 %): start-up, migration retry and shutdown paths, which were verified by hand, not by `npm test`.

Other commands: `npm ci --include=dev` (earlier run completed), `npm run build` ✔, `npm run lint` → 0 errors / 8 warnings, `npm audit` → 0 vulnerabilities.

## 5. Remaining issues

| Priority | Issue |
|---|---|
| High (for going live) | Real Neon/Supabase/Render deployment not performed; follow DEPLOYMENT.md and run its verification list |
| High (if you need e-mail) | Render free blocks SMTP ports 25/465/587 – use a provider on another port or a paid plan; untested |
| Medium | No component-level frontend tests; no automated upgrade-path (old DB → new migrations) test |
| Medium | Bookings that cross midnight are not supported |
| Medium | 3 routes have no error-case test (`GET /api/health`, `GET /api/auth/me`, `POST /api/auth/logout`). 4 routes have no successful-call test: the 3 provider webhooks (need a valid provider signature; refusals are tested, accepted events are not) and the manual thank-you endpoint (its success path is only reachable after the automatic one finished; the duplicate refusal is tested) |
| Low | 8 ESLint unused-variable warnings; misleading "sliding expiry" comment; error messages from validation now come from zod 4 wording (slightly different text, same structure) |
| Low | Reports are not section-aware; Bookings and Calendar views overlap |
| Info | Password strength rules and roles are as originally specified; revisit roles later as agreed |

## 6. Deployment readiness

**Partially ready – ready for a demo, not yet verified for production.** The application builds, 186 backend tests and 9 browser scripts pass, dependencies are clean, and the Render/Neon/Supabase configuration, start-up safety checks and documentation are in place. It has not been run against the real cloud services, e-mail/SMS delivery is unverified, and there are no automated backups outside the manual `npm run backup`. Once DEPLOYMENT.md §10 passes on your accounts and a restore has been rehearsed, it is reasonable to start with real data.

## 7. AWS-readiness round (8 Nov 2026) – results of commands actually run

| Check | Result |
|---|---|
| `npm test` (backend, real PostgreSQL) | **196 passed, 0 failed, 0 skipped** |
| `npm run test:frontend` (Vitest, after upgrading to 5.1.0) | **17 passed, 0 failed** |
| `npm run lint` | 0 errors, 8 warnings (unused variables) |
| `npm run build` | OK |
| `npm audit` | **0 vulnerabilities** (Vitest upgraded to clear 1 moderate + 2 critical dev-tool advisories; production deps were clean) |
| Coverage of `server/` | lines 95.15 %, branches 77.15 %, functions 91.07 % |
| API route coverage | 104 of 106 routes called by tests (98.1 %), 97 with both success and 4xx |
| Browser scripts (9) | all ran; no failures or page errors reported |
| Docker image build | **BLOCKED** – no Docker daemon here; CI now builds it. A `.dockerignore` was added so `.env`/`node_modules` cannot enter the image |
| Anything on AWS (RDS TLS, S3, ECS, Secrets Manager, HTTPS) | **NOT TESTED** – no account. S3 driver tested only against an imitation S3 |

New this round: S3 storage driver, RDS TLS options, production config checks, frontend tests, CI (adds frontend tests and Docker build), `.dockerignore`, `AWS_DEPLOYMENT.md`. `fmt()` returned `₹NaN` for non-numeric input – fixed.

Recommendation: **staging-ready, not production-ready** until AWS_DEPLOYMENT.md §12 passes on a real account and a restore drill is done.
