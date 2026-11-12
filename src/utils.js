// ---------- Date helpers (all LOCAL time — no toISOString(), which shifts days in IST) ----------
export const pad = (n) => String(n).padStart(2, '0')
export const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export const todayStr = () => toISO(new Date())
export const parseISO = (s) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}
export const monthKey = (y, m) => `${y}-${pad(m + 1)}`
export const currentYM = () => {
  const n = new Date()
  return { y: n.getFullYear(), m: n.getMonth() }
}
// Safe month arithmetic: always anchors on day 1 so 31 Oct + 1 = Nov (not Dec 1)
export const addMonth = ({ y, m }, delta) => {
  const t = new Date(y, m + delta, 1)
  return { y: t.getFullYear(), m: t.getMonth() }
}
export const monthLabel = ({ y, m }) =>
  new Date(y, m, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })

export const fmtDate = (s) =>
  s ? parseISO(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : ''
export const fmtDateLong = (s) =>
  s ? parseISO(s).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }) : ''
export const fmtTime = (t) => {
  if (!t) return ''
  const [h, m] = t.split(':')
  const hr = parseInt(h, 10)
  return `${hr % 12 || 12}:${m} ${hr >= 12 ? 'PM' : 'AM'}`
}
/** "10:00 AM – 1:00 PM", with "(next day)" when the end falls after midnight; "Time not set" when there is no time. */
export const fmtRange = (start, end, nextDay) => (start ? `${fmtTime(start)} – ${fmtTime(end)}${nextDay ? ' (next day)' : ''}` : 'Time not set')
export const fmtDateTime = (iso) =>
  new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })

// ---------- Misc ----------
const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0) // null, '' and non-numeric text show as 0, never NaN
export const fmt = (n) => { const v = num(n); return (v < 0 ? '-₹' : '₹') + Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 2 }) }
export const initials = (n) =>
  n ? n.trim().split(/\s+/).map((w) => w[0]).join('').toUpperCase().substring(0, 2) : '?'
export const uid = (p = 'id') => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
export const digits = (s) => String(s || '').replace(/\D/g, '')
export const isPhone = (s) => /^\d{10}$/.test(digits(s))
export const waLink = (phone) => {
  const d = digits(phone)
  const num = d.length === 10 ? '91' + d : d
  return `https://wa.me/${num}`
}
export const PAY_LABEL = { paid: 'Paid', partial: 'Part paid', unpaid: 'Unpaid', overpaid: 'Overpaid', none: 'No amount' }
export const fmtMoney = (n) => { const v = num(n); return (v < 0 ? '-₹' : '₹') + Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 }) }
export const cap = (s) => String(s || '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
