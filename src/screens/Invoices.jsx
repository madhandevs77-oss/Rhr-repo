import { useEffect, useRef, useState } from 'react'
import { api, errMsg } from '../api'
import { Async, Empty, Icon, Spinner, useToast } from '../components/common'
import { ReasonModal, SendModal } from '../components/DocParts'
import { useApp, useLoad } from '../store'
import { cap, fmt, fmtDate, fmtDateTime } from '../utils'

export function Invoices({ nav }) {
  const [q, setQ] = useState('')
  const [term, setTerm] = useState('')
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 300); return () => clearTimeout(t) }, [q])
  const res = useLoad(() => api.get('/api/invoices', { q: term }), [term])
  return (
    <>
      <div className="search-bar"><Icon name="search" size={20} /><input type="search" className="search-bar__input" placeholder="Search invoice no., customer or booking ref" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search invoices" /></div>
      <Async res={res} empty={(d) => (d.invoices.length ? null : <Empty>{term ? 'No matching invoices' : 'No invoices yet. A final invoice is created automatically when a booking or order is fully paid (verified).'}</Empty>)}>
        {({ invoices }) => (
          <div className="bookings-list">
            {invoices.map((i) => (
              <div className="booking-card" key={i.id} role="button" tabIndex={0} onClick={() => nav.go('invoice', { id: i.id })} onKeyDown={(e) => e.key === 'Enter' && nav.go('invoice', { id: i.id })}>
                <div className="booking-card__avatar"><Icon name="file" size={18} /></div>
                <div className="booking-card__info">
                  <div className="booking-card__name">{i.number}</div>
                  <div className="booking-card__meta"><span>{i.customer}</span><span>{i.reference}</span><span>{fmtDate(i.issuedAt.slice(0, 10))}</span></div>
                  <div className="booking-card__tags"><span className="tag tag--event">{fmt(i.total)}</span><span className="tag tag--muted">{i.kind === 'catering' ? 'Catering' : 'Hall'}</span><span className={`tag tag--${i.status === 'issued' ? 'status-confirmed' : 'status-cancelled'}`}>{i.status === 'issued' ? 'Current' : cap(i.status)}</span></div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Async>
    </>
  )
}

export function InvoiceView({ nav, id, autoPrint }) {
  const res = useLoad(() => api.get(`/api/invoices/${id}`), [id])
  return <Async res={res}>{(d) => <Viewer nav={nav} d={d} autoPrint={autoPrint} reload={res.reload} />}</Async>
}

function Viewer({ nav, d, autoPrint, reload }) {
  const { can } = useApp()
  const toast = useToast()
  const [voiding, setVoiding] = useState(false)
  const [sending, setSending] = useState(false)
  const [note, setNote] = useState('')
  const done = useRef(false)
  const inv = d.invoice

  const print = () => {
    setNote('')
    try {
      if (typeof window.print !== 'function') throw new Error('unsupported')
      window.print() // user cancelling the dialog simply returns; nothing to undo
    } catch {
      setNote('Printing is not available in this browser. Use “Download PDF” and print the file instead.')
    }
  }
  useEffect(() => {
    if (autoPrint && !done.current) { done.current = true; const t = setTimeout(print, 400); return () => clearTimeout(t) }
    return undefined
  }, [autoPrint])  

  return (
    <>
      <div className="inv-toolbar no-print">
        <button className="btn btn--primary" onClick={print} data-testid="print-btn"><Icon name="printer" size={16} /> Print</button>
        <a className="btn btn--outline" href={`/api/invoices/${inv.id}/pdf?download=1`} target="_blank" rel="noreferrer">Download PDF</a>
        <a className="btn btn--outline" href={`/api/invoices/${inv.id}/pdf`} target="_blank" rel="noreferrer">Open PDF</a>
        {inv.status === 'issued' && can('invoices.send') && <button className="btn btn--outline" onClick={() => setSending(true)} data-testid="send-bill">Send to customer</button>}
        {inv.status === 'issued' && can('invoices.void') && <button className="btn btn--text danger" onClick={() => setVoiding(true)}>Void</button>}
      </div>
      {note && <div className="form-error no-print" role="alert">{note}</div>}
      {inv.status !== 'issued' && (
        <div className="inv-banner no-print" role="status">
          This invoice is <strong>{inv.status === 'superseded' ? 'superseded' : cap(inv.status)}</strong>{inv.statusReason ? ` (${inv.statusReason})` : ''}. It is kept for the record.
          {inv.supersededBy && <> <button className="btn btn--text btn--sm" onClick={() => nav.replace('invoice', { id: inv.supersededBy })}>View the current invoice →</button></>}
        </div>
      )}
      <InvoiceDocument snap={d.snapshot} status={inv.status} />
      <p className="form-hint no-print" style={{ textAlign: 'center' }}>Printed copies always show the invoice exactly as issued on {fmtDateTime(inv.issuedAt)}.</p>
      {sending && <SendModal title={`Send bill ${inv.number}`} intro="The customer receives a message with the bill details, and the invoice PDF is attached to the email." email={d.snapshot.customer.email} run={(channels) => api.post(`/api/invoices/${inv.id}/send`, { channels })} onClose={() => setSending(false)} />}
      {voiding && <ReasonModal title="Void invoice (admin)" label="Reason" confirm="Void invoice" danger onClose={() => setVoiding(false)} onSubmit={async (reason) => { try { await api.post(`/api/invoices/${inv.id}/void`, { reason }); toast('Invoice voided', 'warning'); reload() } catch (e) { toast(errMsg(e), 'error') } }} />}
    </>
  )
}

/** The frozen invoice, laid out for A4. Only this block is visible when printing (see @media print in styles.css). */
export function InvoiceDocument({ snap, status = 'issued' }) {
  const s = snap
  const billName = s.customer.billingName || s.customer.name
  return (
    <article className="print-area invoice" aria-label={`Invoice ${s.number}`}>
      {status !== 'issued' && <div className="invoice__watermark">{status === 'superseded' ? 'SUPERSEDED' : status.toUpperCase()}</div>}
      <header className="invoice__head">
        <div>
          <h1>{s.seller.name}</h1>
          {s.seller.legalName && <div>{s.seller.legalName}</div>}
          <div className="pre">{s.seller.address}</div>
          {s.seller.phone && <div>Phone: {s.seller.phone}</div>}
          {s.seller.email && <div>{s.seller.email}</div>}
          {s.seller.taxId && <div>GSTIN / Tax ID: {s.seller.taxId}</div>}
        </div>
        <div className="invoice__meta">
          <h2>{s.kind === 'quotation' ? 'QUOTATION' : 'TAX INVOICE'}</h2>
          <div><span>No.</span><strong>{s.number}</strong></div>
          <div><span>Date</span><strong>{fmtDate(s.issueDate.slice(0, 10))}</strong></div>
          <div><span>Ref.</span><strong>{s.reference}</strong></div>
        </div>
      </header>
      <section className="invoice__parties">
        <div><h3>Billed to</h3><strong>{billName}</strong>{s.customer.billingName && s.customer.billingName !== s.customer.name && <div>{s.customer.name}</div>}<div className="pre">{s.customer.billingAddress || s.customer.address}</div><div>Phone: {s.customer.phone}</div>{s.customer.billingTaxId && <div>GSTIN: {s.customer.billingTaxId}</div>}</div>
        <div><h3>Event</h3>{(s.event?.lines || []).map((l, i) => <div key={i}>{l}</div>)}</div>
      </section>
      <table className="invoice__lines">
        <thead><tr><th>Description</th><th className="r">Qty</th><th className="r">Rate</th><th className="r">Amount</th></tr></thead>
        <tbody>
          {s.lines.map((l, i) => (
            <tr key={i}><td>{l.description}</td><td className="r">{l.quantity}{l.unit ? ` ${l.unit}` : ''}</td><td className="r">{fmt(l.unit_price)}</td><td className="r">{fmt(l.amount)}</td></tr>
          ))}
        </tbody>
      </table>
      <div className="invoice__totals">
        <div><span>Subtotal</span><span>{fmt(s.totals.subtotal)}</span></div>
        {s.totals.discount > 0 && <div><span>Discount</span><span>− {fmt(s.totals.discount)}</span></div>}
        {s.totals.tax > 0 && <div><span>{s.totals.taxLabel} @ {s.totals.taxRate}%</span><span>{fmt(s.totals.tax)}</span></div>}
        <div className="grand"><span>Total</span><span>{fmt(s.totals.total)}</span></div>
        {s.kind !== 'quotation' && <>
          <div><span>Paid</span><span>{fmt(s.paidTotal)}</span></div>
          <div className="grand"><span>Balance</span><span>{fmt(s.balance)}</span></div>
          <div className={`invoice__status ${s.balance === 0 ? 'ok' : ''}`}>{s.status}</div>
        </>}
      </div>
      {s.payments?.length > 0 && (
        <section className="invoice__pay">
          <h3>Payments received</h3>
          <table><thead><tr><th>Date</th><th>Method</th><th>Reference</th><th className="r">Amount</th></tr></thead>
            <tbody>{s.payments.map((p) => <tr key={p.id}><td>{fmtDate(p.date)}</td><td>{p.method}{p.kind === 'refund' ? ' (refund)' : ''}</td><td>{p.reference || '—'}</td><td className="r">{p.kind === 'refund' ? '− ' : ''}{fmt(p.amount)}</td></tr>)}</tbody></table>
        </section>
      )}
      {s.seller.bankDetails && <section className="invoice__bank"><h3>Bank details</h3><div className="pre">{s.seller.bankDetails}</div></section>}
      {s.seller.terms && <section className="invoice__terms"><h3>Terms</h3><div className="pre">{s.seller.terms}</div></section>}
      <footer className="invoice__foot">{s.seller.footer || 'Thank you for choosing us.'}</footer>
    </article>
  )
}

export { Spinner }
