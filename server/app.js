import 'express-async-errors'
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import helmet from 'helmet'
import { config } from './config.js'
import { externalImageOrigin } from './lib/storage.js'
import { authenticate, csrfGuard, requireAuth } from './lib/auth.js'
import { AppError } from './lib/errors.js'
import { authRouter, usersRouter } from './routes/auth.js'
import { hallsRouter } from './routes/halls.js'
import { bookingsRouter, customersRouter, invoicesRouter, paymentsRouter } from './routes/core.js'
import { cateringPricesRouter, draftsRouter } from './routes/drafts.js'
import { calendarRouter, mealMenuRouter, sectionsRouter } from './routes/sections.js'
import { cateringRouter, menuRouter, vendorsRouter } from './routes/catering.js'
import { auditRouter, dataRouter, healthHandler, integrationsRouter, notificationsRouter, reportsRouter, settingsRouter, templatesRouter, webhooksRouter } from './routes/admin.js'

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  if (config.trustProxy) app.set('trust proxy', 1)
  app.use(helmet({
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], imgSrc: ["'self'", 'data:', 'blob:', ...[externalImageOrigin()].filter(Boolean)], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'], scriptSrc: ["'self'"], connectSrc: ["'self'"], objectSrc: ["'none'"], frameSrc: ["'self'"], frameAncestors: ["'self'"], workerSrc: ["'self'"] } },
    crossOriginEmbedderPolicy: false,
  }))
  // uploaded hall photos: server-generated names only, never executed
  app.use('/uploads', express.static(config.uploadDir, { index: false, dotfiles: 'deny', maxAge: '30d', immutable: true, setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff') }))

  app.get('/healthz', (_req, res) => res.json({ ok: true })) // shallow liveness probe (does not touch the database)

  const capture = (req, _res, buf) => { req.rawBody = buf }
  app.use('/api', express.json({ limit: '2mb', verify: capture }))
  app.use('/api', express.urlencoded({ extended: false, limit: '100kb', verify: capture }))
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next() })
  app.get('/api/health', healthHandler)
  app.use('/api', authenticate, csrfGuard)

  // public (signature-verified, no session)
  app.use('/api/webhooks', webhooksRouter)
  app.use('/api/integrations', integrationsRouter)
  app.use('/api/auth', authRouter)

  // everything below needs a signed-in user; each route then checks its own permission
  const authed = [requireAuth]
  app.use('/api/users', authed, usersRouter)
  app.use('/api/halls', authed, hallsRouter)
  app.use('/api/bookings', authed, bookingsRouter)
  app.use('/api/payments', authed, paymentsRouter)
  app.use('/api/invoices', authed, invoicesRouter)
  app.use('/api/customers', authed, customersRouter)
  app.use('/api/catering', authed, cateringRouter)
  app.use('/api/vendors', authed, vendorsRouter)
  app.use('/api/menu', authed, menuRouter)
  app.use('/api/meal-menu', authed, mealMenuRouter)
  app.use('/api/catering-prices', authed, cateringPricesRouter)
  app.use('/api/drafts', authed, draftsRouter)
  app.use('/api/sections', authed, sectionsRouter)
  app.use('/api/calendar', authed, calendarRouter)
  app.use('/api/settings', authed, settingsRouter)
  app.use('/api/notification-templates', authed, templatesRouter)
  app.use('/api/notifications', authed, notificationsRouter)
  app.use('/api/reports', authed, reportsRouter)
  app.use('/api/audit', authed, auditRouter)
  app.use('/api/admin', authed, dataRouter)
  app.use('/api', (_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Unknown API route')))

  // production: serve the built SPA
  const dist = path.join(config.root, 'dist')
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }))
    app.get(/^\/(?!api\/|uploads\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')))
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } })
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON body' } })
    if (err.type === 'entity.too.large') return res.status(413).json({ error: { code: 'TOO_LARGE', message: 'Request too large' } })
    const map = { '23505': [409, 'DUPLICATE', 'That record already exists'], '23P01': [409, 'CONFLICT', 'That time slot is no longer available'], '23514': [400, 'VALIDATION', 'A value is outside the allowed range'], '22P02': [400, 'VALIDATION', 'Invalid value'], '23503': [409, 'IN_USE', 'This record is referenced by other data'], '40001': [409, 'RETRY', 'Please try again'], '40P01': [409, 'RETRY', 'Please try again'] }
    if (map[err.code]) { const [s, c, m] = map[err.code]; return res.status(s).json({ error: { code: c, message: m } }) }
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`, err)
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong on the server' } })
  })
  return app
}
