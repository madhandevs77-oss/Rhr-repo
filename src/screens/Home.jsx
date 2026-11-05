import { useEffect, useState } from 'react'
import { api, errMsg } from '../api'
import BookingCard from '../components/BookingCard'
import HallGallery from '../components/HallGallery'
import { Async, Confirm, Empty, Icon, useToast } from '../components/common'
import { useApp, useLoad } from '../store'
import { currentYM, fmt, fmtDateTime, monthKey, pad, todayStr } from '../utils'

export default function Home({ nav }) {
  const { can } = useApp()
  const [gallery, setGallery] = useState(null)
  const [q, setQ] = useState('')
  const [term, setTerm] = useState('')
  const today = todayStr()
  const { y, m } = currentYM()
  const from = `${monthKey(y, m)}-01`
  const to = `${monthKey(y, m)}-${pad(new Date(y, m + 1, 0).getDate())}`

  const secs = useLoad(() => api.get('/api/sections'), [])
  const month = useLoad(() => api.get('/api/bookings', { from, to }), [from])
  const catering = useLoad(() => (can('catering.view') ? api.get('/api/catering', { from: today, to: today }) : Promise.resolve({ orders: [] })), [today])
  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 300)
    return () => clearTimeout(t)
  }, [q])
  const search = useLoad(() => (term ? api.get('/api/bookings', { q: term }) : Promise.resolve(null)), [term])
  const open = (id) => nav.go('detail', { id })

  return (
    <>
      <div className="search-bar">
        <Icon name="search" size={20} />
        <input type="search" className="search-bar__input" placeholder="Search customer name, phone or booking ID..." value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" aria-label="Search bookings" />
      </div>

      {term ? (
        <div className="section">
          <Async res={search}>
            {(d) => (
              <>
                <div className="section__header"><h2 className="section__title">Search results ({d.bookings.length})</h2></div>
                <div className="bookings-list">{d.bookings.length ? d.bookings.map((b) => <BookingCard key={b.id} b={b} onOpen={open} />) : <Empty>No matching bookings</Empty>}</div>
              </>
            )}
          </Async>
        </div>
      ) : (
        <>
          <Async res={month}>
            {({ bookings }) => {
              const active = bookings.filter((b) => b.status !== 'cancelled')
              const todays = active.filter((b) => b.date === today)
              const collected = active.reduce((s, b) => s + b.money.paid, 0)
              const pending = active.reduce((s, b) => s + Math.max(0, b.money.balance), 0)
              const verify = active.reduce((s, b) => s + b.money.pending, 0)
              return (
                <>
                  <div className="dashboard-stats">
                    <Stat cls="primary" v={todays.length} l="Today" />
                    <Stat cls="accent" v={active.length} l="This Month" />
                    <Stat cls="success" v={fmt(collected)} l="Collected (verified)" />
                    <Stat cls="warning" v={fmt(pending)} l="Balance due" />
                    <Stat cls="info" v={active.filter((b) => b.foodStatus !== 'confirmed').length} l="Food Pending" />
                    <Stat cls="dark" v={fmt(verify)} l="To verify" />
                  </div>
                  <Drafts nav={nav} />
                  <Sections res={secs} nav={nav} setGallery={setGallery} />
                  <div className="section">
                    <div className="section__header">
                      <h2 className="section__title">Today's Bookings</h2>
                      <button className="btn btn--text btn--sm" onClick={() => nav.tab('bookings')}>View All</button>
                    </div>
                    <div className="bookings-list">{todays.length ? todays.map((b) => <BookingCard key={b.id} b={b} onOpen={open} />) : <Empty>No hall bookings for today</Empty>}</div>
                  </div>
                </>
              )
            }}
          </Async>
          {catering.data?.orders.length > 0 && (
            <div className="section">
              <div className="section__header"><h2 className="section__title">Catering due today</h2></div>
              <div className="bookings-list">
                {catering.data.orders.filter((o) => o.status !== 'cancelled').map((o) => (
                  <div key={o.id} className="booking-card" role="button" tabIndex={0} onClick={() => nav.go('cDetail', { id: o.id })} onKeyDown={(e) => e.key === 'Enter' && nav.go('cDetail', { id: o.id })}>
                    <div className="booking-card__avatar"><Icon name="truck" size={18} /></div>
                    <div className="booking-card__info">
                      <div className="booking-card__name">{o.customer.name}</div>
                      <div className="booking-card__meta"><span>{o.reference}</span><span>{o.plates} plates</span><span>{o.deliveryTime || 'time not set'}</span></div>
                      <div className="booking-card__tags"><span className="tag tag--event">{o.serviceOption.name}</span><span className="tag tag--status-confirmed">{o.status.replace(/_/g, ' ')}</span></div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {gallery && <HallGallery hall={gallery.hall} start={gallery.start} onClose={() => setGallery(null)} />}
      <button className="fab" onClick={() => nav.go('form')}>
        <Icon name="plus" size={26} />
        <span>New Booking</span>
      </button>
    </>
  )
}

function Drafts({ nav }) {
  const res = useLoad(() => api.get('/api/drafts'), [])
  const toast = useToast()
  const [del, setDel] = useState(null)
  const drafts = res.data?.drafts || []
  if (!drafts.length) return null
  return (
    <div className="section" data-testid="drafts-section">
      <div className="section__header"><h2 className="section__title">Draft Bookings <small>({drafts.length})</small></h2></div>
      <div className="drafts">
        {drafts.map((d) => (
          <div className="draft-card" key={d.id} data-testid="draft-card">
            <div className="draft-card__main">
              <div className="draft-card__title">{d.title}</div>
              <div className="draft-card__meta">{d.customerName || 'No customer entered yet'}</div>
              <div className="draft-card__tags">
                <span className="tag tag--event">{d.category}</span>
                <span className="tag tag--status-tentative">Draft · not submitted</span>
                <span className="draft-card__time">Saved {fmtDateTime(d.updatedAt)}</span>
              </div>
            </div>
            <div className="draft-card__actions">
              <button className="btn btn--primary btn--sm" onClick={() => nav.go(d.kind === 'catering' ? 'cForm' : 'form', { draftId: d.id })} data-testid="draft-continue">Continue</button>
              <button className="btn btn--outline btn--sm danger" onClick={() => setDel(d)} data-testid="draft-delete">Delete</button>
            </div>
          </div>
        ))}
      </div>
      {del && <Confirm title="Delete this draft?" message={`The saved ${del.category.toLowerCase()} draft${del.customerName ? ` for ${del.customerName}` : ''} will be removed permanently. Confirmed bookings and other drafts are not affected.`} confirmLabel="Delete draft" danger onClose={() => setDel(null)}
        onConfirm={async () => { try { await api.del(`/api/drafts/${del.id}`); toast('Draft deleted'); res.reload() } catch (e) { toast(errMsg(e), 'error') } }} />}
    </div>
  )
}

function Sections({ res, nav, setGallery }) {
  return (
    <Async res={res}>
      {({ sections }) => (
        <>
          <SectionGroup title="Halls" testid="halls-section" sections={sections.filter((s) => s.kind !== 'outsource' && s.active)} nav={nav} calendarLink photos setGallery={setGallery} />
          <SectionGroup title="Outsource Bookings" testid="outsource-section" sections={sections.filter((s) => s.kind === 'outsource')} nav={nav} />
        </>
      )}
    </Async>
  )
}

function SectionGroup({ title, testid, sections, nav, calendarLink, photos, setGallery }) {
  const { halls, can } = useApp()
  const hallOf = (id) => halls.find((h) => h.id === id)
  return (
    <div className="section" data-testid={testid}>
      <div className="section__header">
        <h2 className="section__title">{title}</h2>
        <span>
          {calendarLink && can('halls.manage') && <button className="btn btn--text btn--sm" onClick={() => nav.go('halls')}>Manage halls</button>}
          {calendarLink && <button className="btn btn--text btn--sm" onClick={() => nav.tab('calendar')}>Calendar</button>}
        </span>
      </div>
      <div className={`sec-grid ${photos ? 'sec-grid--halls' : ''}`}>
        {sections.map((s) => (
          <div className={`sec-card ${photos ? 'sec-card--hall' : ''} ${s.todayStatus === 'booked' ? 'is-booked' : ''}`} key={s.id} data-testid={`section-${s.name}`}>
            {photos && (() => {
              const h = hallOf(s.id)
              return h?.coverUrl ? (
                <div className="sec-card__photowrap">
                  <button type="button" className="sec-card__photo" onClick={() => setGallery({ hall: h, start: 0 })} aria-label={`View photos of ${s.name}`}>
                    <img src={h.coverUrl} alt={s.name} loading="lazy" />
                    {h.images.length > 1 && <span className="sec-card__photocount">📷 {h.images.length}</span>}
                  </button>
                  {can('halls.manage') && <button type="button" className="sec-card__change" onClick={() => nav.go('halls', { hallId: s.id, tab: 'photos' })}>Change photo</button>}
                </div>
              ) : (
                <div className="sec-card__photo sec-card__photo--empty"><Icon name="home" size={34} />{can('halls.manage') && <button type="button" className="btn btn--outline btn--sm" onClick={() => nav.go('halls', { hallId: s.id, tab: 'photos' })}>Add photo</button>}</div>
              )
            })()}
            <div className="sec-card__head">
              <h3>{s.name}</h3>
              <span className={`sec-card__status ${s.todayStatus}`}>{s.todayStatus === 'booked' ? `Booked today (${s.today.length})` : 'Free today'}</span>
            </div>
            <div className="sec-card__body">
              {s.today.map((b) => <div key={b.id} className="sec-card__line">{b.startTime}–{b.endTime} · {b.customer}</div>)}
              <div className="sec-card__line sec-card__line--mute">{s.upcomingCount ? `${s.upcomingCount} upcoming` : 'No upcoming bookings'}{s.next ? ` · next ${s.next.date}` : ''}</div>
            </div>
            <div className="sec-card__actions">
              <button className="btn btn--primary btn--sm" onClick={() => nav.go('form', { hallId: s.id })}>New Booking</button>
              <button className="btn btn--outline btn--sm" onClick={() => nav.go('secHistory', { hallId: s.id })}>History</button>
              <button className="btn btn--outline btn--sm" onClick={() => nav.go('calendarSec', { hallId: s.id })}>Calendar</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

const Stat = ({ cls, v, l }) => (
  <div className={`stat-card stat-card--${cls}`}>
    <span className="stat-card__value">{v}</span>
    <span className="stat-card__label">{l}</span>
  </div>
)
