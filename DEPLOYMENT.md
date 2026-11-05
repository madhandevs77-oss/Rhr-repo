# Deploying RHR Booking for free (Render + Neon + Supabase Storage + GitHub)

Architecture: one **Render free Web Service** runs the Express API and serves the built React app. Data lives in **Neon** (PostgreSQL). Hall photos live in a public **Supabase Storage** bucket. GitHub triggers every deploy.

```
Browser ──HTTPS──► Render (Node 22: API + React build)
                      ├──► Neon PostgreSQL   (DATABASE_URL, MIGRATE_DATABASE_URL)
                      └──► Supabase Storage  (service-role key stays on the server)
Browser ──HTTPS──► Supabase public bucket URL (photos only, read-only)
```

Dashboard labels change from time to time. If a label below differs slightly, look for the same setting nearby.

## 0. Free-tier limits (checked against the providers' own pages on 5 Nov 2026 — re-check before relying on them)

| Service | What the free plan gives | What it means for you |
|---|---|---|
| Render web service | 750 free instance hours per workspace per month; spins down after 15 min with no traffic; ~1 min to wake; **filesystem is ephemeral**; **outbound SMTP ports 25, 465, 587 are blocked**; no persistent disk; no shell | First visit after idle is slow. Photos cannot live on disk (hence Supabase). **Email over normal SMTP will not work** (see §11). |
| Neon | 1 GB storage per project; 100 CU-hours/month per project; compute auto-suspends after 5 min idle (cannot be disabled); 6 h instant-restore window, 1 manual snapshot | The first query after idle takes a moment (the app retries). 1 GB is plenty for bookings. Make your own backups (§12). |
| Supabase | 1 GB file storage; 50 MB max file; 5 GB egress; 2 active free projects; **projects are paused after 1 week of inactivity** | Photos are compressed to small WebP, so 1 GB holds thousands. A paused project makes photos disappear until you restore it (§11). |

Sources: <https://render.com/docs/free>, <https://neon.com/faqs/free-plan-limits-and-quotas>, <https://supabase.com/pricing>.

## 1. GitHub preparation

```bash
cd rhr-booking
git init
git add .
git status          # confirm .env, node_modules, dist and storage/ are NOT listed (they are in .gitignore)
git commit -m "RHR Booking"
```
Create an empty **private** repository on github.com (no README), then:
```bash
git remote add origin https://github.com/<you>/rhr-booking.git
git branch -M main
git push -u origin main
```
Never commit passwords or keys. All secrets are typed into the Render dashboard only.

## 2. Neon database

1. Sign in at neon.com → **Create project**. Name `rhr-booking`; pick the region nearest your Render region (e.g. both in Singapore if available); Postgres 16 or newer.
2. Open **Connect** in the project dashboard. You need two connection strings:
   - **Pooled** (host contains `-pooler`) → will be `DATABASE_URL`.
   - **Direct** (toggle "Connection pooling" off) → will be `MIGRATE_DATABASE_URL`. Migrations use a database lock that does not work through the pooler, so they must use the direct string.
3. Both end with `?sslmode=require`. Keep that. Do not set `DATABASE_SSL` unless you have a reason.

You do **not** run migrations by hand: the app applies them on every start and refuses to start if one fails.

## 3. Supabase Storage

1. supabase.com → **New project** (any name, strong database password, region near Render).
2. **Storage → New bucket**: name `hall-images`, switch **Public bucket ON** (browsers read photos directly). Writes still require the service key. Set file size limit to 10 MB; allowed MIME type `image/webp` (the app converts every upload to WebP).
3. **Project Settings → Data API** (or API): copy the **Project URL** (`https://xxxx.supabase.co`) → `SUPABASE_URL`.
4. **Project Settings → API Keys**: copy the **service_role** secret key → `SUPABASE_SERVICE_ROLE_KEY`. This key bypasses all access rules. It is only ever read by the server (`server/config.js`) and never sent to the browser. Do not paste it into chat, GitHub, or the front-end.

## 4. Render service

**Option A – Blueprint (recommended):** Render dashboard → **New → Blueprint** → pick the GitHub repo. Render reads `render.yaml`, creates the free service and asks for the secret values (step 6).

**Option B – manual:** **New → Web Service** → connect the repo, then:

| Setting | Value |
|---|---|
| Runtime / Language | Node |
| Branch | `main` |
| Region | same area as Neon |
| Instance type | **Free** |
| Build Command | `npm ci --include=dev && npm run build` |
| Start Command | `npm start` |
| Health Check Path | `/healthz` |
| Auto-Deploy | Yes |

(`--include=dev` is needed because Vite, which builds the React app, is a dev dependency.)

## 5. Build and start commands (reference)

- Build: `npm ci --include=dev && npm run build` → creates `dist/` (React).
- Start: `npm start` → `NODE_ENV=production node server/index.js`. On start the server waits for the database (retries ~15 s for Neon to wake), applies pending migrations on a direct connection, creates the first admin if no users exist, then listens on `$PORT` (Render sets it).
- Docker is still supported (`Dockerfile`, `docker-compose.yml`) for your own server; Render does not need it.

## 6. Environment variables (Render → service → Environment)

| Variable | Value | Notes |
|---|---|---|
| `NODE_VERSION` | `22` | |
| `NODE_ENV` | `production` | Turns on the safety checks below |
| `DATABASE_URL` | Neon **pooled** string | Required. App refuses to start without it, or if it still contains the development password |
| `MIGRATE_DATABASE_URL` | Neon **direct** string | Strongly recommended |
| `DB_POOL_MAX` | `5` | Keeps you under Neon's connection limits |
| `STORAGE_DRIVER` | `supabase` | Default is `local`, which loses photos on Render |
| `SUPABASE_URL` | `https://xxxx.supabase.co` | |
| `SUPABASE_SERVICE_ROLE_KEY` | secret | Server only |
| `SUPABASE_BUCKET` | `hall-images` | |
| `TRUST_PROXY` | `true` | Render is behind a proxy; needed for correct client IPs, rate limiting and lockouts (also defaults on when Render's `RENDER` variable is present) |
| `COOKIE_SECURE` | `true` | Cookies are HttpOnly, SameSite=Strict, Secure |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | your choice | Used **only** when the users table is empty. Password: 10+ characters with letters and numbers (weaker passwords stop the start-up). Delete both variables after the first successful login |
| `SESSION_HOURS` | `12` | optional |
| `SMTP_*`, `TWILIO_*`, `WHATSAPP_*`, `PAYMENT_WEBHOOK_SECRET` | optional | see `.env.example`; leave blank to stay in test mode (nothing is sent) |

Safety checks built in: the server exits at start-up if `DATABASE_URL` is missing or still holds the development/placeholder password, if `STORAGE_DRIVER=supabase` lacks its URL/key, or if the first-admin password is weak. Admin passwords are never written to logs.

## 7. Database migrations

Automatic on every start. If a migration fails, the process exits and Render keeps the previous working deploy. Check **Logs** for `Migration NNN failed: …`. Existing migration files must never be edited (the app refuses to start if an applied one changed).

Manual run (optional, from your own computer): `MIGRATE_DATABASE_URL=<direct string> npm run migrate`.

## 8. Admin account

Set `ADMIN_USERNAME` / `ADMIN_PASSWORD` before the first deploy, sign in, create real user accounts under **More → Users & roles**, change the admin password, then remove the two variables in Render. To reset or create an admin later from your own computer:

```bash
DATABASE_URL=<neon string> npm run create-admin -- <username> <new-password> "Full Name" admin
```

## 9. Move existing photos (only if you already have hall photos on disk)

```bash
STORAGE_DRIVER=supabase SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=... \
SUPABASE_BUCKET=hall-images UPLOAD_DIR=./storage/uploads DATABASE_URL=<neon string> \
npm run upload-local-images
```
It copies each photo and thumbnail using the **same keys**, so database rows need no change. To also carry over data, restore a backup into Neon first (§12).

## 10. Verify the deployment

1. `https://<your-service>.onrender.com/healthz` → `{"ok":true}` (the first request may take ~1 min).
2. `https://<your-service>.onrender.com/api/health` → `{"ok":true,...}` (this one also queries the database).
3. Open the site root; sign in with the admin account.
4. **Halls → open a hall → add a photo**. The image URL should start with your `SUPABASE_URL`; the object appears in Supabase → Storage → `hall-images/halls/`.
5. Create a test booking and record a payment; delete or cancel it afterwards.
6. Render **Logs** show `RHR server listening on :<port> (production)` and no `FATAL` lines.

## 11. Troubleshooting and free-tier limitations

| Symptom | Cause / fix |
|---|---|
| Site takes ~1 min to open | Render free spin-down. Normal. |
| `FATAL: DATABASE_URL …` in logs | Variable missing, or still the development password. |
| `Cannot connect to the database after 6 attempts` | Wrong string, or Neon project suspended/out of compute hours (Neon dashboard). |
| `Migration … failed` | Read the message; fix the cause; redeploy. The previous version keeps running. |
| `STORAGE_DRIVER=supabase needs …` | Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. |
| Upload says "Supabase Storage upload failed (401/403)" | Wrong or non-service-role key. |
| "(404)/Bucket not found" | Bucket name differs from `SUPABASE_BUCKET`. |
| Photos broken in the page, upload worked | Bucket is not **Public**, or the Supabase project is paused (restore it in the Supabase dashboard). |
| Everyone gets "too many attempts" | `TRUST_PROXY` not `true`, so all users share the proxy's IP. |
| Login works but you are logged out immediately | `COOKIE_SECURE=true` requires HTTPS; use the `https://` Render URL. |
| **No emails arrive** | Render's free plan blocks outbound SMTP on ports 25/465/587. Use a mail provider that accepts another port (check your provider's docs for 2525 or similar) and set `SMTP_PORT`, or upgrade Render. Not tested here. SMS/WhatsApp (Twilio/Meta) use HTTPS and are not affected, but are also untested with real credentials. |
| Reminders/notifications are late | The background notification worker only runs while the service is awake; queued messages send on the next wake-up. Keeping it awake all month is possible within 750 hours but is your choice (an external uptime pinger on `/healthz`). |
| Render "suspended" | Free instance hours or bandwidth used up for the month. |

Other limitations: one instance only; Neon compute-hour and 1 GB caps; Supabase pause after one week of inactivity; no automatic off-site backups (do §12 yourself); midnight-crossing bookings are unsupported.

## 12. Backup and restore

Neon keeps only 6 hours of restore history on the free plan, so keep your own copies.

**Database backup** (needs PostgreSQL client tools `pg_dump`/`pg_restore` on your computer; use the Neon **direct** string, and a client version at least as new as your Neon Postgres version):
```bash
DATABASE_URL=<direct string> MIGRATE_DATABASE_URL=<direct string> BACKUP_DIR=./backups npm run backup
```
This writes a dated folder with `database.dump` and a checksum manifest (`manifest.json`). Copy it somewhere off your computer too. Do it weekly, and before every release.

**Photos:** the script archives photos only for local storage. With Supabase, download the `hall-images` bucket from the Supabase dashboard from time to time (photos can also simply be re-uploaded).

**Restore** into a new, empty Neon database (create a second Neon project or branch for the test):
```bash
npm run restore -- ./backups/<folder> --target <empty db string>
```
To rehearse without touching Neon, run `npm run restore -- ./backups/<folder> --verify` against a local PostgreSQL (`DATABASE_URL` pointing at it): it restores into a scratch database on a local PostgreSQL, compares row counts, then drops it. Test a restore at least once before you rely on it.

## Rollback

Render → service → **Events/Deploys** → pick the last good deploy → **Rollback**. Migrations are forward-only: rolling back code does not undo database changes, so take a backup before deploying a release that adds a migration.
