import { useEffect, useMemo, useState } from 'react'
import { api, errMsg } from '../api'
import { Async, Field, Icon, useToast } from '../components/common'
import { ImpactDialog } from '../components/Impact'
import { EVENT_TYPES, PAY_METHODS } from '../data'
import { useApp, useLoad } from '../store'
import { fmt, fmtDate, fmtTime, isPhone, digits, todayStr } from '../utils'

const STEPS = ['Customer', 'Booking', 'Pricing', 'Food', 'Catering']
const num = (v) => parseFloat(v) || 0
const r2 = (n) => Math.round(n * 100) / 100
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m }

export default function BookingForm({ nav, id, hallId }) {
  const detail = useLoad(() => (id ? api.get(`/api/bookings/${id}`) : Promise.resolve({ booking: null })), [id])
  const menu = useLoad(() => api.get('/api/menu'), [])
  return (
    <Async res={detail}>
      {(d) => <Async res={menu}>{(m) => <Form nav={nav} hallId={hallId} editing={d?.booking || null} menu={m.items.filter((i) => i.active)} />}</Async>}
    </Async>
  )
}

function Form({ nav, editing, menu, hallId }) {
  const { halls, settings, can, reloadHalls, picked, clearPicked } = useApp()
  const toast = useToast()
  const fin = can('bookings.editFinancial')
  const moneyLocked = !!editing && !fin
  const [step, setStep] = useState(1)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [impact, setImpact] = useState(null)
  const activeHalls = halls.filter((h) => h.active || h.id === editing?.hallId)

  const [f, setF] = useState(() => ({
    name: editing?.customer.name || '', phone: editing?.customer.phone || '', altPhone: editing?.customer.altPhone || '', email: editing?.customer.email || '',
    address: editing?.customer.address || '', language: editing?.customer.language || 'en', consent: editing ? !!editing.customer.messageConsent : true,
    eventType: editing?.eventType || '', date: editing?.date || todayStr(), startTime: editing?.startTime || '', endTime: editing?.endTime || '',
    hallId: editing?.hallId || hallId || '', notes: editing?.notes || '',
    hallCharge: editing?.hallCharge ?? '', discount: editing?.discount || '', taxRate: editing ? editing.taxRate : settings.finance.defaultTaxRate || 0,
    charges: editing?.charges.map((c) => ({ description: c.description, quantity: c.quantity, unitPrice: c.unitPrice })) || [],
    advance: '', payDate: todayStr(), payMethod: 'Cash', payRef: '', verifyNow: fin,
    foodIds: new Set(editing ? (editing.foodItems || []).map((x) => x.id).filter(Boolean) : picked.filter((id) => menu.some((m) => m.id === id))), foodConfirmed: editing ? editing.foodStatus === 'confirmed' : false,
    plates: editing?.catering?.plates ?? '', price: editing?.catering?.pricePerPlate ?? '', catNotes: editing?.catering?.notes || '',
  }))
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))
  const hall = halls.find((h) => h.id === f.hallId)

  // advisory availability check: what is already booked in this hall that day (server is still the authority)
  const day = useLoad(() => (f.hallId && f.date ? api.get('/api/bookings', { from: f.date, to: f.date, hallId: f.hallId }) : Promise.resolve({ bookings: [] })), [f.hallId, f.date])
  const clash = useMemo(() => {
    if (!f.startTime || !f.endTime || f.endTime <= f.startTime) return null
    return (day.data?.bookings || []).find((b) => b.id !== editing?.id && b.status !== 'cancelled' && toMin(f.startTime) < toMin(b.endTime) && toMin(b.startTime) < toMin(f.endTime)) || null
  }, [day.data, f.startTime, f.endTime, editing])

  const catTotal = r2(num(f.plates) * num(f.price))
  const extras = r2(f.charges.reduce((s, c) => s + num(c.quantity) * num(c.unitPrice), 0))
  const subtotal = r2(num(f.hallCharge) + extras + catTotal)
  const taxable = Math.max(0, subtotal - num(f.discount))
  const tax = r2((taxable * num(f.taxRate)) / 100)
  const total = r2(taxable + tax)
  const foodByCat = useMemo(() => menu.reduce((a, i) => ((a[i.category] = a[i.category] || []).push(i), a), {}), [menu])

  function validate(n) {
    if (n === 1) {
      if (!f.name.trim()) return 'Customer name is required'
      if (!isPhone(f.phone)) return 'Enter a valid 10-digit phone number'
      if (f.altPhone && !isPhone(f.altPhone)) return 'Alternate phone must be 10 digits (or leave it empty)'
      if (f.email && !/^\S+@\S+\.\S+$/.test(f.email)) return 'Enter a valid email or leave it empty'
    }
    if (n === 2) {
      if (!f.eventType) return 'Select an event type'
      if (!f.date) return 'Select the function date'
      if (!editing && f.date < todayStr()) return 'Function date cannot be in the past'
      if (!f.startTime || !f.endTime) return 'Enter start and end time'
      if (f.endTime <= f.startTime) return 'End time must be after start time'
      if (!f.hallId) return 'Select a hall'
      if (clash) return `${hall?.name} is already booked ${fmtTime(clash.startTime)}–${fmtTime(clash.endTime)} for ${clash.customer.name}. Pick another time or hall.`
    }
    if (n === 3) {
      if (!(num(f.hallCharge) > 0)) return 'Enter the hall charge'
      if (num(f.discount) > subtotal) return 'Discount cannot exceed the subtotal'
      if (num(f.taxRate) < 0 || num(f.taxRate) > 100) return 'Tax rate must be between 0 and 100'
      for (const c of f.charges) if (!c.description.trim() || !(num(c.quantity) > 0) || num(c.unitPrice) < 0) return 'Complete or remove the extra charge lines'
      if (!editing && num(f.advance) > total) return 'Advance cannot be more than the total'
      if (!editing && num(f.advance) > 0 && !f.payDate) return 'Enter the payment date'
      if (editing && editing.money.paid > total) return `Total can't be less than the ${fmt(editing.money.paid)} already received — record a refund first`
    }
    if (n === 5 && (f.plates || f.price) && (!(num(f.plates) > 0) || !(num(f.price) > 0))) return 'Enter both plates and price per plate (or clear both)'
    return ''
  }
  const next = (n) => { const e = validate(n); setErr(e); if (!e) setStep(n + 1) }
  const go = (n) => { setErr(''); setStep(n) }

  const body = () => ({
    customer: { name: f.name.trim(), phone: digits(f.phone), altPhone: digits(f.altPhone) || undefined, email: f.email.trim() || undefined, address: f.address.trim(), language: f.language, messageConsent: f.consent },
    hallId: f.hallId, eventType: f.eventType, date: f.date, startTime: f.startTime, endTime: f.endTime, notes: f.notes.trim(),
    hallCharge: num(f.hallCharge), discount: num(f.discount), taxRate: num(f.taxRate),
    charges: f.charges.map((c) => ({ description: c.description.trim(), quantity: num(c.quantity), unitPrice: num(c.unitPrice) })),
    foodItems: menu.filter((x) => f.foodIds.has(x.id)).map((x) => ({ id: x.id, name: x.name })),
    foodStatus: f.foodConfirmed ? 'confirmed' : 'pending',
    catering: num(f.plates) > 0 ? { plates: parseInt(f.plates, 10), pricePerPlate: num(f.price), notes: f.catNotes.trim() } : null,
  })

  async function save(confirm, reason) {
    for (const n of [1, 2, 3, 5]) { const e = validate(n); if (e) { setErr(e); setStep(n); return } }
    setBusy(true)
    setErr('')
    try {
      if (editing) {
        const r = await api.put(`/api/bookings/${editing.id}`, { ...body(), expectedVersion: editing.version, confirm: confirm || {}, reason: reason || undefined })
        setImpact(null)
        toast(r.impact?.totalChanged ? 'Booking updated — totals recalculated' : 'Booking updated')
        nav.back()
      } else {
        const payload = body()
        if (num(f.advance) > 0) payload.advance = { amount: num(f.advance), method: f.payMethod, paidOn: f.payDate, reference: f.payRef.trim(), verify: fin ? f.verifyNow : false, idempotencyKey: crypto.randomUUID() }
        const r = await api.post('/api/bookings', payload)
        reloadHalls().catch(() => {})
        clearPicked()
        toast(num(f.advance) > 0 && !(fin && f.verifyNow) ? 'Booking saved — advance awaits verification' : 'Booking saved')
        nav.replace('detail', { id: r.booking.id })
      }
    } catch (e) {
      if (e.code === 'CONFIRMATION_REQUIRED' && editing) setImpact({ ...e.details, message: e.message })
      else if (e.code === 'STALE_VERSION') setErr('Someone else changed this booking while you were editing. Go back and reopen it to see the latest version.')
      else { setErr(errMsg(e)); if (e.code === 'HALL_CONFLICT') setStep(2) }
    } finally {
      setBusy(false)
    }
  }

  const toggleFood = (fid) => setF((s) => { const ids = new Set(s.foodIds); ids.has(fid) ? ids.delete(fid) : ids.add(fid); return { ...s, foodIds: ids } })
  const setCharge = (i, k, v) => setF((s) => ({ ...s, charges: s.charges.map((c, j) => (j === i ? { ...c, [k]: v } : c)) }))

  return (
    <div className="wizard">
      <h2 className="wizard__title" style={{ marginBottom: '.75rem' }}>{editing ? `Edit ${editing.reference}` : 'New Booking'}</h2>
      <div className="wizard__progress">
        {STEPS.map((l, i) => (
          <div key={l} className={`wizard__step ${step === i + 1 ? 'active' : ''} ${step > i + 1 ? 'completed' : ''}`}>
            <span className="wizard__step-num">{step > i + 1 ? '✓' : i + 1}</span>
            <span className="wizard__step-label">{l}</span>
          </div>
        ))}
      </div>

      {step === 1 && (
        <div className="wizard__panel active">
          <h2 className="wizard__title">Customer Details</h2>
          <div className="form">
            <Field label="Customer Name *"><input value={f.name} onChange={set('name')} placeholder="Full name" autoComplete="off" /></Field>
            <Field label="Phone Number *"><input type="tel" inputMode="numeric" maxLength={10} value={f.phone} onChange={set('phone')} placeholder="10-digit mobile" /></Field>
            <Field label="Alternate Phone"><input type="tel" inputMode="numeric" maxLength={10} value={f.altPhone} onChange={set('altPhone')} placeholder="Alternate number" /></Field>
            <Field label="Email" hint="Needed to email the bill (PDF) and thank-you note"><input type="email" value={f.email} onChange={set('email')} placeholder="Optional" /></Field>
            <Field label="Address"><textarea rows={2} value={f.address} onChange={set('address')} placeholder="Address" /></Field>
            <div className="form-row">
              <Field label="Message language">
                <select value={f.language} onChange={set('language')}><option value="en">English</option><option value="ta">தமிழ் (Tamil)</option></select>
              </Field>
            </div>
            <label className="consent">
              <input type="checkbox" checked={f.consent} onChange={(e) => setF((s) => ({ ...s, consent: e.target.checked }))} />
              <span>The customer agrees to receive booking confirmations, bills and thank-you messages by SMS / WhatsApp on this number, and by email if an address is given.</span>
            </label>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="wizard__panel active">
          <h2 className="wizard__title">Booking Details</h2>
          <div className="form">
            <Field label="Event Type *">
              <select value={f.eventType} onChange={set('eventType')}>
                <option value="" disabled>Select type</option>
                {EVENT_TYPES.map((t) => <option key={t}>{t}</option>)}
              </select>
            </Field>
            <Field label="Function Date *"><input type="date" value={f.date} min={editing ? undefined : todayStr()} onChange={set('date')} /></Field>
            <div className="form-row">
              <Field label="Start Time *"><input type="time" value={f.startTime} onChange={set('startTime')} /></Field>
              <Field label="End Time *"><input type="time" value={f.endTime} onChange={set('endTime')} /></Field>
            </div>
            <Field label="Hall *">
              {activeHalls.length === 0 ? (
                <p className="form-hint">No halls are set up yet. {can('halls.manage') ? 'Use “Halls” in the header to add one.' : 'Ask the administrator to add a hall.'}</p>
              ) : (
                <div className="hall-picker" role="radiogroup" aria-label="Hall">
                  {activeHalls.map((h) => (
                    <button type="button" role="radio" aria-checked={f.hallId === h.id} key={h.id} className={`hall-pick ${f.hallId === h.id ? 'selected' : ''}`} onClick={() => setF((s) => ({ ...s, hallId: h.id, hallCharge: s.hallCharge === '' && h.basePrice ? h.basePrice : s.hallCharge }))}>
                      <span className="hall-pick__img">{h.coverUrl ? <img src={h.coverUrl} alt="" loading="lazy" /> : <Icon name="home" size={22} />}</span>
                      <span className="hall-pick__txt"><strong>{h.name}</strong><small>{h.basePrice > 0 ? `From ${fmt(h.basePrice)}` : 'Hall'}</small>{h.facilities.length > 0 && <small>{h.facilities.slice(0, 3).join(' · ')}</small>}</span>
                      {f.hallId === h.id && <Icon name="check" size={18} />}
                    </button>
                  ))}
                </div>
              )}
            </Field>
            {hall && hall.images.length > 0 && (
              <div className="hall-strip" aria-label={`${hall.name} photos`}>{hall.images.map((im) => <img key={im.id} src={im.thumbUrl} alt={hall.name} loading="lazy" />)}</div>
            )}
            {hall?.availabilityNote && <p className="form-hint">ℹ️ {hall.availabilityNote}</p>}
            {f.hallId && f.date && (
              <div className={`avail ${clash ? 'avail--bad' : ''}`} aria-live="polite">
                {day.loading ? 'Checking availability…' : clash ? `⚠ Overlaps ${clash.customer.name} (${fmtTime(clash.startTime)}–${fmtTime(clash.endTime)})` : (day.data?.bookings || []).filter((b) => b.id !== editing?.id && b.status !== 'cancelled').length ? `Already booked that day: ${(day.data.bookings).filter((b) => b.id !== editing?.id && b.status !== 'cancelled').map((b) => `${fmtTime(b.startTime)}–${fmtTime(b.endTime)}`).join(', ')}` : '✓ No other bookings that day'}
              </div>
            )}
            <Field label="Notes"><textarea rows={2} value={f.notes} onChange={set('notes')} placeholder="Special requirements" /></Field>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="wizard__panel active">
          <h2 className="wizard__title">Pricing & Advance</h2>
          {moneyLocked && <p className="form-hint">Only a manager or admin can change amounts on an existing booking.</p>}
          <div className="form">
            <Field label="Hall Charge (₹) *"><input type="number" inputMode="decimal" min={0} value={f.hallCharge} onChange={set('hallCharge')} disabled={moneyLocked} /></Field>
            <div className="extras">
              <div className="extras__head"><strong>Additional charges</strong>{!moneyLocked && <button type="button" className="btn btn--text btn--sm" onClick={() => setF((s) => ({ ...s, charges: [...s.charges, { description: '', quantity: 1, unitPrice: '' }] }))}>+ Add</button>}</div>
              {f.charges.map((c, i) => (
                <div className="extras__row" key={i}>
                  <input placeholder="Description (e.g. Decoration)" value={c.description} onChange={(e) => setCharge(i, 'description', e.target.value)} disabled={moneyLocked} aria-label="Charge description" />
                  <input type="number" min="0" step="any" value={c.quantity} onChange={(e) => setCharge(i, 'quantity', e.target.value)} disabled={moneyLocked} aria-label="Quantity" />
                  <input type="number" min="0" step="any" placeholder="₹ each" value={c.unitPrice} onChange={(e) => setCharge(i, 'unitPrice', e.target.value)} disabled={moneyLocked} aria-label="Unit price" />
                  {!moneyLocked && <button type="button" className="icon-btn danger" onClick={() => setF((s) => ({ ...s, charges: s.charges.filter((_, j) => j !== i) }))} aria-label="Remove charge"><Icon name="trash" size={16} /></button>}
                </div>
              ))}
            </div>
            <div className="form-row">
              <Field label="Discount (₹)"><input type="number" inputMode="decimal" min={0} value={f.discount} onChange={set('discount')} disabled={moneyLocked} /></Field>
              <Field label={`${settings.finance.taxLabel} rate (%)`}><input type="number" inputMode="decimal" min={0} max={100} value={f.taxRate} onChange={set('taxRate')} disabled={moneyLocked} /></Field>
            </div>
            {!editing && (
              <>
                <h3 className="subhead">Advance received</h3>
                <Field label="Advance (₹)" hint={fin ? '' : 'Recorded as “awaiting verification” until a manager confirms the money was received. The customer confirmation message is sent only after verification.'}>
                  <input type="number" inputMode="decimal" min={0} value={f.advance} onChange={set('advance')} placeholder="0" />
                </Field>
                {num(f.advance) > 0 && (
                  <>
                    <div className="form-row">
                      <Field label="Method"><select value={f.payMethod} onChange={set('payMethod')}>{PAY_METHODS.map((m) => <option key={m}>{m}</option>)}</select></Field>
                      <Field label="Date"><input type="date" value={f.payDate} onChange={set('payDate')} /></Field>
                    </div>
                    <Field label="Reference / UPI ref (optional)"><input value={f.payRef} onChange={set('payRef')} /></Field>
                    {fin && (
                      <label className="consent"><input type="checkbox" checked={f.verifyNow} onChange={(e) => setF((s) => ({ ...s, verifyNow: e.target.checked }))} /><span>I have confirmed this money was received (verify now). This confirms the booking and sends the customer confirmation.</span></label>
                    )}
                  </>
                )}
              </>
            )}
          </div>
          <div className="payment-summary">
            <div className="payment-summary__row"><span>Subtotal</span><span>{fmt(subtotal)}</span></div>
            {num(f.discount) > 0 && <div className="payment-summary__row"><span>Discount</span><span>− {fmt(num(f.discount))}</span></div>}
            {tax > 0 && <div className="payment-summary__row"><span>{settings.finance.taxLabel} ({num(f.taxRate)}%)</span><span>{fmt(tax)}</span></div>}
            <div className="payment-summary__row"><span>Total</span><span>{fmt(total)}</span></div>
            <p className="form-hint" style={{ margin: '.3rem 0 0' }}>Estimate shown for convenience. The final amount is calculated by the server when you save.</p>
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="wizard__panel active">
          <h2 className="wizard__title">Food Selection</h2>
          <div className="food-selection-actions">
            <button className="btn btn--text" onClick={() => setF((s) => ({ ...s, foodIds: new Set(menu.map((x) => x.id)) }))}>Select All</button>
            <button className="btn btn--text" onClick={() => setF((s) => ({ ...s, foodIds: new Set() }))}>Clear All</button>
            <span style={{ marginLeft: 'auto', alignSelf: 'center', fontSize: '.8rem', color: 'var(--text-secondary)' }}>{f.foodIds.size} selected</span>
          </div>
          {menu.length === 0 && <p className="form-hint">The menu is empty. A manager can add items under More → Food Menu.</p>}
          <div className="food-list">
            {Object.entries(foodByCat).map(([cat, items]) => (
              <div className="food-list__category" key={cat}>
                <div className="food-list__category-title">{cat}</div>
                <div className="food-list__items">
                  {items.map((i) => (
                    <label className="food-list__item" key={i.id}>
                      <input type="checkbox" checked={f.foodIds.has(i.id)} onChange={() => toggleFood(i.id)} />
                      <span className="food-list__item-name">{i.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <label className="food-list__item" style={{ marginTop: '.75rem', background: 'var(--surface)' }}>
            <input type="checkbox" checked={f.foodConfirmed} onChange={(e) => setF((s) => ({ ...s, foodConfirmed: e.target.checked }))} />
            <span className="food-list__item-name">Menu confirmed with customer</span>
          </label>
        </div>
      )}

      {step === 5 && (
        <div className="wizard__panel active">
          <h2 className="wizard__title">Catering for this event</h2>
          <p className="form-hint">Food served at this event as part of the booking. For food supplied to another venue, use the separate Catering tab.</p>
          {moneyLocked && <p className="form-hint">Only a manager or admin can change catering amounts.</p>}
          <div className="form">
            <Field label="Plates / Members">
              <input type="number" inputMode="numeric" min={1} value={f.plates} onChange={set('plates')} placeholder="Number of plates" disabled={moneyLocked} />
            </Field>
            <Field label="Price Per Plate (₹)"><input type="number" inputMode="decimal" min={0} value={f.price} onChange={set('price')} disabled={moneyLocked} /></Field>
            <Field label="Notes"><textarea rows={2} value={f.catNotes} onChange={set('catNotes')} placeholder="Catering notes" /></Field>
          </div>
          <div className="booking-summary">
            <h3>Booking Summary</h3>
            <div className="summary-card">
              <Row l="Customer" v={f.name} /><Row l="Phone" v={f.phone} /><Row l="Event" v={f.eventType} />
              <Row l="Date" v={`${fmtDate(f.date)} · ${fmtTime(f.startTime)}–${fmtTime(f.endTime)}`} /><Row l="Hall" v={hall?.name} />
              <Row l="Catering" v={catTotal ? fmt(catTotal) : 'None'} /><Row l="Grand Total (est.)" v={fmt(total)} />
              {!editing && num(f.advance) > 0 && <Row l="Advance" v={`${fmt(num(f.advance))} ${fin && f.verifyNow ? '(verified)' : '(awaiting verification)'}`} />}
            </div>
          </div>
        </div>
      )}

      {err && <div className="form-error" role="alert" style={{ marginTop: '1rem' }}>{err}</div>}

      <div className="wizard__nav">
        {step === 1 ? <button className="btn btn--secondary" onClick={() => nav.back()}>Cancel</button> : <button className="btn btn--secondary" onClick={() => go(step - 1)}>← Back</button>}
        {step < 5 ? (
          <button className="btn btn--primary" style={{ marginLeft: 'auto' }} onClick={() => next(step)}>Next: {STEPS[step]} →</button>
        ) : (
          <button className="btn btn--primary btn--large" style={{ marginLeft: 'auto' }} onClick={() => save()} disabled={busy}>{busy ? 'Saving…' : editing ? 'Save Changes' : 'Save Booking'}</button>
        )}
      </div>

      {impact && <ImpactDialog impact={impact} busy={busy} onClose={() => setImpact(null)} onConfirm={(c, reason) => save(c, reason)} />}
    </div>
  )
}

const Row = ({ l, v }) => <div className="summary-card__row"><span>{l}</span><span>{v || '—'}</span></div>
