import { useEffect, useMemo, useState } from 'react'
import { api, errMsg } from '../api'
import { Async, Field, useToast } from '../components/common'
import { ImpactDialog } from '../components/Impact'
import { saveDraft } from '../drafts'
import SplitPay, { buildSplits, initialSplit } from '../components/SplitPay'
import { useApp, useLoad } from '../store'
import { digits, fmt, fmtTime, isPhone, todayStr } from '../utils'
import { MenuPicker } from './MealMenu'

const num = (v) => parseFloat(v) || 0
const r2 = (n) => Math.round(n * 100) / 100
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m }
const plus3h = (t) => { if (!t) return ''; const m = toMin(t) + 180; return m >= 1440 ? '23:59' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` }

export default function SectionBooking({ nav, editing, hallId, draft }) {
  const menu = useLoad(() => api.get('/api/meal-menu'), [])
  return <Async res={menu}>{(m) => <Form nav={nav} editing={editing} hallId={hallId} draft={draft} categories={m.categories} />}</Async>
}

function Form({ nav, editing, hallId, categories, draft }) {
  const { halls, can, reloadHalls } = useApp()
  const toast = useToast()
  const fin = can('bookings.editFinancial')
  // Halls first (Mandapam, Mini Hall, then any hall added later), then the Outsource sections
  const isOut = (h) => h.kind === 'outsource'
  const sections = halls.filter((h) => h.active || h.id === editing?.hallId).sort((a, b) => isOut(a) - isOut(b) || (a.order || 999) - (b.order || 999) || a.name.localeCompare(b.name))
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [impact, setImpact] = useState(null)
  const [draftId, setDraftId] = useState(draft?.id || null)
  const [endTouched, setEndTouched] = useState(!!editing || !!draft?.data.endTouched)
  const [f, setF] = useState(() => ({
    hallId: editing?.hallId || hallId || '',
    name: editing?.customer.name || '', phone: editing?.customer.phone || '', altPhone: editing?.customer.altPhone || '', email: editing?.customer.email || '',
    date: editing?.date || todayStr(), startTime: editing?.startTime || '', endTime: editing?.endTime || '', notes: editing?.notes || '',
    hallCharge: editing ? editing.hallCharge : '', extraAmount: editing?.extraAmount || '', removeTax: false, charges: editing?.charges.map((c) => ({ description: c.description, amount: c.quantity * c.unitPrice })) || [],
    foodAmount: editing?.foodAmount || '', discount: editing?.discount || '', foodConfirmed: editing ? editing.foodStatus === 'confirmed' : false,
    advance: '', payDate: todayStr(), payRef: '', verifyNow: fin,
    ...(!editing && draft?.data.f ? draft.data.f : {}),
  }))
  const meals = editing?.meals || [] // old bookings keep what they had; the form no longer asks for it
  const [selected, setSelected] = useState(() => new Map((editing?.foodItems || (draft?.data.selected) || []).map((x, i) => [x.id || `snap${i}`, { id: x.id, name: x.name, category: x.category }])))
  const [sel, setSel] = useState(() => draft?.data.sel || initialSplit())
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))
  const hall = sections.find((h) => h.id === f.hallId)

  useEffect(() => { if (!endTouched && f.startTime) setF((s) => ({ ...s, endTime: plus3h(s.startTime) })) }, [f.startTime, endTouched])

  const day = useLoad(() => (f.hallId && f.date ? api.get('/api/bookings', { from: f.date, to: f.date, hallId: f.hallId }) : Promise.resolve({ bookings: [] })), [f.hallId, f.date])
  const clash = useMemo(() => {
    if (!f.startTime || !f.endTime || f.endTime <= f.startTime) return null
    return (day.data?.bookings || []).find((b) => b.id !== editing?.id && b.status !== 'cancelled' && toMin(f.startTime) < toMin(b.endTime) && toMin(b.startTime) < toMin(f.endTime)) || null
  }, [day.data, f.startTime, f.endTime, editing])

  // Estimate only — the server recomputes everything on save.
  const maint = f.hallCharge === '' ? (hall?.defaultCharge || 0) : num(f.hallCharge)
  const extras = r2(f.charges.reduce((s, c) => s + num(c.amount), 0))
  const legacyCatering = editing?.catering ? r2(editing.catering.plates * editing.catering.pricePerPlate) : 0 // older bookings priced per plate
  const subtotal = r2(maint + num(f.extraAmount) + extras + num(f.foodAmount) + legacyCatering)
  const taxable = Math.max(0, subtotal - num(f.discount))
  // No GST is ever added automatically; only an old booking that already carries tax keeps it (a manager can remove it).
  const taxRate = editing && !f.removeTax ? editing.taxRate : 0
  const tax = r2((taxable * taxRate) / 100)
  const total = r2(taxable + tax)
  const moneyLocked = !!editing && !fin
  const foodLocked = !!editing && !fin && editing.foodAmount > 0

  function validate() {
    if (!f.hallId) return 'Select a hall'
    if (!f.name.trim()) return 'Customer name is required'
    if (!isPhone(f.phone)) return 'Enter a valid 10-digit contact number'
    if (f.altPhone && !isPhone(f.altPhone)) return 'Alternate phone must be 10 digits (or leave it empty)'
    if (f.email && !/^\S+@\S+\.\S+$/.test(f.email)) return 'Enter a valid email or leave it empty'
    if (!f.date) return 'Select the date'
    if (!editing && f.date < todayStr()) return 'Date cannot be in the past'
    if (!f.startTime || !f.endTime) return 'Enter start and end time'
    if (f.endTime <= f.startTime) return 'End time must be after the start time (same day)'
    if (clash) return `${hall?.name} is already booked ${fmtTime(clash.startTime)}–${fmtTime(clash.endTime)} for ${clash.customer.name}`
    if (f.hallCharge !== '' && num(f.hallCharge) < 0) return 'Maintenance charge cannot be negative'
    if (num(f.extraAmount) < 0) return 'Extra amount cannot be negative'
    if (num(f.foodAmount) < 0) return 'Food service amount cannot be negative'
    for (const c of f.charges) if (!c.description.trim() || !(num(c.amount) > 0)) return 'Complete or remove the extra-charge lines (reason and amount)'
    if (num(f.discount) > subtotal) return 'Discount cannot exceed the subtotal'
    if (!editing && num(f.advance) > total) return 'Advance cannot be more than the total'
    if (!editing && num(f.advance) > 0) { const s = buildSplits(sel, num(f.advance)); if (s.error) return s.error }
    if (editing && editing.money.paid > total) return `Total can't be less than the ${fmt(editing.money.paid)} already received — record a refund first`
    return ''
  }

  const body = () => ({
    customer: { name: f.name.trim(), phone: digits(f.phone), altPhone: digits(f.altPhone) || undefined, email: f.email.trim() || undefined, address: editing?.customer.address || '', language: editing?.customer.language || 'en', messageConsent: editing ? !!editing.customer.messageConsent : true },
    hallId: f.hallId, date: f.date, startTime: f.startTime, endTime: f.endTime, notes: f.notes.trim(), meals,
    ...(f.hallCharge !== '' ? { hallCharge: num(f.hallCharge) } : {}),
    charges: f.charges.map((c) => ({ description: c.description.trim(), quantity: 1, unitPrice: num(c.amount) })),
    foodAmount: num(f.foodAmount), extraAmount: num(f.extraAmount), discount: num(f.discount),
    ...(editing?.eventType ? { eventType: editing.eventType } : {}), ...(editing?.catering ? { catering: editing.catering } : {}), ...(editing && fin && f.removeTax ? { taxRate: 0 } : {}),
    foodItems: [...selected.values()].map((x) => ({ id: x.id, name: x.name, category: x.category })),
    foodStatus: f.foodConfirmed ? 'confirmed' : 'pending',
  })

  async function save(confirm, reason) {
    const e = validate()
    if (e) return setErr(e)
    setBusy(true); setErr('')
    try {
      if (editing) {
        const payload = body()
        if (f.hallCharge === '') payload.hallCharge = editing.hallCharge
        const r = await api.put(`/api/bookings/${editing.id}`, { ...payload, expectedVersion: editing.version, confirm: confirm || {}, reason: reason || undefined })
        setImpact(null); toast(r.impact?.totalChanged ? 'Booking updated — totals recalculated' : 'Booking updated'); nav.back()
      } else {
        const payload = { ...body(), draftId: draftId || undefined }
        if (num(f.advance) > 0) {
          payload.advance = { amount: num(f.advance), splits: buildSplits(sel, num(f.advance)).splits, paidOn: f.payDate, reference: f.payRef.trim(), verify: fin ? f.verifyNow : false, idempotencyKey: crypto.randomUUID() }
        }
        const r = await api.post('/api/bookings', payload)
        reloadHalls().catch(() => {})
        toast(num(f.advance) > 0 && !(fin && f.verifyNow) ? 'Booking saved — advance awaits verification' : 'Booking saved')
        nav.replace('detail', { id: r.booking.id })
      }
    } catch (x) {
      if (x.code === 'CONFIRMATION_REQUIRED' && editing) setImpact({ ...x.details, message: x.message })
      else if (x.code === 'STALE_VERSION') setErr('Someone else changed this booking while you were editing. Go back and reopen it to see the latest version.')
      else setErr(errMsg(x))
    } finally { setBusy(false) }
  }
  async function saveAsDraft() {
    if (!f.name.trim() && !f.phone.trim() && !f.hallId && selected.size === 0) return setErr('Enter something first (hall, customer or menu items) so there is a draft to save')
    setBusy(true); setErr('')
    try {
      const { advance, payRef, ...keep } = f
      await saveDraft({ id: draftId, kind: 'booking', hallId: f.hallId, customerName: f.name, data: { f: { ...keep, advance: '' }, selected: [...selected.values()], sel, endTouched } })
      toast('Draft saved'); nav.tab('home')
    } catch (x) { setErr(errMsg(x)) } finally { setBusy(false) }
  }
  const setCharge = (i, k, v) => setF((s) => ({ ...s, charges: s.charges.map((c, j) => (j === i ? { ...c, [k]: v } : c)) }))

  return (
    <div className="wizard secform">
      <h2 className="wizard__title" style={{ marginBottom: '.75rem' }}>{editing ? `Edit ${editing.reference}` : `New Booking${hall ? ` — ${hall.name}` : ''}`}</h2>

      <fieldset className="secform__card">
        <legend>1 · Hall</legend>
        <div className="sec-picker" role="radiogroup" aria-label="Hall">
          {sections.map((h) => (
            <button type="button" key={h.id} role="radio" aria-checked={f.hallId === h.id} className={`sec-pick ${f.hallId === h.id ? 'on' : ''}`} onClick={() => setF((s) => ({ ...s, hallId: h.id }))}>{h.name}</button>
          ))}
        </div>
      </fieldset>

      <fieldset className="secform__card">
        <legend>2 · Customer</legend>
        <div className="form">
          <Field label="Customer name *"><input value={f.name} onChange={set('name')} autoComplete="off" /></Field>
          <div className="form-row">
            <Field label="Contact number *"><input type="tel" inputMode="numeric" maxLength={10} value={f.phone} onChange={set('phone')} placeholder="10-digit mobile" /></Field>
            <Field label="Alternate number"><input type="tel" inputMode="numeric" maxLength={10} value={f.altPhone} onChange={set('altPhone')} /></Field>
          </div>
          <Field label="Email" hint="Optional — used to email the bill"><input type="email" value={f.email} onChange={set('email')} /></Field>
        </div>
      </fieldset>

      <fieldset className="secform__card">
        <legend>3 · Date & time</legend>
        <div className="form">
          <Field label="Date *"><input type="date" value={f.date} min={editing ? undefined : todayStr()} onChange={set('date')} /></Field>
          <div className="form-row">
            <Field label="Start time *"><input type="time" value={f.startTime} onChange={set('startTime')} /></Field>
            <Field label="End time *" hint="Standard slot is 3 hours"><input type="time" value={f.endTime} onChange={(e) => { setEndTouched(true); set('endTime')(e) }} /></Field>
          </div>
          {f.hallId && f.date && (
            <div className={`avail ${clash ? 'avail--bad' : ''}`} aria-live="polite">
              {day.loading ? 'Checking availability…' : clash ? `⚠ Overlaps ${clash.customer.name} (${fmtTime(clash.startTime)}–${fmtTime(clash.endTime)})` : (day.data?.bookings || []).filter((b) => b.id !== editing?.id && b.status !== 'cancelled').length ? `Already booked that day: ${day.data.bookings.filter((b) => b.id !== editing?.id && b.status !== 'cancelled').map((b) => `${fmtTime(b.startTime)}–${fmtTime(b.endTime)}`).join(', ')}` : '✓ No other bookings that day'}
            </div>
          )}
        </div>
      </fieldset>

      <fieldset className="secform__card">
        <legend>4 · Food menu</legend>
        <p className="form-hint">Tick the items for each category (Royal Breakfast, Royal Lunch…). The booking time already tells the kitchen when to serve.</p>
        <MenuPicker categories={categories} selected={selected} setSelected={setSelected} />
        <label className="food-list__item" style={{ marginTop: '.6rem' }}><input type="checkbox" checked={f.foodConfirmed} onChange={(e) => setF((s) => ({ ...s, foodConfirmed: e.target.checked }))} /><span className="food-list__item-name">Menu confirmed with customer</span></label>
      </fieldset>

      <fieldset className="secform__card">
        <legend>5 · Notes</legend>
        <textarea rows={3} value={f.notes} onChange={set('notes')} placeholder={`Notes for ${hall?.name || 'this booking'}`} aria-label="Notes" />
      </fieldset>

      <fieldset className="secform__card">
        <legend>6 · Financial confirmation</legend>
        <p className="form-hint">{editing ? (editing.money.basis === 'estimate' ? 'Estimate — the booking becomes confirmed when an advance is verified.' : 'Confirmed amounts. Changes need confirmation and are recorded in the history.') : 'Estimate — enter the agreed food-service amount when you confirm with the customer.'}</p>
        {moneyLocked && <p className="form-hint">Only a manager or admin can change amounts on an existing booking.</p>}
        <div className="form">
          <Field label="Maintenance charge (₹)" hint={hall ? `Default ${fmt(hall.defaultCharge)} per 3-hour booking${fin ? '' : ' — only a manager or admin can change it'}` : ''}>
            <input type="number" inputMode="decimal" min={0} value={f.hallCharge} placeholder={hall ? String(hall.defaultCharge) : ''} onChange={set('hallCharge')} disabled={!fin} />
          </Field>
          <Field label="Extra amount (₹)" hint="One plain amount — no reason needed">
            <input type="number" inputMode="decimal" min={0} value={f.extraAmount} onChange={set('extraAmount')} />
          </Field>
          <div className="extras">
            <div className="extras__head"><strong>Extra charges</strong><button type="button" className="btn btn--text btn--sm" onClick={() => setF((s) => ({ ...s, charges: [...s.charges, { description: '', amount: '' }] }))}>+ Add</button></div>
            <p className="form-hint">Each line says why and how much (e.g. “GST 5%”, “Decoration”, “Extra chairs”).</p>
            {f.charges.map((c, i) => (
              <div className="extras__row extras__row--2" key={i}>
                <input placeholder="Reason (e.g. GST 5%, Decoration)" value={c.description} onChange={(e) => setCharge(i, 'description', e.target.value)} aria-label="Charge reason" />
                <input type="number" min="0" step="any" placeholder="₹ amount" value={c.amount} onChange={(e) => setCharge(i, 'amount', e.target.value)} aria-label="Charge amount" />
                <button type="button" className="icon-btn danger" onClick={() => setF((s) => ({ ...s, charges: s.charges.filter((_, j) => j !== i) }))} aria-label="Remove charge">✕</button>
              </div>
            ))}
          </div>
          <Field label="Food-service amount (₹) — agreed manually" hint="Not calculated from the selected items">
            <input type="number" inputMode="decimal" min={0} value={f.foodAmount} onChange={set('foodAmount')} disabled={foodLocked} />
          </Field>
          {editing && fin && editing.taxRate > 0 && <label className="consent"><input type="checkbox" checked={f.removeTax} onChange={(e) => setF((s) => ({ ...s, removeTax: e.target.checked }))} /><span>Remove the {editing.taxRate}% GST this older booking carries</span></label>}
          {fin && <Field label="Discount (₹)"><input type="number" inputMode="decimal" min={0} value={f.discount} onChange={set('discount')} /></Field>}
        </div>
        <div className="payment-summary">
          <div className="payment-summary__row"><span>Maintenance charge</span><span>{fmt(maint)}</span></div>
          {num(f.extraAmount) > 0 && <div className="payment-summary__row"><span>Extra amount</span><span>{fmt(num(f.extraAmount))}</span></div>}
          {extras > 0 && <div className="payment-summary__row"><span>Extra charges</span><span>{fmt(extras)}</span></div>}
          {legacyCatering > 0 && <div className="payment-summary__row"><span>Catering ({editing.catering.plates} plates)</span><span>{fmt(legacyCatering)}</span></div>}
          {num(f.foodAmount) > 0 && <div className="payment-summary__row"><span>Food service</span><span>{fmt(num(f.foodAmount))}</span></div>}
          {num(f.discount) > 0 && <div className="payment-summary__row"><span>Discount</span><span>− {fmt(num(f.discount))}</span></div>}
          {taxRate > 0 && <><div className="payment-summary__row"><span>Subtotal</span><span>{fmt(taxable)}</span></div>
          <div className="payment-summary__row"><span>Tax ({taxRate}%)</span><span>{fmt(tax)}</span></div></>}
          <div className="payment-summary__row payment-summary__row--total"><span>Final total</span><span>{fmt(total)}</span></div>
          {editing && <>
            <div className="payment-summary__row"><span>Advance / paid (verified)</span><span>{fmt(editing.money.paid)}</span></div>
            <div className="payment-summary__row"><span>Outstanding</span><span>{fmt(Math.max(0, total - editing.money.paid))}</span></div>
          </>}
        </div>
      </fieldset>

      {!editing && (
        <fieldset className="secform__card">
          <legend>7 · Advance</legend>
          <div className="form">
            <Field label="Advance (₹)" hint={fin ? '' : 'Recorded as “awaiting verification” until a manager confirms the money was received.'}>
              <input type="number" inputMode="decimal" min={0} value={f.advance} onChange={set('advance')} placeholder="0" />
            </Field>
            {num(f.advance) > 0 && (
              <>
                <SplitPay amount={num(f.advance)} sel={sel} onChange={setSel} />
                <div className="form-row">
                  <Field label="Date"><input type="date" value={f.payDate} max={todayStr()} onChange={set('payDate')} /></Field>
                  <Field label="Reference (optional)"><input value={f.payRef} onChange={set('payRef')} /></Field>
                </div>
                {fin && <label className="consent"><input type="checkbox" checked={f.verifyNow} onChange={(e) => setF((s) => ({ ...s, verifyNow: e.target.checked }))} /><span>I have confirmed this money was received (verify now). This confirms the booking.</span></label>}
                <div className="payment-summary__row"><span>Balance after advance</span><span>{fmt(Math.max(0, total - num(f.advance)))}</span></div>
              </>
            )}
          </div>
        </fieldset>
      )}

      {err && <div className="form-error" role="alert" style={{ marginTop: '1rem' }}>{err}</div>}
      <div className="wizard__nav">
        <button className="btn btn--secondary" onClick={() => nav.back()}>Cancel</button>
        {!editing && <button className="btn btn--outline" style={{ marginLeft: 'auto' }} onClick={saveAsDraft} disabled={busy} data-testid="save-draft">Save as Draft</button>}
        <button className="btn btn--primary btn--large" style={editing ? { marginLeft: 'auto' } : undefined} onClick={() => save()} disabled={busy}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Save & confirm booking'}</button>
      </div>
      {impact && <ImpactDialog impact={impact} busy={busy} onClose={() => setImpact(null)} onConfirm={(c, reason) => save(c, reason)} />}
    </div>
  )
}
