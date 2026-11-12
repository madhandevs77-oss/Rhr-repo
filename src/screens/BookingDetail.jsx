import { useState } from 'react'
import { api, errMsg } from '../api'
import { Async, Field, Icon, Modal, AsyncButton, useToast } from '../components/common'
import { Invoices, Messages, MoneySummary, Payments, Row, Section, useSections } from '../components/DocParts'
import MenuPrint from '../components/MenuPrint'
import { useApp, useLoad } from '../store'
import { cap, fmt, fmtDate, fmtDateLong, fmtDateTime, fmtRange, PAY_LABEL, todayStr, waLink } from '../utils'

export default function BookingDetail({ nav, id }) {
  const res = useLoad(() => api.get(`/api/bookings/${id}`), [id])
  return <Async res={res}>{({ booking }) => <Detail nav={nav} b={booking} reload={res.reload} />}</Async>
}

function Detail({ nav, b, reload }) {
  const { can, reloadHalls } = useApp()
  const toast = useToast()
  const [open, toggle] = useSections({ money: true, details: true, payments: true, invoices: true, messages: false, history: false, food: false })
  const [modal, setModal] = useState(null)
  const cancelled = b.status === 'cancelled'
  const m = b.money
  const liveInvoice = b.invoices.find((i) => i.status === 'issued')

  return (
    <>
      <div className="booking-detail__header">
        <div className="booking-detail__name">{b.customer.name}</div>
        <div className="booking-detail__phone">{b.customer.phone}{b.customer.altPhone ? ` · ${b.customer.altPhone}` : ''}</div>
        <span className={`booking-detail__status tag tag--status-${b.status}`}>{b.status}</span>{' '}
        {!cancelled && m.state !== 'none' && <span className={`booking-detail__status tag tag--pay-${m.state === 'overpaid' ? 'paid' : m.state}`}>{PAY_LABEL[m.state]}</span>}
        <div className="booking-detail__ref">{b.reference}</div>
      </div>

      <div className="booking-detail__quick-actions">
        <a className="quick-action" href={`tel:${b.customer.phone}`}><Icon name="phone" />Call</a>
        <a className="quick-action" href={waLink(b.customer.phone)} target="_blank" rel="noreferrer"><Icon name="wa" />Chat</a>
        <button className="quick-action" disabled={cancelled || !can('bookings.edit')} onClick={() => nav.go('form', { id: b.id })}><Icon name="edit" />Edit</button>
        <button className="quick-action" disabled={!liveInvoice} title={liveInvoice ? 'Print the invoice' : 'Available once the booking is fully paid and verified'} onClick={() => nav.go('invoice', { id: liveInvoice.id, autoPrint: true })} data-testid="print-invoice"><Icon name="printer" />Print Invoice</button>
      </div>

      <Section title="Amount & balance" open={open.money} onToggle={() => toggle('money')}>
        {b.hallKind && <p className="form-hint" style={{ marginBottom: '.4rem' }}>{m.basis === 'estimate' ? 'Estimate — becomes confirmed once an advance is verified.' : m.basis === 'cancelled' ? 'Cancelled' : 'Confirmed amount'}</p>}
        <MoneySummary money={m} />
        <div className="menu-actions no-print">
          <a className="btn btn--outline btn--sm" href={`/api/bookings/${b.id}/bill.pdf`} target="_blank" rel="noreferrer" data-testid="customer-bill"><Icon name="printer" size={16} /> Customer Bill</a>
          <a className="btn btn--outline btn--sm" href={`/api/bookings/${b.id}/bill.pdf?download=1`} download={`bill-${b.reference}.pdf`}>Bill PDF</a>
        </div>
      </Section>

      <Section title="Booking Details" open={open.details} onToggle={() => toggle('details')}>
        <Row l="Event Type" v={b.eventType} />
        <Row l="Date" v={b.date ? fmtDateLong(b.date) : 'Not set'} />
        <Row l="Time" v={b.startTime ? fmtRange(b.startTime, b.endTime, b.endsNextDay) : 'Not set'} />
        <Row l="Hall" v={b.hallName} />
        {b.fulfilment && <Row l="Service" v={b.fulfilment === 'delivery' ? 'Delivery' : 'Takeaway'} />}
        {b.fulfilment === 'delivery' && <Row l="Delivery address" v={b.deliveryAddress} />}
        {b.customer.address && <Row l="Address" v={b.customer.address} />}
        {b.notes && <Row l="Notes" v={b.notes} />}
        {cancelled && <Row l="Cancelled" v={`${b.cancelledAt ? fmtDate(b.cancelledAt.slice(0, 10)) : ''}${b.cancelReason ? ` · ${b.cancelReason}` : ''}`} />}
      </Section>

      <Section title="Payments" open={open.payments} onToggle={() => toggle('payments')} badge={b.payments.length || null}>
        <Payments kind="booking" id={b.id} payments={b.payments} money={m} cancelled={cancelled} onChange={reload} balanceBuckets={{ catering: m.buckets.catering.due }} />
      </Section>

      <Section title="Invoices" open={open.invoices} onToggle={() => toggle('invoices')} badge={b.invoices.length || null}>
        <Invoices nav={nav} invoices={b.invoices} customer={b.customer} onChange={reload} canIssue={can('invoices.issue') && !cancelled} total={m.total} balance={m.balance}
          onIssue={async () => { try { await api.post(`/api/bookings/${b.id}/invoices/issue`); toast('Invoice issued'); reload() } catch (e) { toast(errMsg(e), 'error') } }} />
      </Section>

      <Section title="Customer messages" open={open.messages} onToggle={() => toggle('messages')} badge={b.notifications.length || null}>
        <Messages notifications={b.notifications} customer={b.customer} onChange={reload} thankYou={{ kind: 'booking', id: b.id, allowed: b.status === 'confirmed' && b.date <= todayStr() }} />
      </Section>

      {b.linkedCatering?.length > 0 && (
        <Section title="Linked catering orders" open onToggle={() => {}}>
          {b.linkedCatering.map((o) => (
            <div className="inv-row" key={o.id}><div><strong>{o.reference}</strong><div className="form-hint" style={{ margin: 0 }}>{cap(o.status)}</div></div><button className="btn btn--sm btn--outline" onClick={() => nav.go('cDetail', { id: o.id })}>Open</button></div>
          ))}
        </Section>
      )}

      <Section title="Food" open={open.food} onToggle={() => toggle('food')}>
        <Row l="Food Status" v={b.foodStatus === 'confirmed' ? '✓ Confirmed' : 'Pending'} />
        {b.catering && <Row l="Catering" v={`${b.catering.plates} plates × ${fmt(b.catering.pricePerPlate)}`} />}
        {b.hallKind && b.meals?.length > 0 && <Row l="Meals" v={b.meals.map(cap).join(', ')} />}
        {b.hallKind && b.foodAmount > 0 && <Row l="Food-service amount (agreed)" v={fmt(b.foodAmount)} />}
        {b.foodItems?.length ? (
          [...new Map([...b.foodItems].sort((x, y) => (x.categorySort ?? 999) - (y.categorySort ?? 999)).map((f) => [f.category || 'Other', null])).keys()].map((cat) => (
            <div key={cat}><div className="food-list__category-title" style={{ marginTop: '.5rem' }}>{cat}</div><div className="food-selection-display">{b.foodItems.filter((f) => (f.category || 'Other') === cat).map((f, i) => <span className="food-tag" key={i}>{f.name}</span>)}</div></div>
          ))
        ) : <p className="form-hint" style={{ marginTop: '.5rem' }}>No food selections yet</p>}
        {b.foodItems?.length > 0 && (
          <div className="menu-actions no-print">
            <button className="btn btn--outline btn--sm" onClick={() => setModal('menu')} data-testid="open-menu-print"><Icon name="printer" size={16} /> Print Kitchen Sheet</button>
            <a className="btn btn--outline btn--sm" href={`/api/meal-menu/booking/${b.id}/pdf?download=1`} download="kitchen-sheet.pdf">Kitchen Sheet PDF</a>
          </div>
        )}
        {!cancelled && can('bookings.edit') && (
          <AsyncButton className="btn btn--outline btn--sm btn--block" style={{ marginTop: '.75rem' }} onClick={async () => {
            try { await api.patch(`/api/bookings/${b.id}/food`, { foodStatus: b.foodStatus === 'confirmed' ? 'pending' : 'confirmed', expectedVersion: b.version }); toast('Food status updated'); reload() } catch (e) { toast(errMsg(e), 'error'); reload() }
          }}>{b.foodStatus === 'confirmed' ? 'Mark food as pending' : 'Mark food as confirmed'}</AsyncButton>
        )}
      </Section>

      <Section title="Change history" open={open.history} onToggle={() => toggle('history')} badge={b.history.length || null}>
        {b.history.length === 0 && <p className="form-hint">No edits yet</p>}
        {b.history.map((h) => (
          <div className="hist" key={h.id}>
            <div className="hist__head"><strong>{h.summary}</strong><span>{fmtDateTime(h.at)} · {h.by || 'system'}</span></div>
            {h.totalBefore !== h.totalAfter && <div className="hist__money">Total {fmt(h.totalBefore)} → {fmt(h.totalAfter)}</div>}
            {h.reason && <div className="hist__reason">Reason: {h.reason}</div>}
            <ul>{(h.changes || []).map((c, i) => <li key={i}>{c.field}: <s>{String(c.from) || '—'}</s> → {String(c.to) || '—'}</li>)}</ul>
          </div>
        ))}
      </Section>

      <div className="detail-footer">
        {can('catering.create') && !cancelled && <button className="btn btn--outline btn--block" onClick={() => nav.go('cForm', { bookingId: b.id })}><Icon name="truck" size={16} /> Add bulk catering order for this event</button>}
        {cancelled ? (
          can('bookings.cancel') && <AsyncButton className="btn btn--secondary btn--block" onClick={async () => { try { await api.post(`/api/bookings/${b.id}/restore`); toast('Booking restored'); reloadHalls(); reload() } catch (e) { toast(errMsg(e), 'error') } }}>Restore Booking</AsyncButton>
        ) : (
          can('bookings.cancel') && <button className="btn btn--danger btn--block" onClick={() => setModal('cancel')}>Cancel Booking</button>
        )}
      </div>

      {modal === 'menu' && <MenuPrint bookingId={b.id} onClose={() => setModal(null)} />}
      {modal === 'cancel' && <CancelModal b={b} onClose={() => setModal(null)} onDone={reload} />}
    </>
  )
}

function CancelModal({ b, onClose, onDone }) {
  const toast = useToast()
  const [reason, setReason] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const hasMoney = b.money.paid > 0 || b.money.pending > 0
  const submit = async () => {
    setBusy(true); setErr('')
    try {
      await api.post(`/api/bookings/${b.id}/cancel`, { reason: reason.trim(), confirm: true, expectedVersion: b.version })
      toast('Booking cancelled', 'warning'); onDone(); onClose()
    } catch (e) { setErr(errMsg(e)); setBusy(false) }
  }
  return (
    <Modal title="Cancel booking?" small onClose={onClose} footer={<><button className="btn btn--secondary" onClick={onClose}>Keep booking</button><button className="btn btn--danger" disabled={busy || reason.trim().length < 3} onClick={submit}>Cancel booking</button></>}>
      <p className="modal__desc">This frees {b.hallName}{b.date ? ` on ${fmtDate(b.date)}` : ''}. The booking, payments and history stay on record.{hasMoney ? ` ${fmt(b.money.paid)} has been received — any refund must be recorded separately under Payments.` : ''}{b.invoices.some((i) => i.status === 'issued') ? ' The current invoice will be marked void.' : ''}</p>
      <Field label="Reason *"><input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
      {err && <div className="form-error" role="alert">{err}</div>}
    </Modal>
  )
}
