// Optional starter data for a NEW install: the three RHR halls (with their photos, processed through the normal upload pipeline) and the menu.
// Idempotent — safe to re-run; existing halls/menu items are left alone. Never creates customers, bookings or payments.
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { closePool, getPool } from '../db/pool.js'
import { processImage } from '../lib/images.js'
import * as storage from '../lib/storage.js'

const HALLS = [
  { name: 'Celebration Hall', n: 1, description: 'Dedicated celebration hall for weddings, receptions, birthdays & events.' },
  { name: 'Main Dining Hall', n: 2, description: 'Primary dining area for unlimited meals and daily service.' },
  { name: 'Private Dining Area', n: 3, description: 'Intimate space for family gatherings and small functions.' },
]
const imgDir = path.join(config.root, 'public', 'images')
const db = getPool()
let halls = 0, photos = 0, menu = 0
for (const h of HALLS) {
  if ((await db.query('SELECT 1 FROM halls WHERE lower(name)=lower($1)', [h.name])).rowCount) continue
  const r = await db.query('INSERT INTO halls (name, description) VALUES ($1,$2) RETURNING id', [h.name, h.description])
  halls++
  for (let i = 1; i <= 4; i++) {
    const f = path.join(imgDir, `hall${h.n}-${i}.jpg`)
    if (!fs.existsSync(f)) continue
    const buf = fs.readFileSync(f)
    const p = await processImage({ buffer: buf, size: buf.length, originalname: path.basename(f) })
    await storage.put(p.key, p.main)
    await storage.put(storage.thumbKey(p.key), p.thumb)
    await db.query(`INSERT INTO hall_images (hall_id, storage_key, original_name, mime, size_bytes, width, height, position, is_cover) VALUES ($1,$2,$3,'image/webp',$4,$5,$6,$7,$8)`, [r.rows[0].id, p.key, p.originalName, p.size, p.width, p.height, i - 1, i === 1])
    photos++
  }
}
const src = fs.readFileSync(path.join(config.root, 'src', 'data.js'), 'utf8')
for (const m of src.matchAll(/F\('((?:[^'\\]|\\.)*)',\s*'((?:[^'\\]|\\.)*)',\s*(\d+(?:\.\d+)?)\)/g)) {
  const r = await db.query('INSERT INTO menu_items (name, category, unit_price) VALUES ($1,$2,$3) ON CONFLICT (category, lower(name)) DO NOTHING', [m[1].replace(/\\'/g, "'"), m[2], m[3]])
  menu += r.rowCount
}
console.log(`Seeded ${halls} hall(s), ${photos} photo(s), ${menu} menu item(s).`)
await closePool()
