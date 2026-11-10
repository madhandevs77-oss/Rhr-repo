import { useEffect, useState } from 'react'
import { api } from '../api'
import { Async, Empty, Icon } from '../components/common'
import { useApp, useLoad } from '../store'
import { cap, fmt, fmtDate, fmtTime, PAY_LABEL } from '../utils'

export const CSTATUS = ['draft', 'quotation_sent', 'awaiting_confirmation', 'confirmed', 'preparation', 'ready_for_dispatch', 'delivered', 'completed', 'exception', 'cancelled']
export const cTagClass = (s) => ({ cancelled: 'status-cancelled', exception: 'status-cancelled', completed: 'status-confirmed', delivered: 'status-confirmed', confirmed: 'status-confirmed' }[s] || 'warn')

export default function CateringList({ nav }) {
  const { options, can } = useApp()
  const [q, setQ] = useState('')
  const [term, setTerm] = useState('')
  const [status, setStatus] = useState('')
  const [opt, setOpt] = useState('')
  const [upcoming, setUpcoming] = useState(true)
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 300); return () => clearTimeout(t) }, [q])
  const today = new Date().toLocaleDateString('en-CA')
  const res = useLoad(() => api.get('/api/catering', { q: term, status, serviceOptionId: opt, from: upcoming && !term ? today : undefined }), [term, status, opt, upcoming])
  return (
    <>
      <div className="search-bar"><Icon name="search" size={20} /><input type="search" className="search-bar__input" placeholder="Search customer, phone, order no. or venue" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search catering orders" /></div>
      <div className="filter-row">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status"><option value="">All statuses</option>{CSTATUS.map((s) => <option key={s} value={s}>{cap(s)}</option>)}</select>
        <select value={opt} onChange={(e) => setOpt(e.target.value)} aria-label="Service option"><option value="">All services</option>{options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
        <label className="inline-check"><input type="checkbox" checked={upcoming} onChange={(e) => setUpcoming(e.target.checked)} /> Upcoming only</label>
      </div>
      <Async res={res} empty={(d) => (d.orders.length ? null : <Empty>{term || status || opt ? 'No orders match these filters.' : 'No orders yet. Tick dishes in the Menu tab, or use the New Order button.'}</Empty>)}>
        {({ orders }) => (
          <div className="bookings-list">
            {orders.map((o) => (
              <div className={`booking-card ${o.status === 'cancelled' ? 'booking-card--cancelled' : ''}`} key={o.id} role="button" tabIndex={0} onClick={() => nav.go('cDetail', { id: o.id })} onKeyDown={(e) => e.key === 'Enter' && nav.go('cDetail', { id: o.id })}>
                <div className="booking-card__avatar"><Icon name="truck" size={18} /></div>
                <div className="booking-card__info">
                  <div className="booking-card__name">{o.customer.name}</div>
                  <div className="booking-card__meta"><span>{o.reference}</span><span>{fmtDate(o.date)}</span>{o.deliveryTime && <span>{fmtTime(o.deliveryTime)}</span>}<span>{o.plates} plates</span></div>
                  <div className="booking-card__tags">
                    <span className="tag tag--event">{o.serviceOption.name}</span>
                    <span className={`tag tag--${cTagClass(o.status)}`}>{cap(o.status)}</span>
                    {o.money.state !== 'none' && <span className={`tag tag--pay-${o.money.state === 'overpaid' ? 'paid' : o.money.state}`}>{PAY_LABEL[o.money.state]}</span>}
                    {o.money.pending > 0 && <span className="tag tag--warn">Verify payment</span>}
                    {o.vendor && <span className="tag tag--muted">{o.vendor.vendorName}</span>}
                  </div>
                </div>
                <div className="booking-card__amt">{fmt(o.money.total)}</div>
              </div>
            ))}
          </div>
        )}
      </Async>
      {can('catering.create') && <button className="fab" onClick={() => nav.go('cForm')}><Icon name="plus" size={26} /><span>New Order</span></button>}
    </>
  )
}
