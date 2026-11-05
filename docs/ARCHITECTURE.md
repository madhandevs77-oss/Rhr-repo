# Architecture, risks and migrations

## Before / after
The original app was a React + Vite single-page app keeping everything in browser `localStorage` (no backend, no
authentication, base64 photos, totals computed in the browser). That cannot guarantee unique bookings, verified payments,
immutable invoices or privacy, so a backend was added.

```
Browser (React 18 + Vite)  ──HTTPS──▶  Express API  ──▶  PostgreSQL 16
  HttpOnly session cookie               zod validation       EXCLUDE constraint (no overlaps)
  no secrets, no money math             RBAC, CSRF header    append-only triggers
                                        pdfkit invoices      gap-free counters
                                        sharp image pipeline
                                        notification outbox worker ──▶ SMS / WhatsApp provider (mock | Twilio | Meta)
                                        local disk storage/uploads (swap storage.js for S3)
```
One Node process serves `/api`, `/uploads` and the built SPA (`dist/`).

## Where each requirement is enforced
| Concern | Enforcement |
|---|---|
| Double booking | `bookings_no_overlap` GiST EXCLUDE on (hall, date, time range) for non-cancelled rows; adjacent slots allowed; edits exclude themselves; concurrent requests → one 201, rest 409 `HALL_CONFLICT` |
| Concurrent edits | `version` column + `expectedVersion`, `SELECT … FOR UPDATE`, retry on 40001/40P01 |
| Money | integer paise in code, NUMERIC(12,2) + CHECKs in DB; totals computed only by `services/pricing.js` |
| Payments | status pending/verified/rejected/reversed; only **verified** money counts; four-eyes (cannot verify your own); idempotency key and (provider, external_ref) unique; refunds are separate rows; rows are append-only (trigger) |
| Invoices | issued automatically when verified balance reaches 0; unique gap-free number; immutable snapshot (trigger); corrections supersede, never overwrite; PDF regenerated from the snapshot |
| Confirmation messages | queued only after a verified advance, via an outbox with unique dedupe keys; failures never roll back money/booking; staff retry; consent required |
| Hall photos | admin only; magic-byte sniff, size/dimension limits, re-encoded to WebP, EXIF stripped, server UUID filenames, no base64 anywhere |
| Catering | separate module/tables; renamable options A/B/C; state machine; payment status separate from fulfilment; vendor cost separate from customer charge; versions kept on confirmed edits |
| Auth | scrypt, server-side sessions, SameSite=Strict, CSRF header, rate limit + lockout, roles admin/manager/staff |
| Audit | append-only audit log of who/when/what |

## Release-blocking risks and mitigations
Double bookings (DB constraint) · wrong invoices (immutable snapshots, verified-only) · false payment confirmation (pending state, four-eyes) ·
duplicate notifications (dedupe keys) · data loss (central DB, `npm run backup` with checksums, `verify-restore` into a scratch DB, forward-only checksummed migrations with advisory lock) ·
unauthorized access (RBAC on every route, tested) · unsafe uploads (re-encode) · concurrent edits (versioning) · provider outages (outbox + retry/backoff).

## Migrations
`001_core` (halls, images, customers, bookings, counters, audit) · `002_catering` · `003_finance` (payments, allocations, invoices, quotations) ·
`004_notifications` · `005_defaults` · `006_legacy_ids`. Applied automatically at start and by `npm run migrate`; a changed already-applied file is refused.
Legacy browser data is imported by an admin from **Settings → Data tools** (dry-run first; idempotent; reference collisions get a new reference, never merged).
