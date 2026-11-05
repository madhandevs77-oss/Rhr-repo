import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api'
import { Async, Modal } from './common'
import { useLoad } from '../store'

/** Kitchen sheet for the chef: hall, date, time, meals + category headings and item names. Anonymous: no customer, no amounts, no notes. */
export default function MenuPrint({ bookingId, onClose }) {
  useEffect(() => { document.body.classList.add('printing-menu'); return () => document.body.classList.remove('printing-menu') }, [])
  const res = useLoad(() => api.get(`/api/meal-menu/booking/${bookingId}`), [bookingId])
  const base = `/api/meal-menu/booking/${bookingId}/pdf`
  return (
    <Modal title="Kitchen sheet" onClose={onClose} footer={
      <>
        <button className="btn btn--secondary" onClick={onClose}>Close</button>
        <a className="btn btn--outline" href={`${base}?download=1`} download="kitchen-sheet.pdf" data-testid="menu-pdf">Download Kitchen Sheet PDF</a>
        <button className="btn btn--primary" onClick={() => window.print()} data-testid="menu-print">Print Kitchen Sheet</button>
      </>
    }>
      <Async res={res}>
        {(k) => (
          <>
            <MenuBody k={k} cls="menu-print" testid="menu-print-preview" />
            {/* print copy lives directly under <body> so modal overflow / transforms can never clip or repeat it */}
            {createPortal(<MenuBody k={k} cls="print-area menu-print menu-print--only" testid="menu-print-area" />, document.body)}
          </>
        )}
      </Async>
    </Modal>
  )
}

function MenuBody({ k, cls, testid }) {
  const { meals } = k
  const [y, mo, d] = String(k.date).split('-')
  return (
    <div className={cls} data-testid={testid}>
      <h1 className="menu-print__title">Kitchen Sheet</h1>
      <p className="menu-print__sub"><strong>{k.section}</strong> · {d}-{mo}-{y} · {k.startTime} – {k.endTime}</p>
      {k.serve.length > 0 && <p className="menu-print__sub">Serve: {k.serve.join(', ')}</p>}
      {meals.length === 0 && <p className="form-hint" style={{ textAlign: 'center' }}>No menu items selected.</p>}
      {meals.map((m) => (
        <section className="menu-print__meal" key={m.title}>
          <h2>{m.title}</h2>
          <ul>{m.items.map((n, i) => <li key={i}>{n}</li>)}</ul>
        </section>
      ))}
    </div>
  )
}
