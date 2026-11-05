// Pieces shared by the hall-booking and catering detail screens: money summary, payments, invoices, messages.
import { useRef, useState } from 'react'
import { api, errMsg } from '../api'
import { useApp } from '../store'
import { PAY_METHODS } from '../data'
import { cap, fmt, fmtDate, fmtDateTime, PAY_LABEL, todayStr } from '../utils'
import { AsyncButton, Confirm, Empty, Field, Icon, Modal, useToast } from './common'

export function Section({ title, open, onToggle, children, badge }) {
  return (
    <div className={`detail-section ${open ? 'open' : ''}`}>
      <button className="detail-section__header" onClick={onToggle} aria-expanded={open}>
        <span>{title}{badge ? <em className="badge">{badge}</em> : null}</span>
        <Icon name="chevD" size={18} />
      </button>
      <div className="detail-section__body">{children}</div>
    </div>
  )
}
export const Row = ({ l, v, cls }) => (
  <div className="detail-row"><span className="detail-row__label">{l}</span><span className={`detail-row__value ${cls ? 'detail-row__value--' + cls : ''}`}>{v}</span></div>
)
export const useSections = (init) => {
  const [open, setOpen] = useState(init)
  return [open, (k) => setOpen((o) => ({ ...o, [k]: !o[k] }))]
}

export function MoneySummary({ money }) {
  return (
    <>
      {money.lines.map((l, i) => (
        <Row key={i} l={`${l.description}${l.quantity !== 1 || l.unit ? ` (${l.quantity}${l.unit ? ' ' + l.unit : ''} × ${fmt(l.unitPrice)})` : ''}`} v={fmt(l.amount)} />
      ))}
      {money.discount > 0 && <Row l="Discount" v={`− ${fmt(money.discount)}`} />}
      {money.tax > 0 && <Row l="Taxable amount" v={fmt(money.taxable)} />}
      {money.tax > 0 && <Row l={`GST (${money.taxRate}%)`} v={fmt(money.tax)} />}
      <div className="detail-row detail-row--total"><span>Total</span><span>{fmt(money.total)}</span></div>
      <Row l="Received (verified)" v={fmt(money.paid)} cls="success" />
      {money.pending > 0 && <Row l="Awaiting verification" v={fmt(money.pending)} cls="warning" />}
      <Row l={money.balance < 0 ? 'Refund due' : 'Balance'} v={fmt(Math.abs(money.balance))} cls={money.balance === 0 ? 'success' : 'warning'} />
      <div className="paystate"><span className={`tag tag--pay-${money.state === 'overpaid' ? 'paid' : money.state}`}>{PAY_LABEL[money.state] || money.state}</span></div>
    </>
  )
}

const STATUS_CLS = { verified: 'status-confirmed', pending: 'warn', rejected: 'status-cancelled', reversed: 'status-cancelled' }

export function Payments({ kind, id, payments, money, cancelled, onChange, balanceBuckets }) {
  const { can } = useApp()
  const toast = useToast()
  const [modal, setModal] = useState(null)
  const act = async (fn, msg) => {
    try { await fn(); toast(msg); onChange() } catch (e) { toast(errMsg(e), 'error') }
  }
  return (
    <>
      {payments.length === 0 && <p className="form-hint">No payments recorded</p>}
      {payments.map((p) => (
        <div className={`payment-history-item ${p.status !== 'verified' ? 'is-muted' : ''}`} key={p.id}>
          <div className="payment-history-item__date">{fmtDate(p.paidOn)}</div>
          <div className="payment-history-item__details">
            <div>
              <div className="payment-history-item__type">{p.kind === 'refund' ? 'Refund' : cap(p.stage)} <span className={`tag tag--${STATUS_CLS[p.status] || 'event'}`}>{p.status === 'pending' ? 'Awaiting verification' : cap(p.status)}</span></div>
              <div className="payment-history-item__method">{p.splits?.length > 1 ? p.splits.map((x) => `${x.method} ${fmt(x.amount)}`).join(' + ') : p.method}{p.reference ? ` · ${p.reference}` : ''}{p.notes ? ` · ${p.notes}` : ''}{p.statusReason ? ` · ${p.statusReason}` : ''}</div>
              <div className="payment-history-item__method">Recorded by {p.recordedBy || 'system'}{p.verifiedBy && p.status !== 'pending' ? ` · ${p.status === 'rejected' ? 'rejected' : 'verified'} by ${p.verifiedBy}` : ''}</div>
            </div>
            <span className="payment-history-item__side">
              <span className={`payment-history-item__amount ${p.kind === 'refund' ? 'neg' : ''}`}>{p.kind === 'refund' ? '− ' : ''}{fmt(p.amount)}</span>
              <span className="pay-actions">
                {p.status === 'pending' && can('payments.verify') && (
                  <>
                    <AsyncButton className="btn btn--sm btn--primary" onClick={() => act(() => api.post(`/api/payments/${p.id}/verify`), 'Payment verified')}>Verify</AsyncButton>
                    <button className="btn btn--sm btn--outline" onClick={() => setModal({ type: 'reject', p })}>Reject</button>
                  </>
                )}
                {kind === 'booking' && p.status === 'verified' && p.kind === 'payment' && <a className="btn btn--sm btn--outline" href={`/api/payments/${p.id}/receipt.pdf`} target="_blank" rel="noreferrer" data-testid="receipt-link">{p.stage === 'advance' ? 'Advance receipt' : 'Receipt'}</a>}
                {p.status === 'verified' && p.kind === 'payment' && can('payments.refund') && <button className="btn btn--sm btn--outline" onClick={() => setModal({ type: 'refund', p })}>Refund</button>}
                {['pending', 'verified'].includes(p.status) && p.kind === 'payment' && can('payments.reverse') && <button className="btn btn--sm btn--text danger" onClick={() => setModal({ type: 'reverse', p })}>Reverse</button>}
              </span>
            </span>
          </div>
        </div>
      ))}
      {payments.some((p) => p.status === 'verified') && (() => {
        const ok = payments.filter((p) => p.status === 'verified')
        const sum = (f) => ok.filter(f).reduce((a, p) => a + (p.kind === 'refund' ? -p.amount : p.amount), 0)
        const adv = sum((p) => p.stage === 'advance'), fin = sum((p) => p.stage === 'final'), part = sum((p) => p.stage === 'part')
        return (
          <div className="pay-totals" data-testid="pay-totals">
            <Row l="Confirmed amount" v={fmt(money.total)} />
            <Row l="Total advance (verified)" v={fmt(adv)} />
            {part !== 0 && <Row l="Part payments (verified)" v={fmt(part)} />}
            <Row l="Total final payment (verified)" v={fmt(fin)} />
            <Row l="Total paid" v={fmt(money.paid)} cls="success" />
            <Row l="Outstanding balance" v={fmt(Math.max(0, money.balance))} cls={money.balance <= 0 ? 'success' : 'warning'} />
          </div>
        )
      })()}
      {!cancelled && can('payments.record') && (
        <button className="btn btn--outline btn--sm btn--block" style={{ marginTop: '.6rem' }} onClick={() => setModal({ type: 'add' })}><Icon name="rupee" size={16} /> Record payment</button>
      )}
      {modal?.type === 'add' && <PaymentModal kind={kind} id={id} money={money} buckets={balanceBuckets} onClose={() => setModal(null)} onDone={onChange} />}
      {modal?.type === 'reject' && <ReasonModal title="Reject payment" label="Reason (e.g. money not received)" confirm="Reject" onClose={() => setModal(null)} onSubmit={(reason) => act(() => api.post(`/api/payments/${modal.p.id}/reject`, { reason }), 'Payment rejected')} />}
      {modal?.type === 'reverse' && <ReasonModal title="Reverse payment (admin)" label="Reason for the correction" confirm="Reverse" danger onClose={() => setModal(null)} onSubmit={(reason) => act(() => api.post(`/api/payments/${modal.p.id}/reverse`, { reason }), 'Payment reversed')} />}
      {modal?.type === 'refund' && <RefundModal p={modal.p} onClose={() => setModal(null)} onDone={onChange} />}
    </>
  )
}

export function ReasonModal({ title, label, confirm, danger, onClose, onSubmit }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Modal title={title} small onClose={onClose} footer={<><button className="btn btn--secondary" onClick={onClose}>Cancel</button><button className={`btn ${danger ? 'btn--danger' : 'btn--primary'}`} disabled={busy || reason.trim().length < 3} onClick={async () => { setBusy(true); await onSubmit(reason.trim()); onClose() }}>{confirm}</button></>}>
      <Field label={label}><input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
    </Modal>
  )
}

import SplitPay, { buildSplits, initialSplit } from './SplitPay'

function PaymentModal({ kind, id, money, buckets, onClose, onDone }) {
  const { can } = useApp()
  const toast = useToast()
  const key = useRef(crypto.randomUUID()) // same key on retries => never double-recorded
  const [f, setF] = useState({ amount: '', stage: money.paid > 0 ? 'part' : 'advance', paidOn: todayStr(), reference: '', notes: '', bucket: '', verify: can('payments.verify') })
  const [sel, setSel] = useState(initialSplit)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))
  const submit = async () => {
    const a = parseFloat(f.amount)
    if (!(a > 0)) return setErr('Enter a valid amount')
    if (a > money.balance + 1e-9) return setErr(`Amount exceeds the balance of ${fmt(money.balance)}`)
    const sp = buildSplits(sel, a)
    if (sp.error) return setErr(sp.error)
    setBusy(true); setErr('')
    try {
      const r = await api.post(`/api/${kind === 'booking' ? 'bookings' : 'catering'}/${id}/payments`, {
        amount: a, splits: sp.splits, paidOn: f.paidOn, stage: f.stage, reference: f.reference.trim(), notes: f.notes.trim(), bucket: f.bucket || undefined, idempotencyKey: key.current, verify: can('payments.verify') ? f.verify : undefined,
      })
      toast(r.duplicate ? 'This payment was already recorded' : r.payment.status === 'verified' ? `${fmt(a)} recorded and verified` : `${fmt(a)} recorded — awaiting manager verification`)
      onDone(); onClose()
    } catch (e) { setErr(errMsg(e)); setBusy(false) }
  }
  return (
    <Modal title="Record payment" onClose={onClose} footer={<><button className="btn btn--secondary" onClick={onClose}>Cancel</button><button className="btn btn--primary" onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Record payment'}</button></>}>
      <div className="form">
        <p className="form-hint">Balance pending: <strong>{fmt(Math.max(0, money.balance))}</strong>{money.pending > 0 && ` · ${fmt(money.pending)} awaiting verification`}</p>
        <Field label="Amount (₹)"><input type="number" inputMode="decimal" value={f.amount} onChange={set('amount')} autoFocus /></Field>
        {money.balance > 0 && <button type="button" className="btn btn--outline btn--sm" onClick={() => setF((s) => ({ ...s, amount: String(money.balance), stage: 'final' }))}>Pay full balance</button>}
        {kind === 'booking' && buckets && (
          <Field label="Apply to" hint="Leave on Automatic unless the customer specified.">
            <select value={f.bucket} onChange={set('bucket')}><option value="">Automatic (hall first, then catering)</option><option value="hall">Hall only</option>{buckets.catering > 0 && <option value="catering">Catering only</option>}</select>
          </Field>
        )}
        <div className="form-row">
          <Field label="Type"><select value={f.stage} onChange={set('stage')}><option value="advance">Advance</option><option value="part">Part payment</option><option value="final">Final</option></select></Field>
        </div>
        <SplitPay amount={parseFloat(f.amount) || 0} sel={sel} onChange={setSel} />
        <div className="form-row">
          <Field label="Date"><input type="date" value={f.paidOn} max={todayStr()} onChange={set('paidOn')} /></Field>
          <Field label="Reference / UPI ref"><input value={f.reference} onChange={set('reference')} placeholder="Optional" /></Field>
        </div>
        <Field label="Notes"><input value={f.notes} onChange={set('notes')} placeholder="Optional" /></Field>
        {can('payments.verify') ? (
          <label className="consent"><input type="checkbox" checked={f.verify} onChange={(e) => setF((s) => ({ ...s, verify: e.target.checked }))} /><span>I have confirmed the money was received (verify now).</span></label>
        ) : (
          <p className="form-hint">This will be marked “awaiting verification” until a manager confirms the money was received. Balances, invoices and customer messages only change after verification.</p>
        )}
        {err && <div className="form-error" role="alert">{err}</div>}
      </div>
    </Modal>
  )
}

function RefundModal({ p, onClose, onDone }) {
  const toast = useToast()
  const [f, setF] = useState({ amount: String(p.amount), reason: '', method: p.method === 'Split' ? 'Cash' : p.method, paidOn: todayStr() })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true); setErr('')
    try {
      await api.post(`/api/payments/${p.id}/refund`, { amount: parseFloat(f.amount), reason: f.reason.trim(), method: f.method, paidOn: f.paidOn })
      toast('Refund recorded'); onDone(); onClose()
    } catch (e) { setErr(errMsg(e)); setBusy(false) }
  }
  return (
    <Modal title="Refund" onClose={onClose} footer={<><button className="btn btn--secondary" onClick={onClose}>Cancel</button><button className="btn btn--primary" disabled={busy || f.reason.trim().length < 3 || !(parseFloat(f.amount) > 0)} onClick={submit}>Record refund</button></>}>
      <div className="form">
        <p className="form-hint">Refund against the {fmt(p.amount)} payment of {fmtDate(p.paidOn)}. The original payment stays on record.</p>
        <Field label="Refund amount (₹)"><input type="number" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <div className="form-row">
          <Field label="Method"><select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{PAY_METHODS.map((x) => <option key={x}>{x}</option>)}</select></Field>
          <Field label="Date"><input type="date" value={f.paidOn} max={todayStr()} onChange={(e) => setF({ ...f, paidOn: e.target.value })} /></Field>
        </div>
        <Field label="Reason *"><input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
        {err && <div className="form-error" role="alert">{err}</div>}
      </div>
    </Modal>
  )
}

/** Pick how to deliver a message (text and/or email) and send it. `run(channels)` does the API call. */
export function SendModal({ title, intro, email, run, onClose, onDone }) {
  const toast = useToast()
  const [phone, setPhone] = useState(true)
  const [mail, setMail] = useState(!!email)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const submit = async () => {
    const channels = [...(phone ? ['phone'] : []), ...(mail ? ['email'] : [])]
    if (!channels.length) return setErr('Choose at least one way to send it')
    setBusy(true); setErr('')
    try { await run(channels); toast('Queued — the customer will receive it in a few moments'); onDone?.(); onClose() } catch (e) { setErr(errMsg(e)) } finally { setBusy(false) }
  }
  return (
    <Modal title={title} onClose={onClose} small footer={<><button className="btn btn--secondary" onClick={onClose}>Cancel</button><button className="btn btn--primary" onClick={submit} disabled={busy}>{busy ? 'Sending…' : 'Send'}</button></>}>
      <p className="form-hint">{intro}</p>
      <label className="consent"><input type="checkbox" checked={phone} onChange={(e) => setPhone(e.target.checked)} /><span>Text message (SMS / WhatsApp) to the customer’s phone</span></label>
      <label className="consent" style={{ marginTop: '.5rem', opacity: email ? 1 : 0.6 }}><input type="checkbox" checked={mail} disabled={!email} onChange={(e) => setMail(e.target.checked)} /><span>{email ? <>Email to <strong>{email}</strong></> : 'Email — no email address on file (add it on the booking to enable)'}</span></label>
      {err && <div className="form-error" role="alert">{err}</div>}
    </Modal>
  )
}

export function Invoices({ nav, invoices, canIssue, onIssue, balance, total, customer, onChange }) {
  const { can } = useApp()
  const [sending, setSending] = useState(null)
  const live = invoices.find((i) => i.status === 'issued')
  return (
    <>
      {invoices.length === 0 && <p className="form-hint">{total > 0 && balance === 0 ? 'No invoice has been issued yet.' : 'The final invoice is generated automatically once verified payments cover the full amount.'}</p>}
      {invoices.map((i) => (
        <div className="inv-row" key={i.id}>
          <div>
            <strong>{i.number}</strong> <span className={`tag tag--${i.status === 'issued' ? 'status-confirmed' : 'status-cancelled'}`}>{i.status === 'issued' ? 'Current' : cap(i.status)}</span>
            <div className="form-hint" style={{ margin: 0 }}>{fmtDateTime(i.issuedAt)} · {fmt(i.total)}{i.statusReason ? ` · ${i.statusReason}` : ''}</div>
          </div>
          <div className="inv-row__actions">
            <button className="btn btn--sm btn--outline" onClick={() => nav.go('invoice', { id: i.id })}>View</button>
            <button className="btn btn--sm btn--outline" onClick={() => nav.go('invoice', { id: i.id, autoPrint: true })}><Icon name="printer" size={14} /> Print</button>
            {i.status === 'issued' && can('invoices.send') && <button className="btn btn--sm btn--outline" onClick={() => setSending(i)}>Send to customer</button>}
          </div>
        </div>
      ))}
      {!live && canIssue && total > 0 && balance === 0 && <AsyncButton className="btn btn--outline btn--sm" onClick={onIssue}>Issue invoice now</AsyncButton>}
      {sending && <SendModal title={`Send bill ${sending.number}`} intro="The customer receives a message with the bill details, and the invoice PDF is attached to the email." email={customer?.email} run={(channels) => api.post(`/api/invoices/${sending.id}/send`, { channels })} onClose={() => setSending(null)} onDone={onChange} />}
    </>
  )
}

const NSTATUS = { sent: 'status-confirmed', delivered: 'status-confirmed', failed: 'status-cancelled', skipped: 'event', queued: 'warn', retrying: 'warn', sending: 'warn' }
const MSG_LABEL = { booking_confirmation: 'Booking confirmation', booking_changed: 'Booking change notice', catering_confirmation: 'Order confirmation', bill_ready: 'Bill', thank_you: 'Thank-you' }
const CH_LABEL = { sms: 'SMS', whatsapp: 'WhatsApp', email: 'Email' }
export function Messages({ notifications, customer, onChange, thankYou }) {
  const [thanking, setThanking] = useState(false)
  const { can } = useApp()
  const toast = useToast()
  const [open, setOpen] = useState(null)
  const toggleConsent = async () => {
    try { await api.patch(`/api/customers/${customer.id}`, { messageConsent: !customer.messageConsent }); toast(customer.messageConsent ? 'Messaging consent withdrawn' : 'Messaging consent recorded'); onChange() } catch (e) { toast(errMsg(e), 'error') }
  }
  return (
    <>
      <div className="consent-row">
        <span>Customer messaging consent: <strong>{customer.messageConsent ? 'Yes' : 'No'}</strong>{customer.consentAt ? ` (${fmtDate(customer.consentAt.slice(0, 10))})` : ''}</span>
        {can('customers.edit') && <button className="btn btn--sm btn--outline" onClick={toggleConsent}>{customer.messageConsent ? 'Withdraw' : 'Record consent'}</button>}
      </div>
      {notifications.length === 0 && <p className="form-hint">No messages yet. The booking confirmation is sent automatically after a verified advance, the bill when it is paid in full, and a thank-you after the event.</p>}
      {notifications.map((n) => (
        <div className="msg" key={n.id}>
          <div className="msg__head" onClick={() => setOpen(open === n.id ? null : n.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpen(open === n.id ? null : n.id)}>
            <span>{MSG_LABEL[n.templateKey] || cap(n.type)} · {CH_LABEL[n.channel] || n.channel}</span>
            <span className={`tag tag--${NSTATUS[n.status] || 'event'}`}>{cap(n.status)}</span>
          </div>
          <div className="form-hint" style={{ margin: 0 }}>{fmtDateTime(n.createdAt)} · to {n.toEmail || n.toPhone}{n.invoiceId && n.channel === 'email' ? ' · invoice PDF attached' : ''}{n.attempts ? ` · ${n.attempts} attempt${n.attempts > 1 ? 's' : ''}` : ''}{n.skippedReason ? ` · ${n.skippedReason}` : ''}{n.lastError && ['failed', 'retrying'].includes(n.status) ? ` · ${n.lastError}` : ''}</div>
          {open === n.id && <pre className="msg__body">{n.subject ? `Subject: ${n.subject}\n\n` : ''}{n.body}</pre>}
          {n.status === 'failed' && can('notifications.retry') && (
            <AsyncButton className="btn btn--sm btn--outline" onClick={async () => { try { await api.post(`/api/notifications/${n.id}/retry`); toast('Retry queued'); onChange() } catch (e) { toast(errMsg(e), 'error') } }}>Retry sending</AsyncButton>
          )}
        </div>
      ))}
      {thankYou?.allowed && can('messages.send') && <button className="btn btn--sm btn--outline" onClick={() => setThanking(true)}>Send thank-you message</button>}
      {thanking && <SendModal title="Send thank-you message" intro="Sends the thank-you note again (it is also sent automatically after the event)." email={customer.email} run={(channels) => api.post(`/api/${thankYou.kind === 'booking' ? 'bookings' : 'catering'}/${thankYou.id}/thank-you`, { channels })} onClose={() => setThanking(false)} onDone={onChange} />}
    </>
  )
}

export { Confirm, Empty }
