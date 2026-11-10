import { useState } from 'react'
import { api } from '../api'
import { Async, Empty } from '../components/common'
import { useApp, useLoad } from '../store'
import { fmt } from '../utils'
import CateringList from './CateringList'

let lastView = 'menu' // remembered so coming back from an order lands on the Orders list again

/** Menu tab: tick dishes from the managed Catering Menu, then send them straight to a new catering order. */
export default function MenuPick({ nav }) {
  const [view, setViewState] = useState(lastView)
  const setView = (v) => { lastView = v; setViewState(v) }
  return (
    <>
      <div className="filters" role="tablist" aria-label="Menu or orders">
        <button role="tab" aria-selected={view === 'menu'} className={`filter-chip ${view === 'menu' ? 'active' : ''}`} onClick={() => setView('menu')}>Menu</button>
        <button role="tab" aria-selected={view === 'orders'} className={`filter-chip ${view === 'orders' ? 'active' : ''}`} onClick={() => setView('orders')} data-testid="orders-tab">Orders</button>
      </div>
      {view === 'menu' ? <MenuList nav={nav} /> : <CateringList nav={nav} />}
    </>
  )
}

function MenuList({ nav }) {
  const menu = useLoad(() => api.get('/api/meal-menu'), [])
  const prices = useLoad(() => api.get('/api/catering-prices'), [])
  const { picked, togglePicked, setPicked, clearPicked, can } = useApp()
  const canOrder = can('catering.create')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(() => new Set())
  const term = q.trim().toLowerCase()
  const flip = (id) => setOpen((cur) => { const n = new Set(cur); n.has(id) ? n.delete(id) : n.add(id); return n })
  return (
    <div className="section menu-pick">
      <div className="section__header"><h2 className="section__title">RHR Food Menu</h2></div>
      {canOrder && <p className="form-hint">Tick the dishes you want, then tap “Use in order” — they go straight into a new order, where you choose the service type (Full Catering Service or Bulk Food Supply Only).</p>}
      <input type="search" className="mealpick__search" placeholder="Search dishes…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search dishes" />
      <Async res={menu} empty={(d) => (d.categories.some((c) => c.items.length) ? null : <Empty>The menu is empty. Add dishes under More → Catering Menu.</Empty>)}>
        {({ categories }) => (
          <Async res={prices}>
            {({ prices: pm }) => (
              <div className="food-categories">
                {categories.map((c) => {
                  const list = c.items.filter((i) => !term || i.name.toLowerCase().includes(term))
                  if (!list.length) return null
                  const ids = list.map((i) => i.id)
                  const all = ids.every((id) => picked.includes(id))
                  const chosen = c.items.filter((i) => picked.includes(i.id)).length
                  const expanded = open.has(c.id) || !!term
                  return (
                    <div className="food-category" key={c.id} data-category={c.name}>
                      <div className="food-category__head">
                        <button type="button" className="mmcat__toggle" aria-expanded={expanded} onClick={() => flip(c.id)}><span aria-hidden>{expanded ? '▾' : '▸'}</span> <h3 className="food-category__title">{c.name}</h3> <small>{chosen ? `${chosen} selected` : `${c.items.length} ${c.items.length === 1 ? 'item' : 'items'}`}</small></button>
                        {canOrder && expanded && <button type="button" className="btn btn--text btn--sm" onClick={() => setPicked((p) => (all ? p.filter((x) => !ids.includes(x)) : [...new Set([...p, ...ids])]))} data-testid={`pick-all-${c.name}`}>{all ? 'Unselect all' : 'Select all'}</button>}
                      </div>
                      {expanded && (
                        <div className="food-category__items">
                          {list.map((i) => (
                            <label className={`food-item ${picked.includes(i.id) ? 'is-picked' : ''}`} key={i.id}>
                              {canOrder && <input type="checkbox" checked={picked.includes(i.id)} onChange={() => togglePicked(i.id)} aria-label={`Select ${i.name}`} />}
                              <span className="food-item__name">{i.name}</span>
                              {pm[i.id]?.unitPrice > 0 && <span className="food-item__price">{fmt(pm[i.id].unitPrice)}<small>/{pm[i.id].unit}</small></span>}
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </Async>
        )}
      </Async>
      {canOrder && picked.length > 0 && (
        <div className="pick-bar" role="region" aria-label="Selected menu items">
          <span><strong>{picked.length}</strong> selected</span>
          <button type="button" className="btn btn--text btn--sm" onClick={clearPicked}>Clear</button>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => nav.go('cForm')} data-testid="use-in-order">Use in order →</button>
        </div>
      )}
    </div>
  )
}
