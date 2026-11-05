import { useMemo, useState } from 'react'
import { api, errMsg } from '../api'
import { Async, Confirm, Empty, Field, Icon, KebabMenu, Modal, useToast } from '../components/common'
import { useApp, useLoad } from '../store'

export const SERVICES = [['breakfast', 'Breakfast'], ['lunch', 'Lunch'], ['dinner', 'Dinner']]

/** Category sections with checkbox food items. Names only — there is no price anywhere in this component or its data. */
export function MenuPicker({ categories, selected, setSelected }) {
  const [q, setQ] = useState('')
  const term = q.trim().toLowerCase()
  const toggleItem = (it, cat) => setSelected((cur) => {
    const n = new Map(cur)
    n.has(it.id) ? n.delete(it.id) : n.set(it.id, { id: it.id, name: it.name, category: cat.name })
    return n
  })
  // tick / untick every (visible) item of one category
  const toggleAll = (cat, list, on) => setSelected((cur) => {
    const n = new Map(cur)
    for (const it of list) on ? n.set(it.id, { id: it.id, name: it.name, category: cat.name }) : n.delete(it.id)
    return n
  })
  // categories a saved booking used that have since been deleted still show their kept items
  const orphans = useMemo(() => {
    const known = new Set(categories.flatMap((c) => c.items.map((i) => i.id)))
    const by = new Map()
    for (const x of selected.values()) if (!known.has(x.id)) by.set(x.category || 'Other', [...(by.get(x.category || 'Other') || []), x])
    return [...by.entries()].map(([name, items]) => ({ id: `orphan-${name}`, name, items, orphan: true }))
  }, [categories, selected])
  const all = [...categories, ...orphans]
  return (
    <div className="mealpick">
      <input type="search" className="mealpick__search" placeholder="Search food items…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search food items" />
      {all.length === 0 && <p className="form-hint">No menu categories yet. Add them under Menu Management.</p>}
      {all.map((c) => {
        const list = c.items.filter((i) => !term || i.name.toLowerCase().includes(term))
        const chosen = c.items.filter((i) => selected.has(i.id)).length
        return (
          <div className="food-list__category" key={c.id} data-category={c.name}>
            <div className="food-list__category-title">{c.name} <small>{chosen} selected</small></div>
            {!c.orphan && list.length > 0 && (() => {
              const on = list.filter((i) => selected.has(i.id)).length
              return (
                <label className="food-list__item food-list__selectall">
                  <input type="checkbox" checked={on === list.length} ref={(el) => { if (el) el.indeterminate = on > 0 && on < list.length }} onChange={(e) => toggleAll(c, list, e.target.checked)} aria-label={`Select all in ${c.name}`} data-testid={`all-${c.name}`} />
                  <span className="food-list__item-name">Select all</span>
                </label>
              )
            })()}
            <div className="food-list__items">
              {list.map((i) => (
                <label className="food-list__item" key={i.id}>
                  <input type="checkbox" checked={selected.has(i.id)} onChange={() => toggleItem(i, c)} />
                  <span className="food-list__item-name">{i.name}</span>
                </label>
              ))}
              {list.length === 0 && <p className="form-hint">No matching items</p>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** Menu Management page: categories and items — create, rename, reorder, deactivate, delete. */
export default function MenuManage({ nav }) {
  const { can } = useApp()
  const res = useLoad(() => api.get('/api/meal-menu', { all: 1 }), [])
  const [edit, setEdit] = useState(null) // {type:'category'|'item', ...}
  const [del, setDel] = useState(null)
  const [open, setOpen] = useState(() => new Set())
  const flip = (id) => setOpen((cur) => { const n = new Set(cur); n.has(id) ? n.delete(id) : n.add(id); return n })
  const toast = useToast()
  const act = async (fn, msg) => { try { await fn(); if (msg) toast(msg); res.reload() } catch (e) { toast(errMsg(e), 'error') } }
  const move = (list, idx, dir, url) => {
    const ids = list.map((x) => x.id)
    const j = idx + dir
    if (j < 0 || j >= ids.length) return
    ;[ids[idx], ids[j]] = [ids[j], ids[idx]]
    return act(() => api.put(url, { ids }))
  }
  return (
    <Async res={res}>
      {({ categories }) => (
        <>
          <div className="mealmgmt__bar">
            <span className="form-hint" style={{ alignSelf: 'center', flex: 1 }}>Food names only. Prices are set under More → Catering Prices.</span>
            <button className="btn btn--primary btn--sm" onClick={() => setEdit({ type: 'category', name: '' })} data-testid="add-category"><Icon name="plus" size={16} /> Add category</button>
          </div>
          {nav && can('catering.create') && <button className="btn btn--text btn--sm" onClick={() => nav.go('cForm')} data-testid="menu-new-order">Start a new catering order →</button>}
          {categories.length === 0 && <Empty>No categories yet</Empty>}
          {categories.map((c, ci) => (
            <section className={`mmcat ${c.active ? '' : 'is-off'}`} key={c.id} data-testid={`cat-${c.name}`}>
              <header className="mmcat__head">
                <button className="mmcat__toggle" aria-expanded={open.has(c.id)} onClick={() => flip(c.id)}><span aria-hidden>{open.has(c.id) ? '▾' : '▸'}</span> <h3>{c.name}{!c.active && <em> · inactive</em>}</h3> <small>{c.items.length} {c.items.length === 1 ? 'item' : 'items'}</small></button>
                <KebabMenu label={`Actions for ${c.name}`} items={[
                  { label: 'Rename', onClick: () => setEdit({ type: 'category', id: c.id, name: c.name, active: c.active }) },
                  { label: c.active ? 'Deactivate' : 'Activate', onClick: () => act(() => api.put(`/api/meal-menu/categories/${c.id}`, { name: c.name, active: !c.active }), c.active ? 'Category deactivated' : 'Category activated') },
                  { label: 'Move up', disabled: ci === 0, onClick: () => move(categories, ci, -1, '/api/meal-menu/categories-order') },
                  { label: 'Move down', disabled: ci === categories.length - 1, onClick: () => move(categories, ci, 1, '/api/meal-menu/categories-order') },
                  { label: 'Delete', danger: true, onClick: () => setDel({ type: 'category', ...c }) },
                ]} />
              </header>
              {open.has(c.id) && c.items.map((i, ii) => (
                <div className={`mealmgmt__row ${i.active ? '' : 'is-off'}`} key={i.id}>
                  <span className="mealmgmt__name">{i.name}{!i.active && <em> · inactive</em>}</span>
                  <KebabMenu label={`Actions for ${i.name}`} items={[
                    { label: 'Edit', onClick: () => setEdit({ type: 'item', id: i.id, categoryId: c.id, name: i.name, active: i.active }) },
                    { label: i.active ? 'Deactivate' : 'Activate', onClick: () => act(() => api.put(`/api/meal-menu/items/${i.id}`, { categoryId: c.id, name: i.name, active: !i.active }), i.active ? 'Item deactivated' : 'Item activated') },
                    { label: 'Move up', disabled: ii === 0, onClick: () => move(c.items, ii, -1, '/api/meal-menu/items-order') },
                    { label: 'Move down', disabled: ii === c.items.length - 1, onClick: () => move(c.items, ii, 1, '/api/meal-menu/items-order') },
                    { label: 'Delete', danger: true, onClick: () => setDel({ type: 'item', ...i }) },
                  ]} />
                </div>
              ))}
              {open.has(c.id) && <button className="btn btn--outline btn--sm" style={{ marginTop: '.5rem' }} onClick={() => setEdit({ type: 'item', categoryId: c.id, name: '', active: true })}><Icon name="plus" size={14} /> Add item to {c.name}</button>}
            </section>
          ))}
          {edit && <EditModal edit={edit} categories={categories} onClose={() => setEdit(null)} onDone={res.reload} />}
          {del && <Confirm title={`Delete ${del.type}?`} message={del.type === 'category' ? `“${del.name}” and its ${del.items.length} item(s) will be removed from the menu. Bookings that already used them keep their saved menu.` : `“${del.name}” will be removed. Bookings that already include it keep their saved menu.`} confirmLabel="Delete" danger onClose={() => setDel(null)}
            onConfirm={() => act(() => api.del(`/api/meal-menu/${del.type === 'category' ? 'categories' : 'items'}/${del.id}`), `${del.type === 'category' ? 'Category' : 'Item'} deleted`)} />}
        </>
      )}
    </Async>
  )
}

function EditModal({ edit, categories, onClose, onDone }) {
  const toast = useToast()
  const [name, setName] = useState(edit.name)
  const [catId, setCatId] = useState(edit.categoryId)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const isCat = edit.type === 'category'
  const save = async () => {
    if (!name.trim()) return setErr('Enter a name')
    setBusy(true); setErr('')
    try {
      if (isCat) {
        if (edit.id) await api.put(`/api/meal-menu/categories/${edit.id}`, { name: name.trim(), active: edit.active })
        else await api.post('/api/meal-menu/categories', { name: name.trim() })
      } else if (edit.id) await api.put(`/api/meal-menu/items/${edit.id}`, { categoryId: catId, name: name.trim(), active: edit.active })
      else await api.post('/api/meal-menu/items', { categoryId: catId, name: name.trim() })
      toast('Saved'); onDone(); onClose()
    } catch (e) { setErr(errMsg(e)); setBusy(false) }
  }
  return (
    <Modal title={`${edit.id ? (isCat ? 'Rename category' : 'Edit item') : isCat ? 'Add category' : 'Add item'}`} small onClose={onClose} footer={<><button className="btn btn--secondary" onClick={onClose}>Cancel</button><button className="btn btn--primary" onClick={save} disabled={busy}>Save</button></>}>
      <div className="form">
        {!isCat && edit.id && <Field label="Category"><select value={catId} onChange={(e) => setCatId(e.target.value)}>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>}
        <Field label={isCat ? 'Category name *' : 'Item name *'}><input value={name} maxLength={isCat ? 80 : 120} onChange={(e) => setName(e.target.value)} placeholder={isCat ? 'e.g. Royal Wedding Lunch' : ''} autoFocus onKeyDown={(e) => e.key === 'Enter' && save()} /></Field>
        {err && <div className="form-error" role="alert">{err}</div>}
      </div>
    </Modal>
  )
}
