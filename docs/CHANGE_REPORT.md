# Round 4b — Menu tab restored, bug sweep

- **Menu tab is back in the footer** (Home · Bookings · Calendar · Catering · Menu · More). It lists the managed Catering Menu by category with tick boxes (Select all per category, search, prices shown). "Use in catering order →" opens a new order with those dishes already selected; the order sheet still has the service type choice (Full Catering Service / Bulk Food Supply Only / External Catering Partner). Managing the menu stays in More → Catering Menu; prices in More → Catering Prices.
- Dishes with no catering price yet make the new order default to price-per-plate (the dishes then simply form the menu list) instead of blocking you.
- The tick list is cleared once it has been used, so the next new order starts empty.
- Fixed: the JSON data export and the backup manifest did not include the new tables (menu categories/items, catering prices, payment splits, drafts); restoring older backups still works.
- Fixed: "1 items" wording; 3 px sideways scroll on the Home statistics at 320 px; ⋮ menus near the bottom of the screen now open upwards.
- Sweep: every footer tab, every More page and Manage Halls opened as admin, manager and staff — no script errors, failed requests, or "undefined / NaN" text.

# Round 4 — Catering Menu & Prices in More, catering orders from the menu, hall photos, drafts (migration 011)

**Database (migration 011, run `npm run migrate`)**
- `catering_prices` — one price + unit per Catering Menu item (kept apart from the menu).
- `catering_order_items.meal_item_id` — order lines now link to the managed menu. Old lines keep their frozen name/unit/price.
- Your earlier priced list (`menu_items`, e.g. Beverages, Breakfast / Tiffin, Unlimited Meals) is copied into the Catering Menu as categories/items with its prices. The old table is untouched. These categories also show in the hall/outsource food picker; deactivate any you don't want there with ⋮ → Deactivate.
- `drafts` — saved unsubmitted forms (never bookings, history or availability).

**Screens**
- Footer is now Home · Bookings · Calendar · Catering · More. More has **Catering Menu** (categories + items) and **Catering Prices** (price per item). The old "tick items" page is gone.
- Menu management: default view is category name, item count and expand arrow only; Rename / Activate-Deactivate / Move up / Move down / Delete live in a ⋮ dropdown (items: Edit / Activate-Deactivate / Move / Delete). Delete asks for confirmation.
- New catering order: items come from the active Catering Menu, grouped by category with search, a quantity per item, price/unit from Catering Prices (managers can override; staff are told to ask a manager if an item has no price). Deactivated items cannot be added to new orders. The order button now says "Create order".
- Halls on Home: larger photo-first cards, admin "Add / Change photo" shortcut (opens that hall's Photos tab), photo gallery on tap, same size cards, responsive 1/2/3 columns.
- Drafts: **Save as Draft** on the hall/outsource booking form and the catering form. Home shows Draft Bookings (type, hall, customer, last saved, status) with Continue (restores everything, never creates a booking) and Delete (confirmation). Submitting the real booking/order removes its draft in the same transaction. Payment details are never stored in a draft.

**Files**: server — `db/migrations/011_*.sql`, `routes/drafts.js` (new), `routes/core.js`, `routes/catering.js`, `services/catering.js`, `app.js`; frontend — `App.jsx`, `drafts.js` (new), `components/common.jsx` (KebabMenu), `screens/{MealMenu,Admin,CateringForm,SectionBooking,BookingRouter,Home,Halls}.jsx`, `store.jsx`, `styles.css`; tests — `tests/drafts-prices.test.js`; e2e — `e2e/catering-drafts.py`.

# Round 3 — one hall list, no GST, kitchen sheet, bill and receipts (migration 010)

- **Halls vs Outsource:** Home, Calendar and Bookings show *Halls* = Mandapam, Mini Hall and every hall added later (including the three older halls); *Outsource* = Outsource 1–5. The separate "Our Halls" block is gone. One booking form serves every hall; older bookings keep their data when edited.
- **No GST:** nothing adds tax automatically. Staff add GST (or anything else) as an *Extra charge* line. Older bookings that already carry tax keep it until a manager ticks "Remove GST".
- **Extra amount** (one number, no reason) and **Extra charges** (each line = reason + amount). Staff may add both; only manager/admin can change the maintenance charge, give a discount or change tax. Every hall now has a default maintenance charge.
- **Kitchen sheet** (print + PDF): hall, date, time, meals and category/item names only — no customer, amounts or notes.
- **Customer bill** (PDF): all charges, every verified payment (advance and final) with its Cash/Card/GPay/UPI split, total paid and balance.
- **Receipt** (PDF) per verified payment, e.g. the advance: split by method, amount received, paid so far, balance.
- Roles unchanged (to be revisited later).

# Change report

## Test results (actually executed, 2026-10-16)
- `npm test` (Node test runner, throw-away PostgreSQL 16 DB, mock messaging): **76 tests, 76 pass, 0 fail** (core 18, finance 21, catering 15, system 17, unit 5).
- `npx vite build`: succeeds.
- Browser (headless Chromium via Playwright, production build served by Express), run by hand against a dev DB:
  login; header "Halls" button; hall photo upload (2 files, progress, list updated); new-booking wizard with a ₹10,000 verified advance →
  booking confirmed + auto invoice INV/2026-27/000001; invoice view; A4 print-to-PDF (1 page, UI hidden); catering form;
  no console errors / failed requests; no horizontal overflow at 390 px. Scripts: `e2e/*.py` (manual, need `pip install playwright`; not part of `npm test`).
- Bugs found by this run and fixed: blank New Booking / New Catering form (Async treated "no existing record" as empty); catering form fields overflowing at phone width; service worker could cache `/api` responses (now bypassed).

## Update: bill and thank-you messages (email + text)
- New: email channel over SMTP (nodemailer), invoice PDF attached; automatic bill on the first invoice; automatic thank-you after the event / on delivery; manual "Send to customer" and "Send thank-you"; settings, templates (EN/TA) and screens. Migration `007_email_bill_thanks.sql`.
- Tests: `npm test` now **91 tests, 91 pass** (15 new in `tests/bill.test.js`, including delivery through a real in-process SMTP server with the PDF attachment, rejected mailbox, dead server then recovery, no duplicates, no consent, look-back and delay).
- Not tested here: a real Gmail/other SMTP account, Twilio/WhatsApp (unchanged), Tamil wording review.

## Completed
Hall booking CRUD with server-side overlap/capacity checks and concurrency safety; hall management with secure multi-photo upload; payments with verification and allocation;
automatic immutable invoices, PDF, print and reprint; confirmation messages (mock/Twilio/Meta) with outbox, retry, dedupe and consent; edit with impact preview and approval;
Bulk Catering module (3 renamable options, lifecycle, vendors, quotations, versions); RBAC, audit, backup/verify-restore, legacy import, Docker config, docs.

## Not done / known limitations
- Twilio and Meta providers are implemented to their documented APIs but were **never run against the real services** (only the mock and signature checks were tested). Test with your own sandbox accounts before go-live.
- No real payment-gateway integration (manual recording + a signed webhook interface only).
- No silent/Bluetooth/thermal printing. PDF/browser print only.
- Browser tests are manual scripts, not in `npm test`; only Chromium at 390 px and 1280 px was checked; screen-reader/accessibility audit not performed.
- Tamil message templates need native-speaker review.
- Uploads use local disk; use a persistent volume (or replace `server/lib/storage.js` with S3) in production.
- Some assertions in the transient-failure messaging test are loose.
- Docker files were written but not built here.

## Update: seven sections, price-free meal menu, manual food amount + GST, calendar, split payments
- **Sections**: Mandapam, Mini Hall, Outsource 1–5 are `halls` rows with `kind`/`section_order`/`default_charge` (migration `008`). An existing hall with a matching name is reused (photos and bookings kept); other halls stay as legacy halls and keep the original booking form (without guests). Defaults: Mandapam ₹15,000, Mini Hall ₹5,000 (maintenance, per 3-hour slot), Outsource ₹0. Sections cannot be deleted.
- **Pricing (server-side only)**: maintenance + manager-entered additional charges + manual food-service amount − discount = taxable; GST 5% (`finance.sectionGstRate`) added once and frozen on the booking. Menu selection never affects totals. Only manager/admin can change the maintenance charge, add extra charges or a discount; staff may enter the food amount once, after which a manager must change it. Edits of confirmed bookings still need impact confirmation and are recorded in history.
- **Meal menu**: `meal_menu_items` (breakfast/lunch/dinner, names only, no price column), seeded from the lists in the brief; add/edit/deactivate/delete. Bookings store `{id,name,meal}` snapshots that survive rename/delete. Old priced catering menu is untouched (More → Catering menu / Catering prices).
- **Menu print / PDF**: `GET /api/meal-menu/booking/:id` (+ `/pdf`) return only meal headings and item names. Tests extract the PDF text and assert no customer, contact, reference, date, hall, price, GST or payment text.
- **Calendar**: `/api/calendar` (red-dot counts, section filter) and `/api/calendar/day` (grouped by the seven sections; totals/balance only for manager/admin).
- **Payments**: one payment may be split across Cash / GPay / UPI / Card (also Bank Transfer, Cheque, Other via API) stored in immutable `payment_splits`; splits must add up; verification and balances are unchanged (verified money only); idempotency key prevents double clicks.
- **Tests**: `npm test` → **119 tests, 119 pass** (28 new in `tests/sections.test.js`; one old fixture hall renamed "Mini Hall"→"Garden Hall" because that name is now a section). Browser: `e2e/sections-flow.py` (Chromium at 320/390/768/1280: 7 cards, no guest field, split advance, menu preview/print to a 1-page PDF, red dot + grouped list, no overflow, no console/network errors).
- **Superseded by the next update**: meals are now dynamic categories and guest/capacity no longer exist (see below). **Limitations (older)**: reference photos were not received — menu seeded from the text lists (names such as "Raita" use the common spelling); slots cannot cross midnight (end must be after start, same day); non-section halls use the original booking form; bookings placed in legacy halls are shown under "Other halls" on the calendar; Safari/real phones not tested.

## Update: corrected requirements (Halls / Outsource sections, no guests, dynamic menu categories)
- **Dashboard**: "Halls" (Mandapam, Mini Hall) and a separate "Outsource Bookings" section (Outsource 1–5). Each card: today's status, upcoming, New Booking (section preselected), History, Calendar. General New Booking button kept.
- **Guest count / capacity removed completely** (migration `009_categories_no_guests.sql`): columns `bookings.guests`, `catering_orders.guests`, `halls.capacity` dropped; capacity validation, "plates vs guests" check, `{{guest_count}}` template placeholder, forms, cards, reports and API fields removed. The old values were first copied to `legacy_guest_data_archive` (not used by the app; `DROP TABLE legacy_guest_data_archive;` removes it). Already-issued invoices are immutable and may still print an old "Guests: N" line they were issued with. If you use an approved WhatsApp template that contains a guest variable, re-submit it without that variable (the app no longer sends it).
- **Menu Management** (footer "Menu" tab, also More): dynamic categories (create / rename / reorder / deactivate / delete) and items (add / edit / reorder / deactivate / delete), saved in PostgreSQL (`menu_categories`, `meal_menu_items`). Seeded with Royal Breakfast / Royal Lunch / Royal Dinner (the lists from your first brief, migrated from the previous fixed meals). Manager/admin only. Booking form shows every active category with checkbox items (names only, searchable). Bookings keep a frozen copy `{name, category, order}`, so later menu/category changes never alter them.
- **Booking form**: Breakfast / Lunch / Dinner are kept as "meal / service options"; categories are separate. Food-service charge stays manual and tax-inclusive of nothing automatic.
- **Print / PDF**: category headings (in menu order) with the booking's selected item names only.
- **Calendar**: filter All / Halls / Outsource Bookings / one section (`group=halls|outsource`).
- **Payments**: UI checkboxes for Cash, Card, GPay, UPI with per-method amounts; payments panel shows confirmed amount, total advance, total final, total paid, outstanding. Tests cover advance Cash 2,000 + Card 1,000 then final GPay + UPI, and ₹10,000 = Cash 5,000 + Card 2,000 + UPI 3,000.
- **Tests**: `npm test` → 123 tests, 123 pass. Browser run (`e2e/sections-flow.py`) at 320 / 390 / 768 / 1280 px passes (2 hall cards + 5 outsource cards, no "guest"/"capacity" text, create category + item in Menu Management, booking with new category, split advance, 1-page menu print, red dot, no overflow/console errors).
- **Not verified**: Safari / real phones; the existing `e2e/booking-flow.py`, `mobile-overflow.py`, `menu-and-responsive.py`, `bill-ui.py` scripts predate these changes and were not re-run.

## Round 5 — Audit & bug-fix pass

**Fixed (code changed):**
- HIGH — `server/services/payments.js` `allocate()`: explicit allocations were checked per entry, so two `hall` entries could together exceed the hall balance. They are now summed per bucket before validation and stored as one row per bucket.
- LOW — `server/routes/halls.js` `writeProcessed()`: if the thumbnail write failed after the main image was written, the main file was left orphaned (also on the replace path). It now removes both files on failure.

**Verified by tests, no change needed:** idempotency key reused on another booking (409, not silently reused); concurrent reuse of one key across two bookings (one payment, no 500); concurrent payments cannot overshoot the balance; password change signs out all sessions.
**Reviewed by reading, no defect found:** cookie flags (httpOnly, SameSite=Strict, secure via config), CSRF header guard, login lockout and rate limit, image validation and cover/reorder/delete sync.

**Not done / remaining:** no failure-injection test for disk-write errors on image upload; frontend stale-data and accessibility audit not performed in this pass; refund/reversal, restore-conflict and catering edge cases rely on existing tests only; no migration added (none needed).
**Tests run:** `npm test` 145/145 passed (5 new in `tests/audit-fixes.test.js`); `npm run build` OK.

## Round 6 — Free cloud deployment (Render + Neon + Supabase)
- `server/lib/storage.js`: local and Supabase drivers, same keys; `server/config.js`: STORAGE_DRIVER/SUPABASE_*, DATABASE_SSL, MIGRATE_DATABASE_URL, production safety checks, trust proxy on Render.
- `server/db/pool.js`: idle-error handler, timeouts, `waitForDb`, `runMigrations` (direct connection); `server/index.js`: migration failure stops start, weak admin password refused, graceful shutdown.
- `server/app.js`: `/healthz`, CSP img-src for Supabase origin. `server/scripts/upload-local-images.js`, `backup.js` (direct URL), `render.yaml`, `DEPLOYMENT.md`, `.env.example`, `package.json` (engines, script).
- Tests: `tests/storage-supabase.test.js` (6, against an in-process HTTP server that imitates Supabase's routes). Full suite 151/151, build OK, real production start verified against a fresh local database.
- NOT verified: real Neon, Supabase or Render accounts, real SMTP/Twilio, Render's blocked SMTP ports.

## Round 7 — One Menu tab for orders; Outsource = delivery or takeaway
- Footer: the separate Catering tab is gone. The Menu tab now has **Menu | Orders**; "Use in order →" opens the new order page, and the Orders view lists/opens existing orders (nothing removed, no data change).
- Outsource sections: new "Delivery or takeaway" card (default Takeaway). Delivery requires an address. Maintenance charge field is hidden for outsource. Saved on the booking (migration 012: `fulfilment`, `delivery_address`, CHECK delivery ⇒ address), shown on the booking detail and on the Calendar day list. Normal halls never store it. Server rejects delivery without an address (`DELIVERY_ADDRESS_REQUIRED`); changes are audited.
- Tests: `tests/outsource-fulfilment.test.js` (4); `e2e/outsource-orders.py` (tabs, Orders view, outsource delivery booking, address validation, detail, calendar). Full suite 155/155, build OK.

## Round 8 — QA pass (see QA_REPORT.md, TESTING.md)
zod 4 + `npm audit fix` (0 vulnerabilities), `.gitignore`, ESLint (`npm run lint`), coverage/route-coverage scripts, 186 backend tests (new: security, api-gaps) and 9 browser scripts, all passing in the final run.


## Round 9 – AWS readiness
S3 storage driver; RDS CA/TLS config; production config validation; Vitest frontend tests; `fmt` NaN fix; zod/vitest upgrades; CI frontend + Docker build; `.dockerignore`; `AWS_DEPLOYMENT.md`.
- Calendar now includes catering orders (day dot, day list with time/plates/delivery address, opens the order); new test file tests/calendar-catering.test.js; catering form: message when no service type is switched on, price-per-plate initial value fixed.

## Round 10 – security audit
Service worker no longer caches private data (+ cleanup of old caches, `no-cache` for `sw.js`); atomic failed-login counting; shared PostgreSQL rate limits (migration 013) with per-IP and per-username limits and fail-closed behaviour; `TRUST_PROXY` hop count; logout/expiry clears all account state; housekeeping of expired sessions/limiter rows; FK indexes (migration 014); dead code removed (lint clean); migration runner accepts a directory (tests); new tests: login-hardening, migrations, booking-integrity, SW, logout, roles/forms.

## Round 11
Outsource date/time optional with automatic +3 h end and next-day rollover (migration 015); bulk-order advance with several payment methods (SplitPay, server validation of splits); pickup hides venue/address; undated bookings listed under "Date not set"; null-safe date/time in PDFs, kitchen sheet and messages.
