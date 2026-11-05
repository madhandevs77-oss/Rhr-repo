import { useMemo, useState } from 'react'
import { api } from '../api'
import BookingCard from '../components/BookingCard'
import { Async, Empty, Icon, MonthSelector } from '../components/common'
import { useApp, useLoad } from '../store'
import { addMonth, currentYM, fmtDateLong, monthKey, monthLabel, pad, todayStr } from '../utils'

const FILTERS = [
  ['all', 'All'],
  ['confirmed', 'Confirmed'],
  ['pending', 'Payment Pending'],
  ['food-pending', 'Food Pending'],
  ['cancelled', 'Cancelled'],
]
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export default function Bookings({ nav, hallId: initialHall = '' }) {
  const { halls } = useApp()
  const [hallId, setHallId] = useState(initialHall)
  const sections = halls.filter((h) => h.active).sort((a, b) => (a.kind === 'outsource') - (b.kind === 'outsource') || (a.order || 999) - (b.order || 999) || a.name.localeCompare(b.name))
  const [ym, setYm] = useState(currentYM)
  const [view, setView] = useState('list')
  const [filter, setFilter] = useState('all')
  const [selected, setSelected] = useState(todayStr())
  const prefix = monthKey(ym.y, ym.m)
  const open = (id) => nav.go('detail', { id })

  const from = `${prefix}-01`
  const to = `${prefix}-${pad(new Date(ym.y, ym.m + 1, 0).getDate())}`
  const res = useLoad(() => api.get('/api/bookings', { from, to, hallId }), [from, hallId])

  const move = (d) => setYm((v) => addMonth(v, d))
  const goToday = () => {
    setYm(currentYM())
    setSelected(todayStr())
  }

  return (
    <>
      <div className="filters" role="group" aria-label="Section filter">
        <button className={`filter-chip ${hallId === '' ? 'active' : ''}`} onClick={() => setHallId('')}>All halls</button>
        {sections.map((h) => <button key={h.id} className={`filter-chip ${hallId === h.id ? 'active' : ''}`} onClick={() => setHallId(h.id)}>{h.name}</button>)}
      </div>
      <MonthSelector label={monthLabel(ym)} onPrev={() => move(-1)} onNext={() => move(1)} />
      <div className="view-toggle">
        <button className={`view-toggle__btn ${view === 'list' ? 'active' : ''}`} onClick={() => setView('list')}><Icon name="list" size={18} /> List</button>
        <button className={`view-toggle__btn ${view === 'calendar' ? 'active' : ''}`} onClick={() => setView('calendar')}><Icon name="cal" size={18} /> Calendar</button>
      </div>

      <Async res={res}>
        {({ bookings }) =>
          view === 'list' ? (
            <List bookings={bookings} filter={filter} setFilter={setFilter} open={open} />
          ) : (
            <Calendar ym={ym} bookings={bookings} selected={selected} setSelected={setSelected} goToday={goToday} open={open} />
          )
        }
      </Async>
    </>
  )
}

function List({ bookings, filter, setFilter, open }) {
  const filtered = useMemo(() => {
    let l = bookings
    if (filter === 'cancelled') l = l.filter((b) => b.status === 'cancelled')
    else {
      l = l.filter((b) => b.status !== 'cancelled')
      if (filter === 'confirmed') l = l.filter((b) => b.status === 'confirmed')
      if (filter === 'pending') l = l.filter((b) => b.money.balance > 0)
      if (filter === 'food-pending') l = l.filter((b) => b.foodStatus !== 'confirmed')
    }
    return l
  }, [bookings, filter])
  const grouped = filtered.reduce((acc, b) => {
    ;(acc[b.date] = acc[b.date] || []).push(b)
    return acc
  }, {})
  return (
    <>
      <div className="filters">
        {FILTERS.map(([k, l]) => (
          <button key={k} className={`filter-chip ${filter === k ? 'active' : ''}`} onClick={() => setFilter(k)}>{l}</button>
        ))}
      </div>
      {filtered.length === 0 ? (
        <Empty>No bookings for this month</Empty>
      ) : (
        Object.entries(grouped).map(([date, items]) => (
          <div className="date-group" key={date}>
            <div className="date-group__header">{fmtDateLong(date)}</div>
            <div className="bookings-list">{items.map((b) => <BookingCard key={b.id} b={b} onOpen={open} />)}</div>
          </div>
        ))
      )}
    </>
  )
}

function Calendar({ ym, bookings, selected, setSelected, goToday, open }) {
  const { y, m } = ym
  const dim = new Date(y, m + 1, 0).getDate()
  const first = new Date(y, m, 1).getDay()
  const prevDim = new Date(y, m, 0).getDate()
  const tail = (7 - ((first + dim) % 7)) % 7
  const today = todayStr()
  const prefix = monthKey(y, m)
  const active = bookings.filter((b) => b.status !== 'cancelled')
  const dayBookings = active.filter((b) => b.date === selected)

  const cells = []
  for (let i = first - 1; i >= 0; i--) cells.push(<div key={'p' + i} className="cal-day cal-day--other">{prevDim - i}</div>)
  for (let d = 1; d <= dim; d++) {
    const ds = `${prefix}-${pad(d)}`
    const n = active.filter((b) => b.date === ds).length
    const cls = ['cal-day', ds === today && 'cal-day--today', ds === selected && 'cal-day--selected'].filter(Boolean).join(' ')
    cells.push(
      <div key={ds} className={cls} onClick={() => setSelected(ds)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setSelected(ds)}>
        <span>{d}</span>
        <div className="cal-dot-row">
          {n > 0 && <span className={`cal-dot ${n > 1 ? 'cal-dot--busy' : ''}`} />}
          {n > 1 && <span className="cal-dot cal-dot--busy" />}
        </div>
      </div>,
    )
  }
  for (let i = 1; i <= tail; i++) cells.push(<div key={'t' + i} className="cal-day cal-day--other">{i}</div>)

  return (
    <>
      <div className="cal-card">
        <div className="cal-head">
          <span className="cal-head__title">{monthLabel(ym)}</span>
          <button className="cal-today-btn" onClick={goToday}>Today</button>
        </div>
        <div className="cal-grid">
          {DOW.map((d) => <div key={d} className="cal-dow">{d}</div>)}
          {cells}
        </div>
        <div className="cal-legend">
          <span><i style={{ background: 'var(--accent)' }} />Booked</span>
          <span><i style={{ background: 'var(--warning)' }} />Multi-event</span>
          <span><i style={{ border: '1.5px solid var(--accent)', background: 'transparent' }} />Today</span>
        </div>
      </div>
      <div className="cal-panel">
        <div className="cal-panel__head">
          <span className="cal-panel__date">{fmtDateLong(selected)}</span>
          <span className="cal-panel__count">{dayBookings.length ? `${dayBookings.length} booking${dayBookings.length > 1 ? 's' : ''}` : 'Free'}</span>
        </div>
        <div className="bookings-list">
          {dayBookings.length ? dayBookings.map((b) => <BookingCard key={b.id} b={b} onOpen={open} />) : <Empty>No bookings on this day</Empty>}
        </div>
      </div>
    </>
  )
}
