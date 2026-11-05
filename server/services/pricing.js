// Authoritative price calculation. Pure functions, integer paise only. The browser never decides a total.
import { badRequest } from '../lib/errors.js'
import { mulQty, pct, toPaise } from '../lib/money.js'

const round2 = (n) => Math.round(Number(n) * 100) / 100

/**
 * Split a discount across buckets in order (hall first, then catering) and apportion tax so that
 * per-bucket dues always add up exactly to the document total.
 */
function finish(grossBuckets, discountP, taxRate) {
  const gross = grossBuckets.hall + grossBuckets.catering
  if (discountP > gross) throw badRequest('Discount cannot exceed the subtotal')
  const dHall = Math.min(discountP, grossBuckets.hall)
  const dCat = discountP - dHall
  const taxableHall = grossBuckets.hall - dHall
  const taxableCat = grossBuckets.catering - dCat
  const taxable = taxableHall + taxableCat
  const tax = pct(taxable, taxRate)
  const taxHall = pct(taxableHall, taxRate)
  const taxCat = tax - taxHall
  const buckets = { hall: taxableHall + taxHall, catering: taxableCat + taxCat }
  return { subtotal: gross, discount: discountP, taxable, tax, total: taxable + tax, buckets }
}

/** Hall booking: hall rental + inline catering (plates × price) + additional charges − discount + tax. */
export function bookingTotals(b, charges = [], hallName = 'Hall') {
  const lines = []
  const hallP = toPaise(b.hall_charge, 'hall charge')
  if (hallP > 0) lines.push({ key: 'hall', description: `${b.hall_kind ? 'Maintenance charge' : 'Hall rental'} — ${hallName}`, quantity: 1, unit: 'event', unitPaise: hallP, amountPaise: hallP, bucket: 'hall' })
  let cateringP = 0
  const plates = Number(b.catering_plates || 0)
  const ppp = toPaise(b.catering_price_per_plate || 0, 'price per plate')
  if (plates > 0 && ppp > 0) {
    cateringP = mulQty(plates, ppp)
    lines.push({ key: 'catering', description: 'Catering', quantity: plates, unit: 'plate', unitPaise: ppp, amountPaise: cateringP, bucket: 'catering' })
  }
  // Manually agreed food-service amount (never derived from selected menu items).
  const foodP = toPaise(b.food_amount || 0, 'food amount')
  if (foodP > 0) {
    cateringP += foodP
    lines.push({ key: 'food', description: 'Food service (agreed amount)', quantity: 1, unit: '', unitPaise: foodP, amountPaise: foodP, bucket: 'catering' })
  }
  // One plain "extra amount" (no reason), separate from the itemised extra charges below.
  const extraAmtP = toPaise(b.extra_amount || 0, 'extra amount')
  if (extraAmtP > 0) lines.push({ key: 'extra-amount', description: 'Extra amount', quantity: 1, unit: '', unitPaise: extraAmtP, amountPaise: extraAmtP, bucket: 'hall' })
  let extraP = extraAmtP
  charges.forEach((c, i) => {
    const amt = mulQty(c.quantity, toPaise(c.unit_price, 'charge price'))
    extraP += amt
    lines.push({ key: `extra-${i}`, description: c.description, quantity: round2(c.quantity), unit: '', unitPaise: toPaise(c.unit_price), amountPaise: amt, bucket: 'hall' })
  })
  const r = finish({ hall: hallP + extraP, catering: cateringP }, toPaise(b.discount || 0, 'discount'), b.tax_rate || 0)
  return { lines, ...r, taxRate: Number(b.tax_rate || 0), hallP, foodP, extraP, extraAmtP }
}

/** Bulk catering order: per-plate or item-based pricing + delivery/staff/equipment/setup − discount + tax. */
export function cateringTotals(o, items = []) {
  const lines = []
  let food = 0
  if (o.pricing_mode === 'per_plate') {
    const ppp = toPaise(o.price_per_plate, 'price per plate')
    food = mulQty(o.plates, ppp)
    lines.push({ key: 'food', description: 'Catering — per plate', quantity: Number(o.plates), unit: 'plate', unitPaise: ppp, amountPaise: food })
  } else {
    items.forEach((it, i) => {
      const unit = toPaise(it.unit_price, 'item price')
      const amt = mulQty(it.quantity, unit)
      food += amt
      lines.push({ key: `item-${i}`, description: it.name, quantity: round2(it.quantity), unit: it.unit, unitPaise: unit, amountPaise: amt })
    })
  }
  const services = []
  const add = (key, description, v) => {
    const p = toPaise(v, description)
    if (p > 0) services.push({ key, description, quantity: 1, unit: '', unitPaise: p, amountPaise: p })
    return p
  }
  const svc = add('delivery', 'Delivery charges', o.delivery_charge) + add('staff', `Serving staff${o.staff_count ? ` (${o.staff_count})` : ''}`, o.staff_charge) +
    add('equipment', 'Utensils / equipment', o.equipment_charge) + add('setup', 'Setup & cleanup', o.setup_charge)
  lines.push(...services)
  const r = finish({ hall: 0, catering: food + svc }, toPaise(o.discount || 0, 'discount'), o.tax_rate || 0)
  return { lines, foodPaise: food, servicePaise: svc, ...r, taxRate: Number(o.tax_rate || 0) }
}

/** Money state of a document given its payments (rows from `payments` + allocations). */
export function settlement(totals, payments) {
  const paid = { hall: 0, catering: 0, other: 0 }
  let pending = 0
  for (const p of payments) {
    const amt = toPaise(p.amount)
    if (p.status === 'verified') {
      const sign = p.kind === 'refund' ? -1 : 1
      for (const a of p.allocations || []) paid[a.bucket] += sign * toPaise(a.amount)
    } else if (p.status === 'pending' && p.kind === 'payment') {
      pending += amt
    }
  }
  const paidTotal = paid.hall + paid.catering + paid.other
  const balance = totals.total - paidTotal
  const state = totals.total === 0 ? 'none' : balance === 0 ? 'paid' : balance < 0 ? 'overpaid' : paidTotal > 0 ? 'partial' : 'unpaid'
  return { paid, paidTotal, pending, balance, state }
}
