import { z } from 'zod'
import { badRequest } from './errors.js'
import { fromPaise, toPaise } from './money.js'
import { money } from './validate.js'

export const METHODS = ['Cash', 'GPay', 'UPI', 'Bank Transfer', 'Card', 'Cheque', 'Other']
export const methodEnum = z.enum(METHODS)
export const splitsIn = z.array(z.object({ method: methodEnum, amount: money })).min(1).max(7).optional()

/**
 * One payment, one or many methods. Returns { method, splits:[{method, paise}] } where the splits always add up
 * to the payment amount. A single split keeps its method; several are stored as method 'Split'.
 */
export function normalizeSplits(amountP, input) {
  if (!Array.isArray(input.splits) || !input.splits.length) return { method: input.method || 'Cash', splits: [{ method: input.method || 'Cash', paise: amountP }] }
  const seen = new Set()
  let sum = 0
  const splits = input.splits.map((s) => {
    const p = toPaise(s.amount, 'method amount')
    if (p <= 0) throw badRequest('Each payment method amount must be greater than zero')
    if (seen.has(s.method)) throw badRequest(`${s.method} is listed twice — enter one amount per method`)
    seen.add(s.method)
    sum += p
    return { method: s.method, paise: p }
  })
  if (sum !== amountP) throw badRequest(`Method amounts add up to ${fromPaise(sum)} but the payment is ${fromPaise(amountP)}`, { splitTotal: fromPaise(sum), amount: fromPaise(amountP) }, 'SPLIT_MISMATCH')
  return { method: splits.length === 1 ? splits[0].method : 'Split', splits }
}
