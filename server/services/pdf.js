// A4 PDF rendering of a frozen invoice / quotation snapshot (never recomputed from live data).
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import PDFDocument from 'pdfkit'
import { inr, toPaise } from '../lib/money.js'

const fonts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts')
const money = (n) => inr(toPaise(n))
const fmtDate = (s) => (s ? new Date(s + (s.length === 10 ? 'T00:00:00' : '')).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: s.length === 10 ? undefined : 'Asia/Kolkata' }) : '')
export function renderPdf(snap, { kind = 'invoice' } = {}) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `${snap.number}`, Author: snap.seller.name } })
  doc.registerFont('R', path.join(fonts, 'FreeSans.ttf'))
  doc.registerFont('B', path.join(fonts, 'FreeSansBold.ttf'))
  const L = 40
  const W = doc.page.width - 80
  const R = L + W
  const title = kind === 'quotation' ? 'QUOTATION' : kind === 'bill' ? 'BILL' : 'INVOICE'
  const ink = '#111827'
  const mute = '#6b7280'
  const accent = '#e11d2e'

  // header
  doc.fillColor(ink).font('B').fontSize(18).text(snap.seller.name, L, 40)
  doc.font('R').fontSize(9).fillColor(mute)
  if (snap.seller.legalName) doc.text(snap.seller.legalName)
  doc.text(snap.seller.address, { width: 260 })
  doc.text([snap.seller.phone, snap.seller.email].filter(Boolean).join('  ·  '))
  if (snap.seller.taxId) doc.text(`Tax ID: ${snap.seller.taxId}`)
  doc.font('B').fontSize(22).fillColor(accent).text(title, L, 40, { width: W, align: 'right' })
  doc.font('R').fontSize(9).fillColor(ink)
  const meta = kind === 'bill' ? [['Bill date', fmtDate(snap.issueDate)]] : [[kind === 'quotation' ? 'Quotation No.' : 'Invoice No.', snap.number], [kind === 'quotation' ? 'Date' : 'Issue date', fmtDate(snap.issueDate)]]
  if (snap.validUntil) meta.push(['Valid until', fmtDate(snap.validUntil)])
  meta.push([kind === 'quotation' && snap.orderReference ? 'Order Ref.' : 'Booking Ref.', snap.reference])
  if (snap.version > 1) meta.push(['Revision', `v${snap.version}`])
  let y = 70
  for (const [k, v] of meta) {
    doc.fillColor(mute).text(k, L + W - 220, y, { width: 90, align: 'right' }).fillColor(ink).font('B').text(String(v), L + W - 125, y, { width: 125, align: 'right' }).font('R')
    y += 13
  }

  // parties
  y = Math.max(doc.y, y) + 18
  doc.moveTo(L, y).lineTo(R, y).strokeColor('#e5e7eb').stroke()
  y += 10
  const col = (x, label, lines) => {
    doc.font('B').fontSize(8).fillColor(mute).text(label.toUpperCase(), x, y)
    doc.font('R').fontSize(10).fillColor(ink)
    lines.filter(Boolean).forEach((t, i) => doc.text(t, x, y + 12 + i * 13, { width: W / 2 - 10 }))
  }
  col(L, 'Billed to', [snap.customer.billingName || snap.customer.name, snap.customer.phone, snap.customer.email, snap.customer.billingAddress || snap.customer.address, snap.customer.billingTaxId && `Tax ID: ${snap.customer.billingTaxId}`])
  col(L + W / 2 + 10, 'Event', snap.event.lines)
  y += 12 + Math.max(snap.event.lines.length, 4) * 13 + 14

  // table
  const cx = { d: L, q: L + 270, u: L + 330, a: R }
  doc.rect(L, y, W, 20).fill('#f3f4f6')
  doc.fillColor(ink).font('B').fontSize(9)
  doc.text('Description', cx.d + 8, y + 6).text('Qty', cx.q, y + 6, { width: 50, align: 'right' }).text('Unit price', cx.u, y + 6, { width: 80, align: 'right' }).text('Amount', cx.a - 100, y + 6, { width: 92, align: 'right' })
  y += 26
  doc.font('R').fontSize(9.5)
  for (const ln of snap.lines) {
    if (y > 700) { doc.addPage(); y = 50 }
    doc.fillColor(ink).text(ln.description, cx.d + 8, y, { width: 250 })
    const h = doc.y - y
    doc.text(`${ln.quantity}${ln.unit ? ' ' + ln.unit : ''}`, cx.q - 10, y, { width: 60, align: 'right' }).text(money(ln.unit_price), cx.u, y, { width: 80, align: 'right' }).text(money(ln.amount), cx.a - 100, y, { width: 92, align: 'right' })
    y += Math.max(h, 14) + 5
    doc.moveTo(L, y - 2).lineTo(R, y - 2).strokeColor('#f3f4f6').stroke()
  }

  // totals
  y += 6
  const row = (label, value, opts = {}) => {
    if (y > 740) { doc.addPage(); y = 50 }
    doc.font(opts.bold ? 'B' : 'R').fontSize(opts.big ? 12 : 10).fillColor(opts.color || ink)
    doc.text(label, R - 260, y, { width: 150, align: 'right' }).text(value, R - 100, y, { width: 100, align: 'right' })
    y += opts.big ? 20 : 15
  }
  row('Subtotal', money(snap.totals.subtotal))
  if (snap.totals.discount > 0) row('Discount', '− ' + money(snap.totals.discount))
  if (snap.totals.taxRate > 0) row(`${snap.totals.taxLabel} @ ${snap.totals.taxRate}%`, money(snap.totals.tax))
  doc.moveTo(R - 260, y).lineTo(R, y).strokeColor('#d1d5db').stroke(); y += 5
  row(kind === 'quotation' ? 'Total' : 'Total amount', money(snap.totals.total), { bold: true, big: true })

  if (kind !== 'quotation') {
    y += 6
    doc.font('B').fontSize(9).fillColor(mute).text('PAYMENTS RECEIVED', L, y); y += 14
    doc.font('R').fontSize(9.5).fillColor(ink)
    if (!snap.payments.length) { doc.text('—', L, y); y += 14 }
    for (const p of snap.payments) {
      if (y > 740) { doc.addPage(); y = 50 }
      const how = p.splits && p.splits.length > 1 ? p.splits.map((x) => `${x.method} ${money(x.amount)}`).join(' + ') : (p.splits?.[0]?.method || p.method)
      doc.text(`${fmtDate(p.date)}  ·  ${p.kind === 'refund' ? 'Refund' : p.stage === 'advance' ? 'Advance' : p.stage === 'final' ? 'Final payment' : 'Payment'}  ·  ${how}${p.reference ? '  ·  Ref ' + p.reference : ''}`, L, y, { width: 340 })
      doc.text((p.kind === 'refund' ? '− ' : '') + money(p.amount), R - 100, y, { width: 100, align: 'right' })
      y += 15
    }
    y += 4
    doc.moveTo(R - 260, y).lineTo(R, y).strokeColor('#d1d5db').stroke(); y += 5
    row('Total paid', money(snap.paidTotal))
    row('Balance due', money(snap.balance), { bold: true, color: snap.balance === 0 ? '#047857' : accent })
    // status stamp (placed clear of the payment lines above)
    y += 52
    doc.save().rotate(-12, { origin: [L + 90, y] })
    doc.roundedRect(L + 20, y - 40, 150, 40, 6).lineWidth(2).strokeColor(snap.balance === 0 ? '#047857' : accent).stroke()
    doc.font('B').fontSize(17).fillColor(snap.balance === 0 ? '#047857' : accent).text(snap.balance === 0 ? 'FULLY PAID' : 'BALANCE DUE', L + 20, y - 29, { width: 150, align: 'center' })
    doc.restore()
  } else {
    y += 8
    doc.font('R').fontSize(9).fillColor(mute).text('This is a quotation, not a tax invoice. Prices are valid until the date shown.', L, y, { width: W })
    y = doc.y
  }

  y += 24
  if (y > 730) { doc.addPage(); y = 50 }
  if (snap.seller.bankDetails) { doc.font('B').fontSize(8).fillColor(mute).text('BANK DETAILS', L, y); doc.font('R').fontSize(9).fillColor(ink).text(snap.seller.bankDetails, L, y + 11, { width: W }); y = doc.y + 8 }
  if (snap.seller.terms) { doc.font('B').fontSize(8).fillColor(mute).text('TERMS', L, y); doc.font('R').fontSize(8.5).fillColor(ink).text(snap.seller.terms, L, y + 11, { width: W }); y = doc.y + 8 }
  doc.font('R').fontSize(9).fillColor(mute).text(snap.seller.footer || '', L, Math.min(y + 6, 790), { width: W, align: 'center' })
  doc.end()
  return doc
}

/** One-page receipt for a single verified payment (e.g. the advance), with the split by method. */
export function renderReceipt(snap) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: snap.number, Author: snap.seller.name } })
  doc.registerFont('R', path.join(fonts, 'FreeSans.ttf'))
  doc.registerFont('B', path.join(fonts, 'FreeSansBold.ttf'))
  const L = 40, W = doc.page.width - 80, R = L + W
  const ink = '#111827', mute = '#6b7280', accent = '#e11d2e'
  const p = snap.payment
  const kindLabel = p.stage === 'advance' ? 'ADVANCE RECEIPT' : p.stage === 'final' ? 'FINAL PAYMENT RECEIPT' : 'PAYMENT RECEIPT'
  doc.fillColor(ink).font('B').fontSize(18).text(snap.seller.name, L, 40)
  doc.font('R').fontSize(9).fillColor(mute)
  doc.text(snap.seller.address, { width: 260 })
  doc.text([snap.seller.phone, snap.seller.email].filter(Boolean).join('  ·  '))
  doc.font('B').fontSize(20).fillColor(accent).text(kindLabel, L, 40, { width: W, align: 'right' })
  doc.font('R').fontSize(9).fillColor(ink)
  let y = 68
  for (const [k, v] of [['Receipt No.', snap.number], ['Date', fmtDate(p.date)], ['Booking Ref.', snap.reference]]) {
    doc.fillColor(mute).text(k, L + W - 220, y, { width: 90, align: 'right' }).fillColor(ink).font('B').text(String(v), L + W - 125, y, { width: 125, align: 'right' }).font('R')
    y += 13
  }
  y = Math.max(doc.y, y) + 18
  doc.moveTo(L, y).lineTo(R, y).strokeColor('#e5e7eb').stroke(); y += 10
  doc.font('B').fontSize(8).fillColor(mute).text('RECEIVED FROM', L, y).text('EVENT', L + W / 2 + 10, y)
  doc.font('R').fontSize(10).fillColor(ink).text(snap.customer.name, L, y + 12, { width: W / 2 - 10 }).text(snap.customer.phone, L, y + 25, { width: W / 2 - 10 })
  snap.event.forEach((t, i) => doc.text(t, L + W / 2 + 10, y + 12 + i * 13, { width: W / 2 - 10 }))
  y += 12 + 4 * 13 + 14
  doc.rect(L, y, W, 20).fill('#f3f4f6')
  doc.fillColor(ink).font('B').fontSize(9).text('Paid by', L + 8, y + 6).text('Amount', R - 108, y + 6, { width: 100, align: 'right' })
  y += 26
  doc.font('R').fontSize(10.5)
  const rows = p.splits.length ? p.splits : [{ method: p.method, amount: p.amount }]
  for (const s of rows) { doc.fillColor(ink).text(s.method, L + 8, y).text(money(s.amount), R - 108, y, { width: 100, align: 'right' }); y += 18 }
  doc.moveTo(R - 260, y).lineTo(R, y).strokeColor('#d1d5db').stroke(); y += 6
  const row = (label, value, o = {}) => {
    doc.font(o.bold ? 'B' : 'R').fontSize(o.big ? 13 : 10).fillColor(o.color || ink)
    doc.text(label, R - 260, y, { width: 150, align: 'right' }).text(value, R - 100, y, { width: 100, align: 'right' })
    y += o.big ? 22 : 16
  }
  row('Amount received', money(p.amount), { bold: true, big: true })
  if (p.reference) { doc.font('R').fontSize(9).fillColor(mute).text(`Ref ${p.reference}`, L, y - 18); }
  y += 6
  row('Booking total', money(snap.bookingTotal))
  row('Paid so far', money(snap.paidSoFar))
  row('Balance due', money(snap.balance), { bold: true, color: snap.balance === 0 ? '#047857' : accent })
  y += 20
  doc.font('R').fontSize(9).fillColor(mute).text(snap.balance === 0 ? 'Payment complete. Thank you.' : 'This is a receipt for the amount received. The final bill is issued when the balance is cleared.', L, y, { width: W })
  if (snap.seller.footer) doc.text(snap.seller.footer, L, doc.y + 14, { width: W, align: 'center' })
  doc.end()
  return doc
}
