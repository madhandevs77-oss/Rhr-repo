// All money math is done in integer paise. NUMERIC columns arrive from pg as strings.
import { badRequest } from './errors.js'

export const MAX_PAISE = 9_999_999_999 // ₹99,999,999.99

/** '1234.50' | 1234.5 -> 123450 (throws on NaN/negative/more than 2 decimals/overflow) */
export function toPaise(v, label = 'amount') {
  if (v === null || v === undefined || v === '') return 0
  const s = typeof v === 'number' ? String(v) : String(v).trim()
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw badRequest(`${label} must be a valid amount with at most 2 decimals`)
  const [i, f = ''] = s.replace('-', '').split('.')
  const p = parseInt(i, 10) * 100 + parseInt((f + '00').slice(0, 2), 10)
  if (!Number.isSafeInteger(p) || p > MAX_PAISE) throw badRequest(`${label} is too large`)
  return s.startsWith('-') ? -p : p
}
export const fromPaise = (p) => Math.round(p) / 100
export const paiseStr = (p) => (Math.round(p) / 100).toFixed(2)
/** quantity (up to 2 decimals) × unit price paise -> paise, rounded half-up */
export const mulQty = (qty, unitPaise) => Math.round(Number(qty) * unitPaise)
/** percentage of paise, half-up */
export const pct = (paise, rate) => Math.round((paise * Number(rate)) / 100)

export const inr = (p) =>
  '₹' + (Math.round(p) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
