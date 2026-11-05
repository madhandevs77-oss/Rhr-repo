import { useState } from 'react'
import { api, errMsg } from '../api'
import { Async, AsyncButton, Field, Icon, Modal, useToast } from '../components/common'
import { Invoices, Messages, MoneySummary, Payments, ReasonModal, Row, Section, useSections } from '../components/DocParts'
import { useApp, useLoad } from '../store'
import { cap, fmt, fmtDate, fmtDateTime, fmtTime, PAY_LABEL, waLink } from '../utils'
import { cTagClass } from './CateringList'

const FLOW = ['draft', 'quotation_sent', 'awaiting_confirmation', 'confirmed', 'preparation', 'ready_for_dispatch', 'delivered', 'completed']
const LABEL = { draft: 'Back to draft', quotation_sent: 'Quotation sent', awaiting_confirmation: 'Awaiting customer', confirmed: 'Confirm order', preparation: 'Start preparation', ready_for_dispatch: 'Ready for dispatch', delivered: 'Mark delivered', completed: 'Mark completed', exception: 'Report a problem', cancelled: 'Cancel order' }
const VSTEPS = { proposed: ['quoted', 'assigned', 'declined', 'cancelled'], quoted: ['assigned', 'declined', 'cancelled'], assigned: ['accepted', 'declined', 'cancelled'], accepted: ['in_preparation', 'ready', 'failed', 'cancelled'], in_preparation: ['ready', 'failed', 'cancelled'], ready: ['delivered', 'failed', 'cancelled'], delivered: [], declined: [], failed: [], cancelled: [] }

export default function CateringDetail({ nav, id }) {
  const res = useLoad(() => api.get(`/api/catering/${id}`), [id])
  return <Async res={res}>{({ order }) => <Detail nav={nav} o={order} reload={res.reload} />}</Async>
}

function Detail({ nav, o, reload }) {
  const { can } = useApp()
  const toast = useToast()
  const [open, toggle] = useSections({ money: true, event: true, vendor: true, quotes: false, payments: true, invoices: true, messages: false, versions: false })
  const [modal, setModal] = useState(null)
  const m = o.money
  const terminal = ['cancelled', 'completed'].includes(o.status)
  const live = o.invoices.find((i) => i.status === 'issued')

  const go = async (to, extra = {}) => {
    try { await api.post(`/api/catering/${o.id}/status`, { to, ...extra }); toast(`Order ${cap(to).toLowerCase()}`); reload() } catch (e) {
      if (e.code === 'CONFIRMATION_REQUIRED') setModal({ type: 'cancel', message: e.message })
      else toast(errMsg(e), 'error')
    }
  }
  const forward = o.allowedNext.filter((s) => !['cancelled', 'exception', 'draft'].includes(s))

  return (
    <>
      <div className="booking-detail__header">
        <div className="booking-detail__name">{o.customer.name}</div>
        <div className="booking-detail__phone">{o.customer.phone}</div>
        <span className={`booking-detail__status tag tag--${cTagClass(o.status)}`}>{cap(o.status)}</span>{' '}
        {m.state !== 'none' && <span className={`booking-detail__status tag tag--pay-${m.state === 'overpaid' ? 'paid' : m.state}`}>{PAY_LABEL[m.state]}</span>}
        <div className="booking-detail__ref">{o.reference} · {o.serviceOption.name}</div>
      </div>

      <div className="booking-detail__quick-actions">
        <a className="quick-action" href={`tel:${o.customer.phone}`}><Icon name="phone" />Call</a>
        <a className="quick-action" href={waLink(o.customer.phone)} target="_blank" rel="noreferrer"><Icon name="wa" />Chat</a>
        <button className="quick-action" disabled={terminal || !can('catering.edit')} onClick={() => nav.go('cForm', { id: o.id })}><Icon name="edit" />Edit</button>
        <button className="quick-action" disabled={!live} onClick={() => nav.go('invoice', { id: live.id, autoPrint: true })}><Icon name="printer" />Print Invoice</button>
      </div>

      <Lifecycle status={o.status} before={o.status === 'exception' ? null : undefined} />
      {o.status === 'exception' && <div className="inv-banner">⚠ Problem reported: {o.exceptionReason}</div>}
      {o.cancelReason && <div className="inv-banner">Cancelled: {o.cancelReason}</div>}

      {!terminal && (
        <div className="next-steps">
          {forward.map((s) => (
            <AsyncButton key={s} className="btn btn--primary" onClick={() => go(s)}>{LABEL[s]}</AsyncButton>
          ))}
          {o.allowedNext.includes('draft') && <AsyncButton className="btn btn--outline" onClick={() => go('draft')}>{LABEL.draft}</AsyncButton>}
          {o.allowedNext.includes('exception') && <button className="btn btn--outline" onClick={() => setModal({ type: 'exception' })}>{LABEL.exception}</button>}
          {o.allowedNext.includes('cancelled') && can('catering.cancel') && <button className="btn btn--danger" onClick={() => setModal({ type: 'cancel' })}>{LABEL.cancelled}</button>}
        </div>
      )}

      <Section title="Amount & balance" open={open.money} onToggle={() => toggle('money')}><MoneySummary money={m} /></Section>

      <Section title="Event & delivery" open={open.event} onToggle={() => toggle('event')}>
        <Row l="Event" v={o.eventType} />
        <Row l="Date" v={fmtDate(o.date)} />
        <Row l="Delivery / serving" v={`${o.deliveryTime ? fmtTime(o.deliveryTime) : '—'} / ${o.servingTime ? fmtTime(o.servingTime) : '—'}`} />
        <Row l="Fulfilment" v={cap(o.fulfilmentMethod)} />
        {o.venueName && <Row l="Venue" v={o.venueName} />}
        {o.deliveryAddress && <Row l="Address" v={o.deliveryAddress} />}
        {(o.contactPerson || o.contactPhone) && <Row l="On-site contact" v={`${o.contactPerson} ${o.contactPhone}`.trim()} />}
        <Row l="Plates" v={o.plates} />
        <Row l="Meal" v={cap(o.mealCategory)} />
        {o.bookingReference && <Row l="Hall booking" v={<button className="btn btn--text btn--sm" onClick={() => nav.go('detail', { id: o.bookingId })}>{o.bookingReference}</button>} />}
        {o.items.length > 0 && <div className="food-selection-display">{o.items.map((i) => <span className="food-tag" key={i.id}>{i.name} × {i.quantity} {i.unit}</span>)}</div>}
        {o.dietaryInstructions && <Row l="Dietary" v={o.dietaryInstructions} />}
        {o.packagingRequirements && <Row l="Packaging" v={o.packagingRequirements} />}
        {o.servingRequirements && <Row l="Serving" v={o.servingRequirements} />}
        {o.notes && <Row l="Notes" v={o.notes} />}
      </Section>

      <Section title="Vendor / partner" open={open.vendor} onToggle={() => toggle('vendor')}>
        <VendorPanel o={o} reload={reload} />
      </Section>

      <Section title="Quotations" open={open.quotes} onToggle={() => toggle('quotes')} badge={o.quotations.length || null}>
        {o.quotations.length === 0 && <p className="form-hint">No quotation generated yet.</p>}
        {o.quotations.map((q) => (
          <div className="inv-row" key={q.id}>
            <div><strong>{q.number}</strong> {q.orderVersion === o.version ? <span className="tag tag--status-confirmed">Matches current order</span> : <span className="tag tag--warn">Outdated</span>}
              <div className="form-hint" style={{ margin: 0 }}>{fmtDateTime(q.createdAt)} · {fmt(q.total)} · valid till {fmtDate(q.validUntil)}</div></div>
            <div className="inv-row__actions"><a className="btn btn--sm btn--outline" href={`/api/catering/quotations/${q.id}/pdf`} target="_blank" rel="noreferrer">PDF</a></div>
          </div>
        ))}
        {!terminal && can('catering.edit') && <AsyncButton className="btn btn--outline btn--sm" onClick={async () => { try { await api.post(`/api/catering/${o.id}/quotations`); toast('Quotation generated'); reload() } catch (e) { toast(errMsg(e), 'error') } }}>{o.quotationCurrent ? 'Generate a new quotation' : 'Generate quotation'}</AsyncButton>}
      </Section>

      <Section title="Payments" open={open.payments} onToggle={() => toggle('payments')} badge={o.payments.length || null}>
        <Payments kind="catering" id={o.id} payments={o.payments} money={m} cancelled={o.status === 'cancelled'} onChange={reload} />
      </Section>

      <Section title="Invoices" open={open.invoices} onToggle={() => toggle('invoices')} badge={o.invoices.length || null}>
        <Invoices nav={nav} invoices={o.invoices} customer={o.customer} onChange={reload} canIssue={can('invoices.issue') && o.status !== 'cancelled'} total={m.total} balance={m.balance}
          onIssue={async () => { try { await api.post(`/api/catering/${o.id}/invoices/issue`); toast('Invoice issued'); reload() } catch (e) { toast(errMsg(e), 'error') } }} />
      </Section>

      <Section title="Customer messages" open={open.messages} onToggle={() => toggle('messages')} badge={o.notifications.length || null}>
        <Messages notifications={o.notifications} customer={o.customer} onChange={reload} thankYou={{ kind: 'catering', id: o.id, allowed: ['delivered', 'completed'].includes(o.status) }} />
      </Section>

      <Section title="Version history" open={open.versions} onToggle={() => toggle('versions')} badge={o.versions.length || null}>
        {o.versions.map((v) => (
          <div className="hist" key={v.id}>
            <div className="hist__head"><strong>Version {v.version}{v.version === o.version ? ' (current)' : ''}</strong><span>{fmtDateTime(v.at)}</span></div>
            <div className="hist__money">Total {fmt(v.total)} · {v.summary}</div>
            {v.reason && <div className="hist__reason">Reason: {v.reason}</div>}
            <button className="btn btn--text btn--sm" onClick={() => setModal({ type: 'version', v })}>View this version</button>
          </div>
        ))}
      </Section>

      {modal?.type === 'exception' && <ReasonModal title="Report a problem" label="What went wrong? (e.g. vehicle breakdown, vendor unavailable)" confirm="Mark as exception" onClose={() => setModal(null)} onSubmit={(reason) => go('exception', { reason })} />}
      {modal?.type === 'cancel' && <ReasonModal title="Cancel order" label={modal.message || 'Reason for cancelling'} confirm="Cancel order" danger onClose={() => setModal(null)} onSubmit={(reason) => go('cancelled', { reason, confirm: true })} />}
      {modal?.type === 'version' && <VersionModal id={o.id} v={modal.v} onClose={() => setModal(null)} />}
    </>
  )
}

function Lifecycle({ status }) {
  const idx = FLOW.indexOf(status)
  return (
    <ol className="lifecycle" aria-label="Order progress">
      {FLOW.map((s, i) => (
        <li key={s} className={`${i < idx ? 'done' : ''} ${s === status ? 'current' : ''}`}><span>{i < idx ? '✓' : i + 1}</span><em>{cap(s)}</em></li>
      ))}
    </ol>
  )
}

function VendorPanel({ o, reload }) {
  const { can } = useApp()
  const toast = useToast()
  const vendors = useLoad(() => (can('vendors.view') ? api.get('/api/vendors') : Promise.resolve({ vendors: [] })), [])
  const [pick, setPick] = useState('')
  const [edit, setEdit] = useState(false)
  const v = o.vendor
  const terminal = ['cancelled', 'completed'].includes(o.status)
  const assign = async () => { try { await api.post(`/api/catering/${o.id}/vendor`, { vendorId: pick }); toast('Vendor assigned'); setPick(''); reload() } catch (e) { toast(errMsg(e), 'error') } }
  return (
    <>
      {o.serviceOption.requiresVendor && !v && <p className="form-hint">⚠ This service needs a vendor. Assign one, record their agreed cost, and get their acceptance before preparation.</p>}
      {!o.serviceOption.requiresVendor && !v && <p className="form-hint">Not required for this service. You can still assign a vendor for part of the work.</p>}
      {v && (
        <>
          <Row l="Vendor" v={v.vendorName} />
          <Row l="Vendor status" v={cap(v.status)} />
          {v.quoteAmount !== null && <Row l="Vendor quote" v={fmt(v.quoteAmount)} />}
          {v.agreedCost !== null && <Row l="Agreed cost" v={fmt(v.agreedCost)} />}
          {v.finalCost !== null && <Row l="Final cost" v={fmt(v.finalCost)} />}
          {v.finalCost !== null && <Row l="Margin (customer total − vendor cost)" v={fmt(o.money.total - v.finalCost)} cls={o.money.total - v.finalCost >= 0 ? 'success' : 'warning'} />}
          <p className="form-hint">Vendor costs are internal. They never appear on the customer's quotation or invoice.</p>
        </>
      )}
      {can('vendors.manage') && !terminal && (
        <div className="vendor-actions">
          {v && VSTEPS[v.status].length > 0 && <button className="btn btn--outline btn--sm" onClick={() => setEdit(true)}>Update vendor status</button>}
          {(!v || !['in_preparation', 'ready', 'delivered'].includes(v.status)) && (
            <div className="vendor-assign">
              <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Vendor"><option value="">{v ? 'Reassign to…' : 'Choose vendor…'}</option>{(vendors.data?.vendors || []).filter((x) => x.active && x.id !== v?.vendorId).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
              <AsyncButton className="btn btn--primary btn--sm" disabled={!pick} onClick={assign}>{v ? 'Reassign' : 'Assign'}</AsyncButton>
            </div>
          )}
          {!vendors.loading && (vendors.data?.vendors || []).length === 0 && <p className="form-hint">No vendors yet. Add them under More → Vendors.</p>}
        </div>
      )}
      {edit && <VendorStatusModal o={o} onClose={() => setEdit(false)} onDone={reload} />}
    </>
  )
}

function VendorStatusModal({ o, onClose, onDone }) {
  const v = o.vendor
  const toast = useToast()
  const next = VSTEPS[v.status]
  const [f, setF] = useState({ status: next[0], quoteAmount: v.quoteAmount ?? '', agreedCost: v.agreedCost ?? '', finalCost: v.finalCost ?? '', notes: '' })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true); setErr('')
    const b = { status: f.status }
    if (f.quoteAmount !== '') b.quoteAmount = parseFloat(f.quoteAmount)
    if (f.agreedCost !== '') b.agreedCost = parseFloat(f.agreedCost)
    if (f.finalCost !== '') b.finalCost = parseFloat(f.finalCost)
    if (f.notes.trim()) b.notes = f.notes.trim()
    try { await api.patch(`/api/catering/${o.id}/vendor`, b); toast('Vendor updated'); onDone(); onClose() } catch (e) { setErr(errMsg(e)); setBusy(false) }
  }
  return (
    <Modal title={`${v.vendorName}: update`} onClose={onClose} footer={<><button className="btn btn--secondary" onClick={onClose}>Cancel</button><button className="btn btn--primary" onClick={submit} disabled={busy}>Save</button></>}>
      <div className="form">
        <Field label="New status"><select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>{next.map((s) => <option key={s} value={s}>{cap(s)}</option>)}</select></Field>
        <Field label="Vendor quote (₹)"><input type="number" min={0} step="any" value={f.quoteAmount} onChange={(e) => setF({ ...f, quoteAmount: e.target.value })} /></Field>
        <Field label="Agreed cost (₹)" hint="Required when assigning / accepting"><input type="number" min={0} step="any" value={f.agreedCost} onChange={(e) => setF({ ...f, agreedCost: e.target.value })} /></Field>
        <Field label="Final cost (₹)" hint="Required when recording delivery"><input type="number" min={0} step="any" value={f.finalCost} onChange={(e) => setF({ ...f, finalCost: e.target.value })} /></Field>
        <Field label="Notes"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        {err && <div className="form-error" role="alert">{err}</div>}
      </div>
    </Modal>
  )
}

function VersionModal({ id, v, onClose }) {
  const res = useLoad(() => api.get(`/api/catering/${id}/versions/${v.version}`), [id, v.version])
  return (
    <Modal title={`Version ${v.version}`} onClose={onClose}>
      <Async res={res}>
        {({ snapshot: s }) => {
          const lines = s.money?.lines || s.lines || []
          return (
            <>
              <Row l="Total" v={fmt(s.money?.total ?? v.total)} />
              <Row l="Plates" v={s.plates ?? '—'} />
              {s.date && <Row l="Date" v={fmtDate(s.date)} />}
              {lines.map((l, i) => <Row key={i} l={`${l.description}${l.quantity ? ` × ${l.quantity}` : ''}`} v={fmt(l.amount)} />)}
              <p className="form-hint">This is a read-only copy of the order as it was in version {v.version}.</p>
            </>
          )
        }}
      </Async>
    </Modal>
  )
}
