import { useMemo, useState } from 'react'
import BookingCard from '../components/BookingCard'
import { Confirm, Empty, Field, Icon, Modal, MonthSelector, useToast } from '../components/common'
import { useStore } from '../store'
import { addMonth, currentYM, digits, fmt, fmtDate, fmtDateTime, initials, money, monthKey, monthLabel, resizeImage, uid } from '../utils'

/* ---------------- Food menu (read-only view) ---------------- */
export function Food() {
  const { food } = useStore()
  const cats = group(food)
  return (
    <div className="section">
      <div className="section__header"><h2 className="section__title">RHR Food Menu</h2></div>
      <div className="food-categories">
        {Object.entries(cats).map(([c, items]) => (
          <div className="food-category" key={c}>
            <h3 className="food-category__title">{c}</h3>
            <div className="food-category__items">
              {items.map((i) => (
                <div className="food-item" key={i.id}>
                  <span className="food-item__name">{i.name}</span>
                  {i.price > 0 && <span style={{ fontSize: '.8rem', color: 'var(--text-secondary)' }}>{fmt(i.price)}</span>}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
const group = (items) => items.reduce((a, i) => ((a[i.cat] = a[i.cat] || []).push(i), a), {})

/* ---------------- More menu ---------------- */
export function More({ nav }) {
  const Item = ({ icon, label, to }) => (
    <button className="more-item" onClick={() => nav.go(to)}>
      <Icon name={icon} />
      <span>{label}</span>
      <Icon name="chevR" size={16} />
    </button>
  )
  return (
    <div className="more-menu">
      <div>
        <h3 className="more-section__title">Management</h3>
        <Item icon="users" label="Customers" to="customers" />
        <Item icon="home" label="Manage Halls" to="halls" />
        <Item icon="food" label="Food Menu" to="foodMgmt" />
      </div>
      <div>
        <h3 className="more-section__title">Reports</h3>
        <Item icon="chart" label="Reports" to="reports" />
        <Item icon="file" label="Audit Log" to="audit" />
      </div>
      <div>
        <h3 className="more-section__title">Settings</h3>
        <Item icon="gear" label="App Settings & Backup" to="settings" />
      </div>
    </div>
  )
}

/* ---------------- Customers (grouped by phone) ---------------- */
export function Customers({ nav }) {
  const { bookings, payments } = useStore()
  const [q, setQ] = useState('')
  const [openKey, setOpenKey] = useState(null)

  const customers = useMemo(() => {
    const map = new Map()
    ;[...bookings].sort((a, b) => b.date.localeCompare(a.date)).forEach((b) => {
      const k = digits(b.phone) || b.name.toLowerCase()
      if (!map.has(k)) map.set(k, { key: k, name: b.name, phone: b.phone, address: b.address, list: [] })
      map.get(k).list.push(b)
    })
    return [...map.values()]
  }, [bookings])

  const t = q.trim().toLowerCase()
  const list = t ? customers.filter((c) => c.name.toLowerCase().includes(t) || c.phone.includes(digits(t) || '\u0000')) : customers

  return (
    <>
      <div className="search-bar">
        <Icon name="search" size={20} />
        <input type="search" className="search-bar__input" placeholder="Search customers..." value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {list.length === 0 ? <Empty>No customers yet</Empty> : list.map((c) => {
        const active = c.list.filter((b) => b.status !== 'cancelled')
        const spent = active.reduce((s, b) => s + money(b, payments).paid, 0)
        const open = openKey === c.key
        return (
          <div className="customer-card" key={c.key}>
            <button className="customer-card__head" onClick={() => setOpenKey(open ? null : c.key)}>
              <div className="booking-card__avatar">{initials(c.name)}</div>
              <div className="booking-card__info">
                <div className="booking-card__name">{c.name}</div>
                <div className="booking-card__meta"><span>{c.phone}</span><span>{active.length} booking{active.length !== 1 ? 's' : ''}</span><span>Paid {fmt(spent)}</span></div>
              </div>
              <Icon name={open ? 'chevD' : 'chevR'} size={16} />
            </button>
            {open && (
              <div className="customer-card__body">
                {c.address && <p className="form-hint">{c.address}</p>}
                {c.list.map((b) => <BookingCard key={b.id} b={b} onOpen={(id) => nav.go('detail', { id })} />)}
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}

/* ---------------- Halls management ---------------- */
export function HallsMgmt() {
  const { halls, bookings, saveHall, deleteHall } = useStore()
  const toast = useToast()
  const [edit, setEdit] = useState(null)
  const [del, setDel] = useState(null)
  return (
    <div className="section">
      <div className="section__header">
        <h2 className="section__title">Manage Halls</h2>
        <button className="btn btn--primary btn--sm" onClick={() => setEdit({ id: uid('h'), name: '', capacity: '', description: '', photos: [] })}>+ Add Hall</button>
      </div>
      <div className="halls-management-list">
        {halls.map((h) => (
          <div className="hall-manage-card" key={h.id}>
            <div className="hall-manage-card__image">{h.photos[0] ? <img src={h.photos[0]} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <Icon name="home" size={24} />}</div>
            <div className="hall-manage-card__info">
              <div className="hall-manage-card__name">{h.name}</div>
              <div className="hall-manage-card__capacity">Capacity: {h.capacity} guests · {h.photos.length} photos</div>
            </div>
            <div className="hall-manage-card__actions">
              <button onClick={() => setEdit(h)} aria-label={`Edit ${h.name}`}><Icon name="edit" size={16} /></button>
              <button className="danger" onClick={() => setDel(h)} aria-label={`Delete ${h.name}`}><Icon name="trash" size={16} /></button>
            </div>
          </div>
        ))}
      </div>
      {edit && <HallForm hall={edit} onClose={() => setEdit(null)} onSave={(h) => { saveHall(h); toast('Hall saved'); setEdit(null) }} />}
      {del && (
        <Confirm
          title={`Delete ${del.name}?`}
          message={bookings.some((b) => b.hallId === del.id) ? 'Existing bookings for this hall will show "Hall removed".' : 'This cannot be undone.'}
          confirmLabel="Delete"
          danger
          onClose={() => setDel(null)}
          onConfirm={() => { deleteHall(del.id); toast('Hall deleted', 'warning') }}
        />
      )}
    </div>
  )
}

function HallForm({ hall, onClose, onSave }) {
  const [h, setH] = useState({ ...hall, capacity: hall.capacity || '' })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const addPhotos = async (e) => {
    setBusy(true)
    try {
      const out = []
      for (const file of [...e.target.files]) out.push(await resizeImage(file))
      setH((s) => ({ ...s, photos: [...s.photos, ...out] }))
    } catch (x) {
      setErr(x.message)
    }
    setBusy(false)
    e.target.value = ''
  }
  const submit = () => {
    if (!h.name.trim()) return setErr('Hall name is required')
    if (!(parseInt(h.capacity, 10) > 0)) return setErr('Enter capacity')
    onSave({ ...h, name: h.name.trim(), capacity: parseInt(h.capacity, 10) })
  }
  return (
    <Modal title={hall.name ? 'Edit Hall' : 'Add Hall'} onClose={onClose} footer={<><button className="btn btn--secondary" onClick={onClose}>Cancel</button><button className="btn btn--primary" onClick={submit} disabled={busy}>Save</button></>}>
      <div className="form">
        <Field label="Hall Name"><input value={h.name} onChange={(e) => setH({ ...h, name: e.target.value })} /></Field>
        <Field label="Capacity (guests)"><input type="number" min={1} value={h.capacity} onChange={(e) => setH({ ...h, capacity: e.target.value })} /></Field>
        <Field label="Description"><textarea rows={2} value={h.description} onChange={(e) => setH({ ...h, description: e.target.value })} /></Field>
        <Field label="Photos" hint="Photos are resized automatically to keep storage small.">
          <div className="photo-grid">
            {h.photos.map((p, i) => (
              <div className="photo-grid__item" key={i}>
                <img src={p} alt="" />
                <button onClick={() => setH({ ...h, photos: h.photos.filter((_, j) => j !== i) })} aria-label="Remove photo">×</button>
              </div>
            ))}
          </div>
          <input type="file" accept="image/*" multiple onChange={addPhotos} />
        </Field>
        {err && <div className="form-error" role="alert">{err}</div>}
      </div>
    </Modal>
  )
}

/* ---------------- Food management ---------------- */
export function FoodMgmt() {
  const { food, saveFood, deleteFood } = useStore()
  const toast = useToast()
  const [edit, setEdit] = useState(null)
  const cats = group(food)
  return (
    <div className="section">
      <div className="section__header">
        <h2 className="section__title">Manage Food Menu</h2>
        <button className="btn btn--primary btn--sm" onClick={() => setEdit({ id: uid('f'), name: '', cat: Object.keys(cats)[0] || '', price: 0 })}>+ Add Item</button>
      </div>
      {Object.entries(cats).map(([c, items]) => (
        <div key={c} style={{ marginBottom: '1rem' }}>
          <h3 className="more-section__title">{c}</h3>
          <div className="food-management-list">
            {items.map((i) => (
              <div className="food-manage-item" key={i.id}>
                <span className="food-manage-item__name">{i.name}</span>
                {i.price > 0 && <span className="food-manage-item__category">{fmt(i.price)}</span>}
                <div className="food-manage-item__actions">
                  <button onClick={() => setEdit(i)} aria-label={`Edit ${i.name}`}><Icon name="edit" size={16} /></button>
                  <button className="danger" onClick={() => { deleteFood(i.id); toast(`${i.name} removed`, 'warning') }} aria-label={`Delete ${i.name}`}><Icon name="trash" size={16} /></button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      {edit && <FoodForm item={edit} cats={Object.keys(cats)} onClose={() => setEdit(null)} onSave={(i) => { saveFood(i); toast('Menu item saved'); setEdit(null) }} />}
    </div>
  )
}

function FoodForm({ item, cats, onClose, onSave }) {
  const [i, setI] = useState({ ...item, price: item.price || '' })
  const [newCat, setNewCat] = useState('')
  const [err, setErr] = useState('')
  const submit = () => {
    const cat = i.cat === '__new' ? newCat.trim() : i.cat
    if (!i.name.trim()) return setErr('Item name is required')
    if (!cat) return setErr('Choose or enter a category')
    onSave({ ...i, name: i.name.trim(), cat, price: parseFloat(i.price) || 0 })
  }
  return (
    <Modal title={item.name ? 'Edit Item' : 'Add Item'} onClose={onClose} footer={<><button className="btn btn--secondary" onClick={onClose}>Cancel</button><button className="btn btn--primary" onClick={submit}>Save</button></>}>
      <div className="form">
        <Field label="Name"><input value={i.name} onChange={(e) => setI({ ...i, name: e.target.value })} autoFocus /></Field>
        <Field label="Category">
          <select value={i.cat} onChange={(e) => setI({ ...i, cat: e.target.value })}>
            {cats.map((c) => <option key={c}>{c}</option>)}
            <option value="__new">+ New category…</option>
          </select>
        </Field>
        {i.cat === '__new' && <Field label="New category name"><input value={newCat} onChange={(e) => setNewCat(e.target.value)} /></Field>}
        <Field label="Price (₹, optional)"><input type="number" min={0} value={i.price} onChange={(e) => setI({ ...i, price: e.target.value })} /></Field>
        {err && <div className="form-error" role="alert">{err}</div>}
      </div>
    </Modal>
  )
}

/* ---------------- Reports ---------------- */
export function Reports() {
  const { bookings, payments, halls } = useStore()
  const [ym, setYm] = useState(currentYM)
  const prefix = monthKey(ym.y, ym.m)
  const mb = bookings.filter((b) => b.status !== 'cancelled' && b.date.startsWith(prefix))
  const cancelled = bookings.filter((b) => b.status === 'cancelled' && b.date.startsWith(prefix)).length
  const tot = mb.reduce(
    (a, b) => {
      const m = money(b, payments)
      return { hall: a.hall + m.hallTotal, cat: a.cat + m.catTotal, paid: a.paid + m.paid, bal: a.bal + m.balance }
    },
    { hall: 0, cat: 0, paid: 0, bal: 0 },
  )
  const byType = mb.reduce((a, b) => ((a[b.eventType] = (a[b.eventType] || 0) + 1), a), {})
  const maxHall = Math.max(1, ...halls.map((h) => mb.filter((b) => b.hallId === h.id).length))

  return (
    <div className="reports">
      <MonthSelector label={monthLabel(ym)} onPrev={() => setYm(addMonth(ym, -1))} onNext={() => setYm(addMonth(ym, 1))} />
      <div className="report-cards">
        <div className="report-card">
          <h3>Revenue (function dates in {monthLabel(ym)})</h3>
          <div className="report-card__highlight">{fmt(tot.paid)} <span style={{ fontSize: '.8rem', fontWeight: 500, color: 'var(--text-secondary)' }}>collected</span></div>
          <Row l="Active bookings" v={mb.length} />
          <Row l="Cancelled bookings" v={cancelled} />
          <Row l="Hall billing" v={fmt(tot.hall)} />
          <Row l="Catering billing" v={fmt(tot.cat)} />
          <Row l="Pending balance" v={fmt(tot.bal)} color="var(--warning)" />
        </div>
        <div className="report-card">
          <h3>Hall Utilization</h3>
          {halls.map((h) => {
            const n = mb.filter((b) => b.hallId === h.id).length
            return (
              <div key={h.id} style={{ marginBottom: '.65rem' }}>
                <div className="report-card__row" style={{ border: 'none', padding: '.2rem 0' }}><span>{h.name}</span><span>{n} booking{n !== 1 ? 's' : ''}</span></div>
                <div className="progress-bar"><div style={{ width: `${(n / maxHall) * 100}%` }} /></div>
              </div>
            )
          })}
        </div>
        <div className="report-card">
          <h3>Event Types</h3>
          {Object.keys(byType).length ? Object.entries(byType).map(([k, v]) => <Row key={k} l={k} v={v} />) : <p className="form-hint">No bookings</p>}
        </div>
        <div className="report-card">
          <h3>Food Status</h3>
          <Row l="Food confirmed" v={mb.filter((b) => b.foodStatus === 'confirmed').length} color="var(--success)" />
          <Row l="Food pending" v={mb.filter((b) => b.foodStatus !== 'confirmed').length} color="var(--warning)" />
        </div>
      </div>
    </div>
  )
}
const Row = ({ l, v, color }) => (
  <div className="report-card__row"><span>{l}</span><span style={color ? { color } : undefined}>{v}</span></div>
)

/* ---------------- Audit log ---------------- */
export function AuditLog() {
  const { audit } = useStore()
  return (
    <div className="section">
      <h2 className="section__title" style={{ marginBottom: '.85rem' }}>Audit Log</h2>
      <div className="audit-list">
        {audit.length === 0 ? <Empty>No audit entries yet</Empty> : [...audit].reverse().map((l, i) => (
          <div className="audit-item" key={l.id || i}>
            <div className="audit-item__header"><span className="audit-item__user">Admin</span><span className="audit-item__time">{fmtDateTime(l.time)}</span></div>
            <div className="audit-item__action">{l.action}</div>
            {l.details && <div className="audit-item__change">{l.details}</div>}
          </div>
        ))}
      </div>
    </div>
  )
}

/* ---------------- Settings & backup ---------------- */
export function Settings() {
  const { settings, saveSettings, exportData, importData } = useStore()
  const toast = useToast()
  const [s, setS] = useState(settings)
  const [confirmImport, setConfirmImport] = useState(null)

  const download = () => {
    const blob = new Blob([exportData()], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `rhr-backup-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(a.href)
    toast('Backup downloaded')
  }
  const pick = async (e) => {
    const file = e.target.files[0]
    e.target.value = ''
    if (!file) return
    setConfirmImport(await file.text())
  }

  return (
    <div className="settings">
      <h2 className="section__title" style={{ marginBottom: '.85rem' }}>App Settings</h2>
      <div className="form">
        <Field label="Restaurant Name"><input value={s.hotelName} onChange={(e) => setS({ ...s, hotelName: e.target.value })} /></Field>
        <Field label="Phone"><input type="tel" value={s.phone} onChange={(e) => setS({ ...s, phone: e.target.value })} /></Field>
        <Field label="Address"><textarea rows={2} value={s.address} onChange={(e) => setS({ ...s, address: e.target.value })} /></Field>
        <button className="btn btn--primary" onClick={() => { saveSettings(s); toast('Settings saved') }}>Save Settings</button>
      </div>
      <div className="settings-block">
        <h3>Backup & Restore</h3>
        <p>All data is stored in this browser only. Download a backup regularly, and use it to move data to another phone or computer.</p>
        <div className="settings-actions">
          <button className="btn btn--outline" onClick={download}>Download Backup</button>
          <label className="btn btn--outline" style={{ cursor: 'pointer' }}>
            Restore from File
            <input type="file" accept="application/json,.json" hidden onChange={pick} />
          </label>
        </div>
      </div>
      {confirmImport && (
        <Confirm
          title="Restore backup?"
          message="This replaces ALL current bookings, payments, halls and menu with the backup file."
          confirmLabel="Restore"
          danger
          onClose={() => setConfirmImport(null)}
          onConfirm={() => {
            try {
              importData(confirmImport)
              toast('Backup restored')
            } catch (e) {
              toast(e.message || 'Invalid backup file', 'error')
            }
          }}
        />
      )}
    </div>
  )
}
