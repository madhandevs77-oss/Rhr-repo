import { z } from 'zod'
import { badRequest } from './errors.js'

export { z }
export const phone10 = z.string().transform((s) => s.replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '')).pipe(z.string().regex(/^\d{10}$/, 'Phone must be 10 digits'))
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((s) => {
  const d = new Date(s + 'T00:00:00Z')
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}, 'Invalid date')
export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Use HH:MM').transform((s) => s.slice(0, 5))
export const money = z.union([z.number(), z.string()]).refine((v) => /^\d+(\.\d{1,2})?$/.test(String(v)), 'Invalid amount (max 2 decimals, not negative)')
export const uuid = z.string().uuid()

export function parse(schema, data) {
  const r = schema.safeParse(data)
  if (!r.success) {
    const details = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
    const first = details[0]
    throw badRequest(first ? `${first.path ? first.path + ': ' : ''}${first.message}` : 'Invalid input', details)
  }
  return r.data
}
