import { useState } from 'react'
import { api } from '../api'
import { Async, Empty, MonthSelector } from '../components/common'
import { useApp, useLoad } from '../store'
import { addMonth, currentYM, fmt, fmtDateLong, fmtTime, monthKey, monthLabel, pad, todayStr } from '../utils'

const h2 = (h) => (h.kind === 'outsource' ? 1 : 0)
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export default function Calendar({ nav, hallId: initialHall }) {
  const { halls } = useApp()
  const [ym, setYm] = useState(currentYM)
  const [hallId, setHallId] = useState(initialHall || '')
  const [group, setGroup] = useState('')
  const [selected, setSelected] = useState(todayStr())
  const sections = halls.filter((h) => h.active).sort((a, b) => (h2(a) - h2(b)) || (a.order || 999) - (b.order || 999) || a.name.localeCompare(b.name))
  const prefix = monthKey(ym.y, ym.m)
  const month = useLoad(() => api.get('/api/calendar', { month: prefix, hallId, group }), [prefix, hallId, group])
  const day = useLoad(() => api.get('/api/calendar/day', { date: selected, hallId, group }), [selected, hallId, group, month.data])

  const { y, m } = ym
  const dim = new Date(y, m + 1, 0).getDate()
  const first = new Date(y, m, 1).getDay()
  const prevDim = new Date(y, m, 0).getDate()
  const tail = (7 - ((first + dim) % 7)) % 7
  const today = todayStr()
  const days = month.data?.days || {}
  const cells = []
  for (let i = first - 1; i >= 0; i--) cells.push(<div key={'p' + i} className="cal-day cal-day--other">{prevDim - i}</div>)
  for (let d = 1; d <= dim; d++) {
    const ds = `${prefix}-${pad(d)}`
    const n = days[ds] || 0
    const cls = ['cal-day', ds === today && 'cal-day--today', ds === selected && 'cal-day--selected'].filter(Boolean).join(' ')
    cells.push(
      <div key={ds} className={cls} onClick={() => setSelected(ds)} role="button" tabIndex={0} aria-label={`${ds}${n ? `, ${n} booking${n > 1 ? 's' : ''}` : ''}`} data-date={ds} data-count={n} onKeyDown={(e) => e.key === 'Enter' && setSelected(ds)}>
        <span>{d}</span>
        <div className="cal-dot-row">{n > 0 && <span className="cal-dot" data-testid="cal-dot" />}</div>
      </div>,
    )
  }
  for (let i = 1; i <= tail; i++) cells.push(<div key={'t' + i} className="cal-day cal-day--other">{i}</div>)

  return (
    <>
      <div className="filters" role="group" aria-label="Section filter">
        <button className={`filter-chip ${!hallId && !group ? 'active' : ''}`} onClick={() => { setHallId(''); setGroup('') }}>All</button>
        <button className={`filter-chip ${group === 'halls' ? 'active' : ''}`} onClick={() => { setHallId(''); setGroup('halls') }}>Halls</button>
        <button className={`filter-chip ${group === 'outsource' ? 'active' : ''}`} onClick={() => { setHallId(''); setGroup('outsource') }}>Outsource Bookings</button>
        {sections.map((h) => <button key={h.id} className={`filter-chip ${hallId === h.id ? 'active' : ''}`} onClick={() => { setGroup(''); setHallId(h.id) }}>{h.name}</button>)}
      </div>
      <MonthSelector label={monthLabel(ym)} onPrev={() => setYm((v) => addMonth(v, -1))} onNext={() => setYm((v) => addMonth(v, 1))} />
      <div className="cal-card">
        <div className="cal-head">
          <span className="cal-head__title">{monthLabel(ym)}</span>
          <button className="cal-today-btn" onClick={() => { setYm(currentYM()); setSelected(todayStr()) }}>Today</button>
        </div>
        <div className="cal-grid">{DOW.map((d) => <div key={d} className="cal-dow">{d}</div>)}{cells}</div>
        <div className="cal-legend"><span><i style={{ background: 'var(--accent)' }} />Has booking(s)</span><span><i style={{ border: '1.5px solid var(--accent)', background: 'transparent' }} />Today</span></div>
      </div>
      <div className="cal-panel">
        <div className="cal-panel__head">
          <span className="cal-panel__date">{fmtDateLong(selected)}</span>
          <span className="cal-panel__count">{day.data ? (day.data.total ? `${day.data.total} booking${day.data.total > 1 ? 's' : ''}` : 'Free') : ''}</span>
        </div>
        <Async res={day}>
          {(d) => (
            <>
              {d.sections.filter((s) => s.bookings.length || !hallId).map((s) => (
                <div className="cal-sec" key={s.id || s.name}>
                  <div className="cal-sec__title">{s.name}<span>{s.bookings.length || 'free'}</span></div>
                  {s.bookings.map((b) => (
                    <button className={`cal-bk ${b.status === 'cancelled' ? 'is-cancelled' : ''}`} key={b.id} onClick={() => nav.go('detail', { id: b.id })}>
                      <span className="cal-bk__time">{fmtTime(b.startTime)}–{fmtTime(b.endTime)}</span>
                      <span className="cal-bk__main"><strong>{b.customer}</strong> · {b.phone}</span>
                      <span className="cal-bk__meta"><em className={`tag tag--status-${b.status}`}>{b.status}</em></span>
                      {d.financial && <span className="cal-bk__meta">Total {fmt(b.total)} · Balance {fmt(Math.max(0, b.balance))}</span>}
                      {b.notes && <span className="cal-bk__note">📝 {b.notes}</span>}
                    </button>
                  ))}
                </div>
              ))}
              {d.total === 0 && <Empty>No bookings on this day</Empty>}
            </>
          )}
        </Async>
      </div>
    </>
  )
}
