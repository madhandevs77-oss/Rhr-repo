import { useEffect, useState } from 'react'
import { api, errMsg } from '../api'
import { Async, Field, Icon, useToast } from '../components/common'
import { ImpactDialog } from '../components/Impact'
import { EVENT_TYPES, PAY_METHODS } from '../data'
import { saveDraft } from '../drafts'
import { useApp, useLoad } from '../store'
import { digits, fmt, isPhone, todayStr } from '../utils'

const num = (v) => parseFloat(v) || 0
const r2 = (n) => Math.round(n * 100) / 100
const UNITS = ['plate', 'kg', 'litre', 'piece', 'tray', 'packet']

export default function CateringForm({ nav, id, bookingId, draftId }) {
  const detail = useLoad(() => (id ? api.get(`/api/catering/${id}`) : Promise.resolve({ order: null })), [id])
  const menu = useLoad(() => api.get('/api/meal-menu'), [])
  const prices = useLoad(() => api.get('/api/catering-prices'), [])
  const bookings = useLoad(() => api.get('/api/bookings', { from: todayStr() }), [])
  const draft = useLoad(() => (draftId ? api.get(`/api/drafts/${draftId}`) : Promise.resolve({ draft: null, data: null })), [draftId])
  return (
    <Async res={detail}>
      {(d) => <Async res={menu}>{(m) => <Async res={prices}>{(p) => <Async res={bookings}>{(b) => <Async res={draft}>{(dr) => (
        <Form nav={nav} editing={d?.order || null} categories={m.categories} prices={p.prices} bookings={b.bookings.filter((x) => x.status !== 'cancelled')} presetBooking={bookingId} draft={dr.draft ? { id: dr.draft.id, data: dr.data } : null} />
      )}</Async>}</Async>}</Async>}</Async>}
    </Async>
  )
}

function Form({ nav, editing, categories, prices, bookings, presetBooking, draft }) {
  const { options, settings, can, picked, clearPicked } = useApp()
  const toast = useToast()
  const mgr = can('catering.priceOverride')
  const postConfirm = editing && ['confirmed', 'preparation', 'ready_for_dispatch', 'delivered', 'exception'].includes(editing.status)
  const preBooking = bookings.find((b) => b.id === presetBooking)
  const [draftId, setDraftId] = useState(draft?.id || null)
  // dishes ticked on the Menu tab arrive here pre-selected (quantity 1; price from Catering Prices)
  const fromMenu = editing || draft ? [] : categories.flatMap((c) => c.items).filter((i) => picked.includes(i.id)).map((i) => ({ mealItemId: i.id, name: i.name, unit: prices[i.id]?.unit || 'plate', quantity: 1, unitPrice: prices[i.id]?.unitPrice ?? '' }))
  useEffect(() => { if (picked.length) clearPicked() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [impact, setImpact] = useState(null)
  const [f, setF] = useState(() => ({
    serviceOptionId: editing?.serviceOption.id || options.find((o) => o.active)?.id || '',
    name: editing?.customer.name || preBooking?.customer.name || '', phone: editing?.customer.phone || preBooking?.customer.phone || '', email: editing?.customer.email || '', address: editing?.customer.address || '',
    consent: editing ? !!editing.customer.messageConsent : true, language: editing?.customer.language || 'en',
    billingName: editing?.customer.billingName || '', billingAddress: editing?.customer.billingAddress || '', billingTaxId: editing?.customer.billingTaxId || '',
    eventType: editing?.eventType || preBooking?.eventType || '', date: editing?.date || preBooking?.date || todayStr(), deliveryTime: editing?.deliveryTime || '', servingTime: editing?.servingTime || '',
    venueName: editing?.venueName || '', deliveryAddress: editing?.deliveryAddress || '', fulfilmentMethod: editing?.fulfilmentMethod || 'delivery', contactPerson: editing?.contactPerson || '', contactPhone: editing?.contactPhone || '',
    plates: editing?.plates ?? '', mealCategory: editing?.mealCategory || 'lunch',
    pricingMode: editing?.pricingMode || draft?.data.f?.pricingMode || (fromMenu.some((i) => i.unitPrice === '') ? 'per_plate' : 'item_based'), // unpriced dishes: price by plate pricePerPlate: editing?.pricePerPlate ?? '',
    items: editing?.items.map((i) => ({ mealItemId: i.mealItemId, menuItemId: i.menuItemId, name: i.name, unit: i.unit, quantity: i.quantity, unitPrice: i.unitPrice })) || fromMenu,
    dietaryInstructions: editing?.dietaryInstructions || '', packagingRequirements: editing?.packagingRequirements || '', servingRequirements: editing?.servingRequirements || '', notes: editing?.notes || '',
    staffRequired: editing?.staffRequired || false, staffCount: editing?.staffCount || '', staffCharge: editing?.staffCharge || '', utensilsRequired: editing?.utensilsRequired || false, equipmentNotes: editing?.equipmentNotes || '', equipmentCharge: editing?.equipmentCharge || '',
    setupRequired: editing?.setupRequired || false, setupCharge: editing?.setupCharge || '', deliveryCharge: editing?.deliveryCharge || '', discount: editing?.discount || '', taxRate: editing ? editing.taxRate : settings.finance.defaultTaxRate || 0,
    bookingId: editing?.bookingId || presetBooking || '',
    advance: '', payMethod: 'Cash', payDate: todayStr(), payRef: '', verifyNow: can('payments.verify'),
    ...(!editing && draft?.data.f ? draft.data.f : {}),
  }))
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))
  const opt = options.find((o) => o.id === f.serviceOptionId)
  const lockedOpt = postConfirm

  const food = f.pricingMode === 'per_plate' ? r2(num(f.plates) * num(f.pricePerPlate)) : r2(f.items.reduce((s, i) => s + num(i.quantity) * num(i.unitPrice), 0))
  const svc = num(f.deliveryCharge) + (f.staffRequired ? num(f.staffCharge) : 0) + (f.utensilsRequired ? num(f.equipmentCharge) : 0) + (f.setupRequired ? num(f.setupCharge) : 0)
  const taxable = Math.max(0, r2(food + svc - num(f.discount)))
  const total = r2(taxable + (taxable * num(f.taxRate)) / 100)

  const setItems = (fn) => setF((s) => ({ ...s, items: typeof fn === 'function' ? fn(s.items) : fn }))

  function validate() {
    if (!f.serviceOptionId) return 'Choose a service option'
    if (!f.name.trim()) return 'Customer name is required'
    if (!isPhone(f.phone)) return 'Enter a valid 10-digit phone number'
    if (!f.eventType) return 'Select the event type'
    if (!editing && f.date < todayStr()) return 'Event date cannot be in the past'
    if (!(parseInt(f.plates, 10) > 0)) return 'Enter the number of plates'
    if (f.deliveryTime && f.servingTime && f.servingTime < f.deliveryTime) return 'Serving time cannot be before the delivery time'
    if (f.fulfilmentMethod === 'delivery' && !f.deliveryAddress.trim() && ['confirmed'].includes(editing?.status)) return 'A delivery address is required'
    if (f.pricingMode === 'per_plate' && !(num(f.pricePerPlate) > 0)) return 'Enter the price per plate'
    if (f.pricingMode === 'item_based') {
      if (f.items.length === 0) return 'Add at least one menu item'
      for (const i of f.items) {
        if (!(num(i.quantity) > 0) || !i.name.trim()) return 'Every item needs a quantity above zero'
        if (i.unitPrice === '' || i.unitPrice === null || num(i.unitPrice) < 0) return `“${i.name}” has no catering price yet${mgr ? ' — enter one here or set it under More → Catering Prices' : ' — ask a manager to set it under More → Catering Prices'}`
      }
    }
    if (f.staffRequired && !(parseInt(f.staffCount, 10) > 0)) return 'Enter how many serving staff are needed'
    if (num(f.discount) > food + svc) return 'Discount cannot exceed the subtotal'
    if (!editing && num(f.advance) > total) return 'Advance cannot exceed the total'
    if (f.contactPhone && !isPhone(f.contactPhone)) return 'Contact phone must be 10 digits'
    return ''
  }

  const body = () => ({
    serviceOptionId: f.serviceOptionId,
    customer: { name: f.name.trim(), phone: digits(f.phone), email: f.email.trim() || undefined, address: f.address.trim(), language: f.language, messageConsent: f.consent, billingName: f.billingName.trim() || undefined, billingAddress: f.billingAddress.trim() || undefined, billingTaxId: f.billingTaxId.trim() || undefined },
    bookingId: f.bookingId || null, eventType: f.eventType, date: f.date, deliveryTime: f.deliveryTime || undefined, servingTime: f.servingTime || undefined,
    venueName: f.venueName.trim(), deliveryAddress: f.deliveryAddress.trim(), fulfilmentMethod: f.fulfilmentMethod, contactPerson: f.contactPerson.trim(), contactPhone: digits(f.contactPhone) || undefined,
    plates: parseInt(f.plates, 10), mealCategory: f.mealCategory, pricingMode: f.pricingMode, pricePerPlate: f.pricingMode === 'per_plate' ? num(f.pricePerPlate) : 0,
    items: f.items.map((i) => ({ mealItemId: i.mealItemId || undefined, menuItemId: i.mealItemId ? undefined : i.menuItemId || undefined, name: i.mealItemId || i.menuItemId ? undefined : i.name.trim(), unit: i.unit, quantity: num(i.quantity), unitPrice: f.pricingMode === 'per_plate' && (i.mealItemId || i.menuItemId) ? undefined : num(i.unitPrice) })),
    draftId: draftId || undefined,
    dietaryInstructions: f.dietaryInstructions.trim(), packagingRequirements: f.packagingRequirements.trim(), servingRequirements: f.servingRequirements.trim(), notes: f.notes.trim(),
    staffRequired: f.staffRequired, staffCount: f.staffRequired ? parseInt(f.staffCount, 10) : 0, staffCharge: f.staffRequired ? num(f.staffCharge) : 0,
    utensilsRequired: f.utensilsRequired, equipmentNotes: f.equipmentNotes.trim(), equipmentCharge: f.utensilsRequired ? num(f.equipmentCharge) : 0, setupRequired: f.setupRequired, setupCharge: f.setupRequired ? num(f.setupCharge) : 0,
    deliveryCharge: num(f.deliveryCharge), discount: num(f.discount), taxRate: num(f.taxRate),
  })

  async function saveAsDraft() {
    if (!f.name.trim() && !f.phone.trim() && !f.plates && f.items.length === 0) return setErr('Enter something first (customer, plates or items) so there is a draft to save')
    setBusy(true); setErr('')
    try {
      const { advance, payRef, ...keep } = f // never keep payment details in a draft
      await saveDraft({ id: draftId, kind: 'catering', customerName: f.name, data: { f: { ...keep, advance: '' } } })
      toast('Draft saved'); nav.tab('home')
    } catch (x) { setErr(errMsg(x)) } finally { setBusy(false) }
  }

  async function save(confirm, reason) {
    const e = validate()
    if (e) return setErr(e)
    setBusy(true); setErr('')
    try {
      if (editing) {
        await api.put(`/api/catering/${editing.id}`, { ...body(), expectedVersion: editing.version, confirm: confirm || {}, reason: reason || undefined })
        setImpact(null); toast('Order updated'); nav.back()
      } else {
        const payload = body()
        if (num(f.advance) > 0) payload.advance = { amount: num(f.advance), method: f.payMethod, paidOn: f.payDate, reference: f.payRef.trim(), verify: can('payments.verify') ? f.verifyNow : false, idempotencyKey: crypto.randomUUID() }
        const r = await api.post('/api/catering', payload)
        toast('Order created'); nav.replace('cDetail', { id: r.order.id })
      }
    } catch (x) {
      if (x.code === 'CONFIRMATION_REQUIRED' && editing) setImpact({ ...x.details, message: x.message })
      else if (x.code === 'STALE_VERSION') setErr('Someone else changed this order. Go back and reopen it to see the latest version.')
      else setErr(errMsg(x))
    } finally { setBusy(false) }
  }

  return (
    <div className="cform">
      <h2 className="wizard__title">{editing ? `Edit ${editing.reference}` : 'New Bulk Catering Order'}</h2>
      {postConfirm && <div className="inv-banner">This order is {editing.status.replace(/_/g, ' ')}. Changing plates, menu or price needs manager approval and a reason, and the previous version is kept.</div>}

      <fieldset className="fs"><legend>Service type</legend>
        <div className="opt-picker" role="radiogroup">
          {options.filter((o) => o.active || o.id === f.serviceOptionId).map((o) => (
            <button type="button" role="radio" aria-checked={f.serviceOptionId === o.id} key={o.id} className={`opt-pick ${f.serviceOptionId === o.id ? 'selected' : ''}`} disabled={lockedOpt && o.id !== f.serviceOptionId} onClick={() => setF((s) => ({ ...s, serviceOptionId: o.id }))}>
              <strong>{o.name}</strong><small>{o.description}</small>
            </button>
          ))}
        </div>
        {opt?.requiresVendor && <p className="form-hint">This service uses an external vendor. Assign and confirm the vendor from the order page before preparation starts.</p>}
      </fieldset>

      <fieldset className="fs"><legend>Customer</legend>
        <div className="form">
          <Field label="Customer / organisation *"><input value={f.name} onChange={set('name')} /></Field>
          <Field label="Phone *"><input type="tel" inputMode="numeric" maxLength={10} value={f.phone} onChange={set('phone')} /></Field>
          <Field label="Email" hint="Needed to email the bill (PDF) and thank-you note"><input type="email" value={f.email} onChange={set('email')} /></Field>
          <Field label="Address"><textarea rows={2} value={f.address} onChange={set('address')} /></Field>
          <details className="more"><summary>Billing details (for the invoice)</summary>
            <Field label="Billing name"><input value={f.billingName} onChange={set('billingName')} /></Field>
            <Field label="Billing address"><textarea rows={2} value={f.billingAddress} onChange={set('billingAddress')} /></Field>
            <Field label="GSTIN / Tax ID"><input value={f.billingTaxId} onChange={set('billingTaxId')} /></Field>
          </details>
          <label className="consent"><input type="checkbox" checked={f.consent} onChange={set('consent')} /><span>Customer agrees to receive order confirmations, bills and thank-you messages by SMS / WhatsApp, and by email if an address is given.</span></label>
        </div>
      </fieldset>

      <fieldset className="fs"><legend>Event & delivery</legend>
        <div className="form">
          <div className="form-row">
            <Field label="Event type *"><select value={f.eventType} onChange={set('eventType')}><option value="" disabled>Select</option>{EVENT_TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
            <Field label="Event date *"><input type="date" value={f.date} min={editing ? undefined : todayStr()} onChange={set('date')} /></Field>
          </div>
          <div className="form-row">
            <Field label="Food delivery time"><input type="time" value={f.deliveryTime} onChange={set('deliveryTime')} /></Field>
            <Field label="Serving time"><input type="time" value={f.servingTime} onChange={set('servingTime')} /></Field>
          </div>
          <Field label="Fulfilment"><select value={f.fulfilmentMethod} onChange={set('fulfilmentMethod')}><option value="delivery">Delivery to venue</option><option value="pickup">Customer pickup</option></select></Field>
          <Field label="Venue name"><input value={f.venueName} onChange={set('venueName')} /></Field>
          <Field label="Delivery address"><textarea rows={2} value={f.deliveryAddress} onChange={set('deliveryAddress')} /></Field>
          <div className="form-row">
            <Field label="On-site contact"><input value={f.contactPerson} onChange={set('contactPerson')} /></Field>
            <Field label="Contact phone"><input type="tel" inputMode="numeric" maxLength={10} value={f.contactPhone} onChange={set('contactPhone')} /></Field>
          </div>
          <Field label="Linked hall booking (optional)">
            <select value={f.bookingId} onChange={set('bookingId')}><option value="">None — standalone order</option>{bookings.map((b) => <option key={b.id} value={b.id}>{b.reference} · {b.customer.name} · {b.date}</option>)}
              {editing?.bookingId && !bookings.some((b) => b.id === editing.bookingId) && <option value={editing.bookingId}>{editing.bookingReference}</option>}</select>
          </Field>
        </div>
      </fieldset>

      <fieldset className="fs"><legend>Food requirements</legend>
        <div className="form">
          <div className="form-row">
            <Field label="Plates / portions *"><input type="number" min={1} value={f.plates} onChange={set('plates')} /></Field>
          </div>
          <Field label="Meal"><select value={f.mealCategory} onChange={set('mealCategory')}>{['breakfast', 'lunch', 'snacks', 'dinner', 'full day'].map((m) => <option key={m}>{m}</option>)}</select></Field>
          <div className="seg" role="tablist" aria-label="Pricing method">
            <button type="button" className={f.pricingMode === 'per_plate' ? 'active' : ''} onClick={() => setF((s) => ({ ...s, pricingMode: 'per_plate' }))}>Per plate</button>
            <button type="button" className={f.pricingMode === 'item_based' ? 'active' : ''} onClick={() => setF((s) => ({ ...s, pricingMode: 'item_based' }))}>Item-wise</button>
          </div>
          {f.pricingMode === 'per_plate' && <Field label="Price per plate (₹) *"><input type="number" min={0} step="any" value={f.pricePerPlate} onChange={set('pricePerPlate')} /></Field>}
          <CateringPicker categories={categories} prices={prices} items={f.items} setItems={setItems} showPrice={f.pricingMode === 'item_based'} mgr={mgr} nav={nav} />
          <Field label="Dietary instructions"><textarea rows={2} value={f.dietaryInstructions} onChange={set('dietaryInstructions')} placeholder="e.g. Jain, no onion/garlic" /></Field>
          <Field label="Packaging requirements"><textarea rows={2} value={f.packagingRequirements} onChange={set('packagingRequirements')} /></Field>
          <Field label="Serving requirements"><textarea rows={2} value={f.servingRequirements} onChange={set('servingRequirements')} /></Field>
        </div>
      </fieldset>

      <fieldset className="fs"><legend>Services & charges</legend>
        <div className="form">
          <Field label="Delivery charge (₹)"><input type="number" min={0} step="any" value={f.deliveryCharge} onChange={set('deliveryCharge')} /></Field>
          <label className="consent"><input type="checkbox" checked={f.staffRequired} onChange={set('staffRequired')} /><span>Serving staff required</span></label>
          {f.staffRequired && <div className="form-row"><Field label="Staff count"><input type="number" min={1} value={f.staffCount} onChange={set('staffCount')} /></Field><Field label="Staff charge (₹)"><input type="number" min={0} step="any" value={f.staffCharge} onChange={set('staffCharge')} /></Field></div>}
          <label className="consent"><input type="checkbox" checked={f.utensilsRequired} onChange={set('utensilsRequired')} /><span>Utensils / equipment required</span></label>
          {f.utensilsRequired && <div className="form-row"><Field label="Equipment notes"><input value={f.equipmentNotes} onChange={set('equipmentNotes')} /></Field><Field label="Charge (₹)"><input type="number" min={0} step="any" value={f.equipmentCharge} onChange={set('equipmentCharge')} /></Field></div>}
          <label className="consent"><input type="checkbox" checked={f.setupRequired} onChange={set('setupRequired')} /><span>Setup & cleanup required</span></label>
          {f.setupRequired && <Field label="Setup charge (₹)"><input type="number" min={0} step="any" value={f.setupCharge} onChange={set('setupCharge')} /></Field>}
        </div>
      </fieldset>

      <fieldset className="fs"><legend>Payment</legend>
        <div className="form">
          <div className="form-row">
            <Field label="Discount (₹)"><input type="number" min={0} step="any" value={f.discount} onChange={set('discount')} /></Field>
            <Field label={`${settings.finance.taxLabel} rate (%)`}><input type="number" min={0} max={100} step="any" value={f.taxRate} onChange={set('taxRate')} /></Field>
          </div>
          {!editing && (
            <>
              <Field label="Advance received (₹)" hint={can('payments.verify') ? '' : 'Recorded as awaiting verification until a manager confirms receipt.'}><input type="number" min={0} step="any" value={f.advance} onChange={set('advance')} /></Field>
              {num(f.advance) > 0 && (
                <>
                  <div className="form-row"><Field label="Method"><select value={f.payMethod} onChange={set('payMethod')}>{PAY_METHODS.map((m) => <option key={m}>{m}</option>)}</select></Field><Field label="Date"><input type="date" value={f.payDate} max={todayStr()} onChange={set('payDate')} /></Field></div>
                  <Field label="Reference"><input value={f.payRef} onChange={set('payRef')} /></Field>
                  {can('payments.verify') && <label className="consent"><input type="checkbox" checked={f.verifyNow} onChange={set('verifyNow')} /><span>I have confirmed the money was received (verify now).</span></label>}
                </>
              )}
            </>
          )}
          <Field label="Internal notes"><textarea rows={2} value={f.notes} onChange={set('notes')} /></Field>
        </div>
        <div className="payment-summary">
          <div className="payment-summary__row"><span>Food</span><span>{fmt(food)}</span></div>
          {svc > 0 && <div className="payment-summary__row"><span>Services</span><span>{fmt(svc)}</span></div>}
          {num(f.discount) > 0 && <div className="payment-summary__row"><span>Discount</span><span>− {fmt(num(f.discount))}</span></div>}
          <div className="payment-summary__row"><span>Total (estimate)</span><span>{fmt(total)}</span></div>
          <p className="form-hint" style={{ margin: '.3rem 0 0' }}>The server calculates the final total when you save. Vendor costs are tracked separately and never appear here.</p>
        </div>
      </fieldset>

      {err && <div className="form-error" role="alert">{err}</div>}
      <div className="wizard__nav">
        <button className="btn btn--secondary" onClick={() => nav.back()}>Cancel</button>
        {!editing && <button className="btn btn--outline" style={{ marginLeft: 'auto' }} onClick={saveAsDraft} disabled={busy} data-testid="save-draft">Save as Draft</button>}
        <button className="btn btn--primary btn--large" style={editing ? { marginLeft: 'auto' } : undefined} onClick={() => save()} disabled={busy}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Create order'}</button>
      </div>
      {impact && <ImpactDialog impact={impact} busy={busy} onClose={() => setImpact(null)} onConfirm={(c, reason) => save(c, reason)} />}
    </div>
  )
}

/** Catering Menu → order lines: tick items by category, set the quantity. Names come from the managed menu; prices from Catering Prices. */
function CateringPicker({ categories, prices, items, setItems, showPrice, mgr, nav }) {
  const [q, setQ] = useState('')
  // categories that already hold a ticked item (restored draft, edited order) start open
  const [open, setOpen] = useState(() => new Set(categories.filter((c) => c.items.some((i) => items.some((x) => x.mealItemId === i.id))).map((c) => c.id)))
  const term = q.trim().toLowerCase()
  const byMeal = new Map(items.filter((i) => i.mealItemId).map((i) => [i.mealItemId, i]))
  const known = new Set(categories.flatMap((c) => c.items.map((i) => i.id)))
  const others = items.filter((i) => !i.mealItemId || !known.has(i.mealItemId)) // custom, legacy or since-deactivated lines
  const flip = (id) => setOpen((cur) => { const n = new Set(cur); n.has(id) ? n.delete(id) : n.add(id); return n })
  const toggle = (it) => setItems((cur) => (cur.some((x) => x.mealItemId === it.id)
    ? cur.filter((x) => x.mealItemId !== it.id)
    : [...cur, { mealItemId: it.id, name: it.name, unit: prices[it.id]?.unit || 'plate', quantity: 1, unitPrice: prices[it.id]?.unitPrice ?? '' }]))
  const patch = (match, k, v) => setItems((cur) => cur.map((x) => (match(x) ? { ...x, [k]: v } : x)))
  const total = items.length
  return (
    <div className="cpick" data-testid="catering-picker">
      <div className="extras__head"><strong>Menu items {total > 0 && <small>({total} selected)</small>}</strong>
        <button type="button" className="btn btn--text btn--sm" onClick={() => setItems((cur) => [...cur, { mealItemId: null, name: '', unit: 'kg', quantity: 1, unitPrice: '' }])}>+ Custom item</button>
      </div>
      {categories.length === 0 && <p className="form-hint">The Catering Menu is empty. Add categories and items under More → Catering Menu.</p>}
      {categories.length > 0 && <input type="search" className="mealpick__search" placeholder="Search menu items…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search menu items" />}
      {categories.map((c) => {
        const list = c.items.filter((i) => !term || i.name.toLowerCase().includes(term))
        if (!list.length) return null
        const chosen = c.items.filter((i) => byMeal.has(i.id)).length
        const expanded = open.has(c.id) || !!term
        return (
          <section className="cpick__cat" key={c.id} data-category={c.name}>
            <button type="button" className="cpick__head" aria-expanded={expanded} onClick={() => flip(c.id)}><span aria-hidden>{expanded ? '▾' : '▸'}</span> <strong>{c.name}</strong> <small>{chosen ? `${chosen} selected` : `${c.items.length} ${c.items.length === 1 ? 'item' : 'items'}`}</small></button>
            {expanded && list.map((it) => {
              const line = byMeal.get(it.id)
              const p = prices[it.id]
              return (
                <div className={`cpick__item ${line ? 'is-on' : ''}`} key={it.id}>
                  <label className="cpick__label"><input type="checkbox" checked={!!line} onChange={() => toggle(it)} /><span className="cpick__name">{it.name}</span>
                    {showPrice && <span className={p ? 'cpick__price' : 'cpick__price cpick__price--none'}>{p ? `${fmt(p.unitPrice)}/${p.unit}` : 'no price'}</span>}</label>
                  {line && (
                    <span className="cpick__qty">
                      <input type="number" min="0" step="any" value={line.quantity} onChange={(e) => patch((x) => x.mealItemId === it.id, 'quantity', e.target.value)} aria-label={`Quantity of ${it.name}`} />
                      <span>{line.unit}</span>
                      {showPrice && (mgr || !p) && <input type="number" min="0" step="any" value={line.unitPrice} placeholder="₹" onChange={(e) => patch((x) => x.mealItemId === it.id, 'unitPrice', e.target.value)} aria-label={`Price of ${it.name}`} disabled={!mgr} className="cpick__pricein" />}
                    </span>
                  )}
                </div>
              )
            })}
          </section>
        )
      })}
      {others.length > 0 && (
        <section className="cpick__cat">
          <div className="cpick__head"><strong>Other items on this order</strong></div>
          {others.map((i) => {
            const idx = items.indexOf(i)
            return (
              <div className="cpick__item is-on" key={idx}>
                <input value={i.name} onChange={(e) => patch((x) => x === i, 'name', e.target.value)} disabled={!!i.mealItemId || !!i.menuItemId} aria-label="Item name" placeholder="Item name" className="cpick__customname" />
                <span className="cpick__qty">
                  <input type="number" min="0" step="any" value={i.quantity} onChange={(e) => patch((x) => x === i, 'quantity', e.target.value)} aria-label={`Quantity of ${i.name || 'item'}`} />
                  <select value={i.unit} onChange={(e) => patch((x) => x === i, 'unit', e.target.value)} disabled={!!i.mealItemId || !!i.menuItemId} aria-label="Unit">{UNITS.map((u) => <option key={u}>{u}</option>)}</select>
                  {showPrice && <input type="number" min="0" step="any" value={i.unitPrice} placeholder="₹" onChange={(e) => patch((x) => x === i, 'unitPrice', e.target.value)} aria-label="Unit price" disabled={!mgr && !!(i.mealItemId || i.menuItemId)} className="cpick__pricein" />}
                  <button type="button" className="icon-btn danger" onClick={() => setItems((cur) => cur.filter((x) => x !== i))} aria-label="Remove item"><Icon name="trash" size={16} /></button>
                </span>
              </div>
            )
          })}
        </section>
      )}
      {nav && <button type="button" className="btn btn--text btn--sm" onClick={() => nav.go('mealMenu')}>Manage Catering Menu →</button>}
    </div>
  )
}
