import fs from 'node:fs'
// All configuration comes from environment variables. Nothing secret is ever sent to the browser.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const env = process.env
const bool = (v, d = false) => (v === undefined ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()))
const int = (v, d) => (v === undefined || v === '' ? d : parseInt(v, 10))

export const config = {
  root,
  env: env.NODE_ENV || 'development',
  isProd: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  port: int(env.PORT, 3001),
  databaseUrl: env.DATABASE_URL || 'postgres://rhr:rhr_dev_pw@127.0.0.1:5432/rhr_dev',
  // Migrations use pg_advisory_lock, which needs a DIRECT (non-pooler) connection. Falls back to DATABASE_URL.
  migrateDatabaseUrl: env.MIGRATE_DATABASE_URL || '',
  dbPoolMax: int(env.DB_POOL_MAX, 10),
  // undefined = let the connection string decide (sslmode=require etc.); true/false forces TLS on/off.
  // PEM file with the CA that signed the database certificate (Amazon RDS: global-bundle.pem). Turns TLS on with full verification.
  dbSslCaFile: env.DATABASE_SSL_CA_FILE || '',
  dbSsl: env.DATABASE_SSL === undefined || env.DATABASE_SSL === '' ? undefined : bool(env.DATABASE_SSL),
  dbConnectTimeoutMs: int(env.DB_CONNECT_TIMEOUT_MS, 20000), // serverless Postgres may need a few seconds to wake

  // sessions / cookies
  sessionHours: int(env.SESSION_HOURS, 12),
  cookieSecure: bool(env.COOKIE_SECURE, env.NODE_ENV === 'production'),
  trustProxy: bool(env.TRUST_PROXY, !!env.RENDER), // Render always sits behind its own proxy

  // hall photo storage: 'local' (disk; development / Docker volume), 'supabase' (Supabase Storage) or 's3' (Amazon S3; credentials come from the AWS default chain / IAM role)
  storageDriver: (env.STORAGE_DRIVER || 'local').toLowerCase(),
  s3: {
    bucket: env.S3_BUCKET || '',
    region: env.AWS_REGION || env.AWS_DEFAULT_REGION || '',
    endpoint: env.S3_ENDPOINT || '', // only for S3-compatible stores / local tests; leave empty on AWS
  },
  supabase: {
    url: (env.SUPABASE_URL || '').replace(/\/+$/, ''),
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY || '', // server-side only; never sent to the browser
    bucket: env.SUPABASE_BUCKET || 'hall-images',
  },
  // uploads (local disk driver)
  uploadDir: path.resolve(env.UPLOAD_DIR || path.join(root, 'storage', 'uploads')),
  maxImageBytes: int(env.MAX_IMAGE_MB, 8) * 1024 * 1024,
  maxImagesPerHall: int(env.MAX_IMAGES_PER_HALL, 20),
  minImageWidth: int(env.MIN_IMAGE_WIDTH, 400),
  minImageHeight: int(env.MIN_IMAGE_HEIGHT, 300),
  maxImageDimension: int(env.MAX_IMAGE_DIMENSION, 8000),

  // notifications
  notifyWorker: bool(env.NOTIFY_WORKER, env.NODE_ENV !== 'test'),
  notifyPollMs: int(env.NOTIFY_POLL_MS, 5000),
  twilio: {
    accountSid: env.TWILIO_ACCOUNT_SID || '',
    authToken: env.TWILIO_AUTH_TOKEN || '',
    smsFrom: env.TWILIO_SMS_FROM || '',
    whatsappFrom: env.TWILIO_WHATSAPP_FROM || '',
    statusCallbackUrl: env.TWILIO_STATUS_CALLBACK_URL || '',
    webhookUrl: env.TWILIO_WEBHOOK_URL || '', // public URL used when validating Twilio signatures
  },
  metaWhatsapp: {
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
    accessToken: env.WHATSAPP_ACCESS_TOKEN || '',
    appSecret: env.WHATSAPP_APP_SECRET || '',
    verifyToken: env.WHATSAPP_VERIFY_TOKEN || '',
    apiVersion: env.WHATSAPP_API_VERSION || 'v20.0',
  },
  // Email (any SMTP service: Gmail/Google Workspace app password, Zoho, Brevo, SES, Outlook, ...)
  smtp: {
    host: env.SMTP_HOST || '',
    port: int(env.SMTP_PORT, 587),
    secure: bool(env.SMTP_SECURE, int(env.SMTP_PORT, 587) === 465), // true = implicit TLS (port 465); false = STARTTLS (587)
    requireTls: bool(env.SMTP_REQUIRE_TLS, true),
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.SMTP_FROM || '', // e.g. RHR Veg Restaurant <bookings@yourdomain.com>
    replyTo: env.SMTP_REPLY_TO || '',
  },
  // Future payment gateway integration (HMAC-signed server-to-server events). Disabled when unset.
  paymentWebhookSecret: env.PAYMENT_WEBHOOK_SECRET || '',

  // bootstrap admin (only used by `npm run create-admin` / first start when no users exist)
  adminUsername: env.ADMIN_USERNAME || '',
  adminPassword: env.ADMIN_PASSWORD || '',

  backupDir: path.resolve(env.BACKUP_DIR || path.join(root, 'storage', 'backups')),
}

function fatal(msg) {
  console.error('FATAL: ' + msg)
  process.exit(1)
}
if (config.isProd) {
  if (!env.DATABASE_URL) fatal('DATABASE_URL must be set in production.')
  if (/rhr_dev_pw|CHANGE_ME/.test(env.DATABASE_URL)) fatal('DATABASE_URL still contains a development/placeholder password.')
  if (!config.cookieSecure) console.warn('WARNING: COOKIE_SECURE is off in production. Sessions cookies will be sent over plain HTTP.')
}
if (!['local', 'supabase', 's3'].includes(config.storageDriver)) fatal(`STORAGE_DRIVER must be "local", "supabase" or "s3" (got "${config.storageDriver}").`)
if (config.storageDriver === 's3' && (!config.s3.bucket || !config.s3.region)) fatal('STORAGE_DRIVER=s3 needs S3_BUCKET and AWS_REGION.')
if (config.dbSslCaFile && !fs.existsSync(config.dbSslCaFile)) fatal(`DATABASE_SSL_CA_FILE not found: ${config.dbSslCaFile}`)
if (config.storageDriver === 'supabase') {
  if (!config.supabase.url || !config.supabase.serviceKey) fatal('STORAGE_DRIVER=supabase needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.')
  if (!/^https:\/\//.test(config.supabase.url)) fatal('SUPABASE_URL must start with https://')
} else if (config.isProd && env.RENDER) {
  console.warn('WARNING: local file storage on Render is ephemeral — hall photos will be lost on every restart. Set STORAGE_DRIVER=supabase.')
}
