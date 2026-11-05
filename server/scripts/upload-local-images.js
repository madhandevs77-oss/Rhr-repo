// One-off: copy hall photos already stored on local disk into Supabase Storage, keeping the SAME keys,
// so existing hall_images rows keep working after you switch STORAGE_DRIVER to supabase.
//   STORAGE_DRIVER=supabase SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... UPLOAD_DIR=./storage/uploads npm run upload-local-images
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'
import { closePool, query } from '../db/pool.js'
import * as storage from '../lib/storage.js'

if (config.storageDriver !== 'supabase') { console.error('Set STORAGE_DRIVER=supabase (and the SUPABASE_* variables) first.'); process.exit(2) }
let ok = 0, skipped = 0, missing = 0, failed = 0
try {
  const rows = (await query('SELECT storage_key FROM hall_images')).rows
  for (const { storage_key: key } of rows) {
    for (const k of [key, storage.thumbKey(key)]) {
      let buf
      try { buf = await fs.readFile(path.join(config.uploadDir, k)) } catch { missing++; console.warn('missing locally:', k); continue }
      try { await storage.put(k, buf); ok++ } catch (e) {
        if (/\((400|409)\)/.test(e.message) && /exist|duplicate/i.test(e.message)) skipped++ // already uploaded
        else { failed++; console.error('failed:', k, e.message) }
      }
    }
  }
  console.log(`Uploaded ${ok}, already there ${skipped}, missing locally ${missing}, failed ${failed}`)
  if (failed) process.exitCode = 1
} finally { await closePool() }
