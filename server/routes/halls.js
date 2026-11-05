import { Router } from 'express'
import multer from 'multer'
import { config } from '../config.js'
import { query, tx } from '../db/pool.js'
import { requirePerm } from '../lib/auth.js'
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js'
import { processImage } from '../lib/images.js'
import * as storage from '../lib/storage.js'
import { isoDate, money, parse, z } from '../lib/validate.js'
import { audit } from '../services/support.js'

export const hallsRouter = Router()
const ctxOf = (req) => ({ user: req.user, ip: req.ip })

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxImageBytes, files: 10, fields: 5 } })
const uploadMany = (req, res, next) => upload.array('images', 10)(req, res, (err) => next(mapMulter(err)))
const uploadOne = (req, res, next) => upload.single('image')(req, res, (err) => next(mapMulter(err)))
function mapMulter(err) {
  if (!err) return null
  if (err.code === 'LIMIT_FILE_SIZE') return new AppError(413, 'IMAGE_TOO_LARGE', `Image is larger than ${Math.round(config.maxImageBytes / 1048576)} MB`)
  if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') return badRequest('Too many files (max 10 per upload)', undefined, 'IMAGE_COUNT')
  return badRequest(err.message || 'Upload failed', undefined, 'UPLOAD')
}

export const imageView = (i) => ({
  id: i.id, url: storage.publicUrl(i.storage_key), thumbUrl: storage.publicUrl(storage.thumbKey(i.storage_key)),
  position: i.position, isCover: i.is_cover, width: i.width, height: i.height, sizeBytes: i.size_bytes, name: i.original_name,
})

export async function loadHalls(db, { id, includeInactive = true } = {}) {
  const halls = (await db.query(`SELECT * FROM halls WHERE ($1::uuid IS NULL OR id=$1) ${includeInactive ? '' : 'AND active'} ORDER BY created_at, name`, [id || null])).rows
  if (!halls.length) return []
  const ids = halls.map((h) => h.id)
  const imgs = (await db.query('SELECT * FROM hall_images WHERE hall_id = ANY($1) ORDER BY position', [ids])).rows
  const blk = (await db.query('SELECT * FROM hall_blackouts WHERE hall_id = ANY($1) ORDER BY start_date', [ids])).rows
  return halls.map((h) => {
    const images = imgs.filter((i) => i.hall_id === h.id).map(imageView)
    return {
      id: h.id, name: h.name, description: h.description, facilities: h.facilities, basePrice: Number(h.base_price),
      active: h.active, kind: h.kind || null, order: h.section_order || null, defaultCharge: Number(h.default_charge || 0), availabilityNote: h.availability_note, images, coverUrl: (images.find((i) => i.isCover) || images[0])?.thumbUrl || null,
      photos: images.map((i) => i.url),
      blackouts: blk.filter((b) => b.hall_id === h.id).map((b) => ({ id: b.id, startDate: b.start_date, endDate: b.end_date, reason: b.reason })),
    }
  })
}

hallsRouter.get('/', requirePerm('halls.view'), async (_req, res) => {
  res.json({ halls: await loadHalls({ query }) })
})

const hallBody = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000).default(''),
  facilities: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  basePrice: money.default(0),
  active: z.boolean().default(true),
  availabilityNote: z.string().trim().max(500).default(''),
  defaultCharge: money.optional(),
})

hallsRouter.post('/', requirePerm('halls.manage'), async (req, res) => {
  const b = parse(hallBody, req.body)
  try {
    const id = await tx(async (c) => {
      const r = await c.query(
        `INSERT INTO halls (name, description, facilities, base_price, active, availability_note, default_charge) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [b.name, b.description, b.facilities, b.basePrice, b.active, b.availabilityNote, b.defaultCharge ?? b.basePrice],
      )
      await audit(c, ctxOf(req), { action: 'Hall Created', entityType: 'hall', entityId: r.rows[0].id, summary: b.name })
      return r.rows[0].id
    })
    res.status(201).json({ hall: (await loadHalls({ query }, { id }))[0] })
  } catch (e) {
    if (e.code === '23505') throw conflict('A hall with that name already exists', 'DUPLICATE')
    throw e
  }
})

hallsRouter.patch('/:id', requirePerm('halls.manage'), async (req, res) => {
  const b = parse(hallBody.partial(), req.body)
  try {
    await tx(async (c) => {
      const cur = (await c.query('SELECT * FROM halls WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0]
      if (!cur) throw notFound('Hall')
      await c.query(
        `UPDATE halls SET name=$2, description=$3, facilities=$4, base_price=$5, active=$6, availability_note=$7, default_charge=$8, updated_at=now() WHERE id=$1`,
        [cur.id, b.name ?? cur.name, b.description ?? cur.description, b.facilities ?? cur.facilities, b.basePrice ?? cur.base_price, b.active ?? cur.active, b.availabilityNote ?? cur.availability_note, b.defaultCharge ?? cur.default_charge],
      )
      await audit(c, ctxOf(req), { action: 'Hall Updated', entityType: 'hall', entityId: cur.id, summary: cur.name, details: b })
    })
    res.json({ hall: (await loadHalls({ query }, { id: req.params.id }))[0] })
  } catch (e) {
    if (e.code === '23505') throw conflict('A hall with that name already exists', 'DUPLICATE')
    throw e
  }
})

hallsRouter.delete('/:id', requirePerm('halls.manage'), async (req, res) => {
  const keys = await tx(async (c) => {
    const cur = (await c.query('SELECT * FROM halls WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0]
    if (!cur) throw notFound('Hall')
    if (cur.kind) throw conflict('The seven booking sections cannot be deleted. Deactivate it instead.', 'SECTION_PROTECTED')
    const used = (await c.query('SELECT count(*)::int n FROM bookings WHERE hall_id=$1', [cur.id])).rows[0].n
    if (used > 0) throw conflict(`This hall has ${used} booking(s) on record. Deactivate it instead of deleting, so history is preserved.`, 'HALL_IN_USE')
    const imgs = (await c.query('SELECT storage_key FROM hall_images WHERE hall_id=$1', [cur.id])).rows
    await c.query('DELETE FROM halls WHERE id=$1', [cur.id])
    await audit(c, ctxOf(req), { action: 'Hall Deleted', entityType: 'hall', entityId: cur.id, summary: cur.name })
    return imgs.map((i) => i.storage_key)
  })
  for (const k of keys) await removeBoth(k)
  res.json({ ok: true })
})

// ---------- blackout (unavailable) periods ----------
hallsRouter.post('/:id/blackouts', requirePerm('halls.manage'), async (req, res) => {
  const b = parse(z.object({ startDate: isoDate, endDate: isoDate, reason: z.string().trim().max(200).default('') }), req.body)
  if (b.endDate < b.startDate) throw badRequest('End date must be on or after the start date')
  const hall = (await query('SELECT id,name FROM halls WHERE id=$1', [req.params.id])).rows[0]
  if (!hall) throw notFound('Hall')
  const r = await query('INSERT INTO hall_blackouts (hall_id,start_date,end_date,reason) VALUES ($1,$2,$3,$4) RETURNING id', [hall.id, b.startDate, b.endDate, b.reason])
  await audit({ query }, ctxOf(req), { action: 'Hall Blackout Added', entityType: 'hall', entityId: hall.id, summary: `${hall.name}: ${b.startDate} → ${b.endDate}` })
  res.status(201).json({ id: r.rows[0].id })
})
hallsRouter.delete('/:id/blackouts/:bid', requirePerm('halls.manage'), async (req, res) => {
  const r = await query('DELETE FROM hall_blackouts WHERE id=$1 AND hall_id=$2', [req.params.bid, req.params.id])
  if (!r.rowCount) throw notFound('Blackout')
  res.json({ ok: true })
})

// ---------- images ----------
async function removeBoth(key) {
  await storage.remove(key).catch(() => {})
  await storage.remove(storage.thumbKey(key)).catch(() => {})
}
async function writeProcessed(p) {
  try {
    await storage.put(p.key, p.main)
    await storage.put(storage.thumbKey(p.key), p.thumb)
  } catch (e) {
    await removeBoth(p.key) // never leave a main file without its thumbnail (or vice-versa)
    throw e
  }
}

hallsRouter.post('/:id/images', requirePerm('halls.manage'), uploadMany, async (req, res) => {
  const files = req.files || []
  if (!files.length) throw badRequest('Choose at least one image', undefined, 'IMAGE_REQUIRED')
  const hall = (await query('SELECT id,name FROM halls WHERE id=$1', [req.params.id])).rows[0]
  if (!hall) throw notFound('Hall')
  const processed = []
  const results = []
  // validate everything first so a bad file never leaves a half-uploaded batch
  for (const f of files) processed.push(await processImage(f))
  const written = []
  try {
    for (const p of processed) {
      await writeProcessed(p) // cleans up its own partial files on failure
      written.push(p.key)
    }
    await tx(async (c) => {
      await c.query('SELECT id FROM halls WHERE id=$1 FOR UPDATE', [hall.id])
      const cur = (await c.query('SELECT count(*)::int n, COALESCE(max(position),-1) m, bool_or(is_cover) cover FROM hall_images WHERE hall_id=$1', [hall.id])).rows[0]
      if (cur.n + processed.length > config.maxImagesPerHall) throw conflict(`A hall can have at most ${config.maxImagesPerHall} photos`, 'IMAGE_LIMIT')
      let pos = cur.m + 1
      let hasCover = !!cur.cover
      for (const p of processed) {
        const r = await c.query(
          `INSERT INTO hall_images (hall_id, storage_key, original_name, mime, size_bytes, width, height, position, is_cover, uploaded_by)
           VALUES ($1,$2,$3,'image/webp',$4,$5,$6,$7,$8,$9) RETURNING *`,
          [hall.id, p.key, p.originalName, p.size, p.width, p.height, pos++, !hasCover, req.user.id],
        )
        hasCover = true
        results.push(imageView(r.rows[0]))
      }
      await audit(c, ctxOf(req), { action: 'Hall Images Uploaded', entityType: 'hall', entityId: hall.id, summary: `${hall.name}: ${processed.length} image(s)` })
    })
  } catch (e) {
    for (const k of written) await removeBoth(k)
    throw e
  }
  res.status(201).json({ images: results })
})

hallsRouter.post('/:id/images/:imageId/replace', requirePerm('halls.manage'), uploadOne, async (req, res) => {
  if (!req.file) throw badRequest('Choose an image', undefined, 'IMAGE_REQUIRED')
  const p = await processImage(req.file)
  await writeProcessed(p)
  let oldKey
  try {
    const img = await tx(async (c) => {
      const cur = (await c.query('SELECT * FROM hall_images WHERE id=$1 AND hall_id=$2 FOR UPDATE', [req.params.imageId, req.params.id])).rows[0]
      if (!cur) throw notFound('Image')
      oldKey = cur.storage_key
      const r = await c.query(
        'UPDATE hall_images SET storage_key=$2, original_name=$3, size_bytes=$4, width=$5, height=$6, uploaded_by=$7 WHERE id=$1 RETURNING *',
        [cur.id, p.key, p.originalName, p.size, p.width, p.height, req.user.id],
      )
      await audit(c, ctxOf(req), { action: 'Hall Image Replaced', entityType: 'hall', entityId: req.params.id })
      return r.rows[0]
    })
    await removeBoth(oldKey)
    res.json({ image: imageView(img) })
  } catch (e) {
    await removeBoth(p.key)
    throw e
  }
})

hallsRouter.put('/:id/images/order', requirePerm('halls.manage'), async (req, res) => {
  const { ids } = parse(z.object({ ids: z.array(z.string().uuid()).min(1) }), req.body)
  await tx(async (c) => {
    const cur = (await c.query('SELECT id FROM hall_images WHERE hall_id=$1 FOR UPDATE', [req.params.id])).rows.map((r) => r.id)
    if (cur.length !== ids.length || cur.some((id) => !ids.includes(id))) throw badRequest('The list must contain every image of this hall exactly once', undefined, 'IMAGE_ORDER')
    for (let i = 0; i < ids.length; i++) await c.query('UPDATE hall_images SET position=$2 WHERE id=$1', [ids[i], i]) // unique(hall,position) is deferred
    await audit(c, ctxOf(req), { action: 'Hall Images Reordered', entityType: 'hall', entityId: req.params.id })
  })
  res.json({ ok: true })
})

hallsRouter.patch('/:id/images/:imageId', requirePerm('halls.manage'), async (req, res) => {
  const b = parse(z.object({ isCover: z.literal(true) }), req.body)
  await tx(async (c) => {
    const cur = (await c.query('SELECT id FROM hall_images WHERE id=$1 AND hall_id=$2 FOR UPDATE', [req.params.imageId, req.params.id])).rows[0]
    if (!cur) throw notFound('Image')
    await c.query('UPDATE hall_images SET is_cover=false WHERE hall_id=$1 AND is_cover', [req.params.id])
    await c.query('UPDATE hall_images SET is_cover=$2 WHERE id=$1', [cur.id, b.isCover])
    await audit(c, ctxOf(req), { action: 'Hall Cover Changed', entityType: 'hall', entityId: req.params.id })
  })
  res.json({ ok: true })
})

hallsRouter.delete('/:id/images/:imageId', requirePerm('halls.manage'), async (req, res) => {
  const key = await tx(async (c) => {
    const cur = (await c.query('SELECT * FROM hall_images WHERE id=$1 AND hall_id=$2 FOR UPDATE', [req.params.imageId, req.params.id])).rows[0]
    if (!cur) throw notFound('Image')
    await c.query('DELETE FROM hall_images WHERE id=$1', [cur.id])
    if (cur.is_cover) await c.query('UPDATE hall_images SET is_cover=true WHERE id = (SELECT id FROM hall_images WHERE hall_id=$1 ORDER BY position LIMIT 1)', [cur.hall_id])
    // close the gap so positions stay 0..n-1
    const rest = (await c.query('SELECT id FROM hall_images WHERE hall_id=$1 ORDER BY position', [cur.hall_id])).rows
    for (let i = 0; i < rest.length; i++) await c.query('UPDATE hall_images SET position=$2 WHERE id=$1', [rest[i].id, i])
    await audit(c, ctxOf(req), { action: 'Hall Image Deleted', entityType: 'hall', entityId: cur.hall_id, summary: cur.original_name })
    return cur.storage_key
  })
  await removeBoth(key)
  res.json({ ok: true })
})
