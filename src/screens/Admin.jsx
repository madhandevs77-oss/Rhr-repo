import { useEffect, useState } from 'react'
import { api, errMsg } from '../api'
import BookingCard from '../components/BookingCard'
import { Async, AsyncButton, Empty, Field, Icon, Modal, MonthSelector, Tag, useToast } from '../components/common'
import { Messages, ReasonModal } from '../components/DocParts'
import { useApp, useLoad } from '../store'
import { addMonth, cap, currentYM, fmt, fmtDate, fmtDateTime, initials, monthKey, monthLabel } from '../utils'

const group = (items) => items.reduce((a, i) => ((a[i.category] = a[i.category] || []).push(i), a), {})

/* ---------------- More menu ---------------- */
export function More({ nav }) {
  const { can, logout, user } = useApp()
  const pending = useLoad(() => (can('payments.verify') ? api.get('/api/payments/pending') : Promise.resolve({ payments: [] })), [])
  const Item = ({ icon, label, sub, to, perm, badge }) =>
    (!perm || can(perm)) && (
      <button className="more-item" onClick={() => nav.go(to)}>
        <Icon name={icon} /><span>{label}{sub && <small className="more-item__sub">{sub}</small>}</span>{badge > 0 && <em className="badge badge--alert">{badge}</em>}<Icon name="chevR" size={16} />
      </button>
    )
  return (
    <div className="more-menu">
      <div>
        <h3 className="more-section__title">Money</h3>
        <Item icon="rupee" label="Payments to verify" to="payments" perm="payments.verify" badge={pending.data?.payments.length} />
        <Item icon="file" label="Invoices" to="invoices" perm="invoices.view" />
        <Item icon="phone" label="Customer messages" to="notifications" perm="notifications.view" />
      </div>
      <div>
        <h3 className="more-section__title">Management</h3>
        <Item icon="users" label="Customers" to="customers" perm="customers.view" />
        <Item icon="home" label="Manage Halls" to="halls" perm="halls.manage" />
        <Item icon="food" label="Catering Menu" sub="Food categories and items" to="mealMenu" perm="mealmenu.manage" />
        <Item icon="rupee" label="Catering Prices" sub="Price and unit for each menu item" to="foodMgmt" perm="menu.manage" />
        <Item icon="truck" label="Vendors" to="vendors" perm="vendors.view" />
        <Item icon="users" label="Users & roles" to="users" perm="users.manage" />
      </div>
      <div>
        <h3 className="more-section__title">Reports</h3>
        <Item icon="chart" label="Reports" to="reports" perm="reports.view" />
        <Item icon="file" label="Audit Log" to="audit" perm="audit.view" />
      </div>
      <div>
        <h3 className="more-section__title">Settings</h3>
        <Item icon="gear" label="Settings, messaging & backup" to="settings" perm="settings.view" />
        <Item icon="gear" label="Change password" to="password" />
        <button className="more-item" onClick={logout}><Icon name="back" /><span>Sign out ({user.username})</span></button>
      </div>
    </div>
  )
}

/* ---------------- Change password ---------------- */
export function ChangePassword() {
  const { logout } = useApp()
  const toast = useToast()
  const [f, setF] = useState({ currentPassword: '', newPassword: '', again: '' })
  const [err, setErr] = useState('')
  const submit = async () => {
    setErr('')
    if (f.newPassword !== f.again) return setErr('The new passwords do not match')
    try { await api.post('/api/auth/change-password', { currentPassword: f.currentPassword, newPassword: f.newPassword }); toast('Password changed — please sign in again'); await logout() } catch (e) { setErr(errMsg(e)) }
  }
  return (
    <div className="form">
      <Field label="Current password"><input type="password" autoComplete="current-password" value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} /></Field>
      <Field label="New password" hint="At least 10 characters, with letters and numbers"><input type="password" autoComplete="new-password" value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} /></Field>
      <Field label="Repeat new password"><input type="password" autoComplete="new-password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} /></Field>
      {err && <div className="form-error" role="alert">{err}</div>}
      <AsyncButton onClick={submit} disabled={!f.currentPassword || !f.newPassword}>Change password</AsyncButton>
      <p className="form-hint">You will be signed out on all devices after changing your password.</p>
    </div>
  )
}

/* ---------------- Customers ---------------- */
export function Customers({ nav }) {
  const [q, setQ] = useState('')
  const [term, setTerm] = useState('')
  const [openId, setOpenId] = useState(null)
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 300); return () => clearTimeout(t) }, [q])
  const res = useLoad(() => api.get('/api/customers', { q: term }), [term])
  return (
    <>
      <div className="search-bar"><Icon name="search" size={20} /><input type="search" className="search-bar__input" placeholder="Search customers..." value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search customers" /></div>
      <Async res={res} empty={(d) => (d.customers.length ? null : <Empty>No customers yet</Empty>)}>
        {({ customers }) => customers.map((c) => (
          <div className="customer-card" key={c.id}>
            <button className="customer-card__head" onClick={() => setOpenId(openId === c.id ? null : c.id)} aria-expanded={openId === c.id}>
              <div className="booking-card__avatar">{initials(c.name)}</div>
              <div className="booking-card__info"><div className="booking-card__name">{c.name}</div><div className="booking-card__meta"><span>{c.phone}</span><span>{c.bookings} hall</span><span>{c.cateringOrders} catering</span></div></div>
              <Icon name={openId === c.id ? 'chevD' : 'chevR'} size={16} />
            </button>
            {openId === c.id && <CustomerBody c={c} nav={nav} />}
          </div>
        ))}
      </Async>
    </>
  )
}
function CustomerBody({ c, nav }) {
  const { can } = useApp()
  const toast = useToast()
  const res = useLoad(() => api.get('/api/bookings', { customerId: c.id }), [c.id])
  const [consent, setConsent] = useState(c.messageConsent)
  return (
    <div className="customer-card__body">
      {c.address && <p className="form-hint">{c.address}</p>}
      <div className="consent-row"><span>Messaging consent: <strong>{consent ? 'Yes' : 'No'}</strong></span>
        {can('customers.edit') && <button className="btn btn--sm btn--outline" onClick={async () => { try { await api.patch(`/api/customers/${c.id}`, { messageConsent: !consent }); setConsent(!consent); toast('Consent updated') } catch (e) { toast(errMsg(e), 'error') } }}>{consent ? 'Withdraw' : 'Record consent'}</button>}</div>
      <Async res={res}>{({ bookings }) => (bookings.length ? bookings.map((b) => <BookingCard key={b.id} b={b} onOpen={(id) => nav.go('detail', { id })} />) : <p className="form-hint">No hall bookings.</p>)}</Async>
    </div>
  )
}

/* ---------------- Menu management ---------------- */
const UNITS = ['plate', 'kg', 'litre', 'piece', 'tray', 'packet']
/** Catering Prices: one price + unit for each item of the Catering Menu (the menu itself is managed under Catering Menu). */
export function FoodMgmt({ nav }) {
  const toast = useToast()
  const menu = useLoad(() => api.get('/api/meal-menu', { all: 1 }), [])
  const prices = useLoad(() => api.get('/api/catering-prices'), [])
  const [edit, setEdit] = useState(null)
  const [open, setOpen] = useState(() => new Set())
  const [q, setQ] = useState('')
  const [unpricedOnly, setUnpricedOnly] = useState(false)
  const flip = (id) => setOpen((cur) => { const n = new Set(cur); n.has(id) ? n.delete(id) : n.add(id); return n })
  const term = q.trim().toLowerCase()
  return (
    <div className="section">
      <div className="section__header"><h2 className="section__title">Catering Prices</h2><button className="btn btn--text btn--sm" onClick={() => nav?.go('mealMenu')}>Manage Catering Menu →</button></div>
      <p className="form-hint">Set the price and unit for each item. Items come from the Catering Menu; add or rename them there. Staff see these prices automatically in new catering orders.</p>
      <div className="mealmgmt__bar">
        <input type="search" placeholder="Search items…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search items" />
        <label className="consent" style={{ margin: 0, whiteSpace: 'nowrap' }}><input type="checkbox" checked={unpricedOnly} onChange={(e) => setUnpricedOnly(e.target.checked)} /><span>No price yet</span></label>
      </div>
      <Async res={menu}>{({ categories }) => (
        <Async res={prices}>{({ prices: pm }) => {
          const shown = categories.map((c) => ({ ...c, list: c.items.filter((i) => (!term || i.name.toLowerCase().includes(term) || c.name.toLowerCase().includes(term)) && (!unpricedOnly || !pm[i.id])) })).filter((c) => c.list.length)
          if (!shown.length) return <Empty>{categories.length ? 'No matching items' : 'The Catering Menu is empty. Add categories and items there first.'}</Empty>
          return shown.map((c) => (
            <section className={`mmcat ${c.active ? '' : 'is-off'}`} key={c.id} data-testid={`price-cat-${c.name}`}>
              <header className="mmcat__head">
                <button className="mmcat__toggle" aria-expanded={open.has(c.id) || !!term || unpricedOnly} onClick={() => flip(c.id)}><span aria-hidden>{open.has(c.id) || term || unpricedOnly ? '▾' : '▸'}</span> <h3>{c.name}{!c.active && <em> · inactive</em>}</h3> <small>{c.list.length} {c.list.length === 1 ? 'item' : 'items'} · {c.list.filter((i) => pm[i.id]).length} priced</small></button>
              </header>
              {(open.has(c.id) || term || unpricedOnly) && c.list.map((i) => (
                <div className={`mealmgmt__row ${i.active ? '' : 'is-off'}`} key={i.id}>
                  <span className="mealmgmt__name">{i.name}{!i.active && <em> · inactive</em>}</span>
                  <span className="price-cell">
                    <span className={pm[i.id] ? 'price-cell__val' : 'price-cell__none'}>{pm[i.id] ? `${fmt(pm[i.id].unitPrice)} / ${pm[i.id].unit}` : 'Price not set'}</span>
                    <button className="btn btn--sm btn--outline" onClick={() => setEdit({ item: i, unit: pm[i.id]?.unit || 'plate', unitPrice: pm[i.id]?.unitPrice ?? '' })} aria-label={`Edit price of ${i.name}`}>{pm[i.id] ? 'Edit' : 'Set price'}</button>
                  </span>
                </div>
              ))}
            </section>
          ))
        }}</Async>
      )}</Async>
      {edit && <PriceModal edit={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); toast('Price saved'); prices.reload() }} />}
    </div>
  )
}
function PriceModal({ edit, onClose, onSaved }) {
  const [unit, setUnit] = useState(edit.unit)
  const [price, setPrice] = useState(edit.unitPrice)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    const v = parseFloat(price)
    if (!(v >= 0)) return setErr('Enter the price (0 or more)')
    setBusy(true); setErr('')
    try { await api.put(`/api/catering-prices/${edit.item.id}`, { unit, unitPrice: v }); onSaved() } catch (e) { setErr(errMsg(e)); setBusy(false) }
  }
  return (
    <Modal title={`Price — ${edit.item.name}`} small onClose={onClose} footer={<><button className="btn btn--secondary" onClick={onClose}>Cancel</button><button className="btn btn--primary" onClick={submit} disabled={busy}>Save</button></>}>
      <div className="form">
        <div className="form-row">
          <Field label="Price (₹) *"><input type="number" min={0} step="any" value={price} onChange={(e) => setPrice(e.target.value)} autoFocus onKeyDown={(e) => e.key === 'Enter' && submit()} /></Field>
          <Field label="Per"><select value={unit} onChange={(e) => setUnit(e.target.value)}>{UNITS.map((u) => <option key={u}>{u}</option>)}</select></Field>
        </div>
        {err && <div className="form-error" role="alert">{err}</div>}
      </div>
    </Modal>
  )
}

/* ---------------- Vendors ---------------- */
export function Vendors() {
  const { can } = useApp()
  const res = useLoad(() => api.get('/api/vendors'), [])
  const [edit, setEdit] = useState(null)
  return (
    <div className="section">
      <div className="section__header"><h2 className="section__title">Vendors & partners</h2>{can('vendors.manage') && <button className="btn btn--primary btn--sm" onClick={() => setEdit({ name: '', contactPerson: '', phone: '', email: '', address: '', notes: '', active: true })}>+ Add Vendor</button>}</div>
      <Async res={res} empty={(d) => (d.vendors.length ? null : <Empty>No vendors yet. Add the external caterers you work with.</Empty>)}>
        {({ vendors }) => vendors.map((v) => (
          <div className={`hall-manage-card ${v.active ? '' : 'is-inactive'}`} key={v.id}>
            <div className="hall-manage-card__image"><Icon name="truck" size={22} /></div>
            <div className="hall-manage-card__info"><div className="hall-manage-card__name">{v.name} {!v.active && <Tag kind="status-cancelled">Inactive</Tag>}</div><div className="hall-manage-card__meta">{v.contactPerson}{v.phone ? ` · ${v.phone}` : ''} · {v.openOrders} open order{v.openOrders !== 1 ? 's' : ''}</div></div>
            {can('vendors.manage') && <div className="hall-manage-card__actions"><button onClick={() => setEdit(v)} aria-label={`Edit ${v.name}`}><Icon name="edit" size={16} /></button></div>}
          </div>
        ))}
      </Async>
      {edit && <VendorForm v={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); res.reload() }} />}
    </div>
  )
}
function VendorForm({ v, onClose, onSaved }) {
  const toast = useToast()
  const [f, setF] = useState(v)
  const [err, setErr] = useState('')
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })
  const submit = async () => {
    if (f.name.trim().length < 2) return setErr('Vendor name is required')
    const b = { name: f.name.trim(), contactPerson: f.contactPerson, phone: f.phone, email: f.email, address: f.address, notes: f.notes, active: f.active }
    try { if (v.id) await api.patch(`/api/vendors/${v.id}`, b); else await api.post('/api/vendors', b); toast('Vendor saved'); onSaved() } catch (e) { setErr(errMsg(e)) }
  }
  return (
    <Modal title={v.id ? 'Edit Vendor' : 'Add Vendor'} onClose={onClose} footer={<><button className="btn btn--secondary" onClick={onClose}>Cancel</button><button className="btn btn--primary" onClick={submit}>Save</button></>}>
      <div className="form">
        <Field label="Name *"><input value={f.name} onChange={set('name')} autoFocus /></Field>
        <div className="form-row"><Field label="Contact person"><input value={f.contactPerson} onChange={set('contactPerson')} /></Field><Field label="Phone"><input type="tel" value={f.phone} onChange={set('phone')} /></Field></div>
        <Field label="Email"><input type="email" value={f.email} onChange={set('email')} /></Field>
        <Field label="Address"><textarea rows={2} value={f.address} onChange={set('address')} /></Field>
        <Field label="Notes"><textarea rows={2} value={f.notes} onChange={set('notes')} /></Field>
        <label className="consent"><input type="checkbox" checked={f.active} onChange={set('active')} /><span>Active (can be assigned to new orders)</span></label>
        {err && <div className="form-error" role="alert">{err}</div>}
      </div>
    </Modal>
  )
}

/* ---------------- Users ---------------- */
export function Users() {
  const res = useLoad(() => api.get('/api/users'), [])
  const [edit, setEdit] = useState(null)
  return (
    <div className="section">
      <div className="section__header"><h2 className="section__title">Users & roles</h2><button className="btn btn--primary btn--sm" onClick={() => setEdit({ username: '', name: '', role: 'staff', active: true, isNew: true })}>+ Add User</button></div>
      <p className="form-hint"><strong>Staff</strong> can create bookings and record payments (awaiting verification). <strong>Managers</strong> can also verify payments, change amounts, cancel and refund. <strong>Admins</strong> manage halls, users, settings and reversals.</p>
      <Async res={res}>
        {({ users }) => users.map((u) => (
          <div className={`hall-manage-card ${u.active ? '' : 'is-inactive'}`} key={u.id}>
            <div className="hall-manage-card__image"><span className="booking-card__avatar">{initials(u.name)}</span></div>
            <div className="hall-manage-card__info"><div className="hall-manage-card__name">{u.name} {!u.active && <Tag kind="status-cancelled">Disabled</Tag>}</div><div className="hall-manage-card__meta">{u.username} · {cap(u.role)}</div></div>
            <div className="hall-manage-card__actions"><button onClick={() => setEdit(u)} aria-label={`Edit ${u.name}`}><Icon name="edit" size={16} /></button></div>
          </div>
        ))}
      </Async>
      {edit && <UserForm u={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); res.reload() }} />}
    </div>
  )
}
function UserForm({ u, onClose, onSaved }) {
  const { user } = useApp()
  const toast = useToast()
  const [f, setF] = useState({ ...u, password: '' })
  const [err, setErr] = useState('')
  const self = u.id === user.id
  const submit = async () => {
    try {
      if (u.isNew) await api.post('/api/users', { username: f.username.trim(), name: f.name.trim(), role: f.role, password: f.password })
      else await api.patch(`/api/users/${u.id}`, { name: f.name.trim(), role: f.role, active: f.active, ...(f.password ? { password: f.password } : {}) })
      toast('User saved'); onSaved()
    } catch (e) { setErr(errMsg(e)) }
  }
  return (
    <Modal title={u.isNew ? 'Add User' : `Edit ${u.username}`} onClose={onClose} footer={<><button className="btn btn--secondary" onClick={onClose}>Cancel</button><button className="btn btn--primary" onClick={submit}>Save</button></>}>
      <div className="form">
        {u.isNew && <Field label="Username *"><input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} autoCapitalize="none" /></Field>}
        <Field label="Full name *"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Role"><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} disabled={self}><option value="staff">Staff</option><option value="manager">Manager</option><option value="admin">Admin</option></select></Field>
        <Field label={u.isNew ? 'Password *' : 'Reset password (optional)'} hint="At least 10 characters, letters and numbers. Changing it signs the user out."><input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        {!u.isNew && <label className="consent"><input type="checkbox" checked={f.active} disabled={self} onChange={(e) => setF({ ...f, active: e.target.checked })} /><span>Account active</span></label>}
        {err && <div className="form-error" role="alert">{err}</div>}
      </div>
    </Modal>
  )
}

/* ---------------- Payments awaiting verification ---------------- */
export function PaymentsQueue({ nav }) {
  const toast = useToast()
  const res = useLoad(() => api.get('/api/payments/pending'), [])
  const [rej, setRej] = useState(null)
  const act = async (fn, msg) => { try { await fn(); toast(msg); res.reload() } catch (e) { toast(errMsg(e), 'error'); res.reload() } }
  return (
    <Async res={res} empty={(d) => (d.payments.length ? null : <Empty>Nothing to verify. 🎉</Empty>)}>
      {({ payments }) => (
        <>
          <p className="form-hint">Confirm each payment only after you have seen the money (cash in hand, UPI/bank credit). Balances, invoices and customer confirmations change only after verification. You cannot verify a payment you recorded yourself (an admin can).</p>
          {payments.map((p) => (
            <div className="queue-card" key={p.id}>
              <div className="queue-card__top"><strong>{fmt(p.amount)}</strong><span>{p.method}{p.reference ? ` · ${p.reference}` : ''}</span></div>
              <div className="form-hint" style={{ margin: 0 }}>{p.customer} · {p.reference2} · {fmtDate(p.paidOn)} · recorded by {p.recordedBy || 'system'} {fmtDateTime(p.recordedAt)}</div>
              <div className="queue-card__actions">
                <button className="btn btn--sm btn--outline" onClick={() => (p.bookingId ? nav.go('detail', { id: p.bookingId }) : nav.go('cDetail', { id: p.cateringOrderId }))}>Open</button>
                <button className="btn btn--sm btn--outline" onClick={() => setRej(p)}>Reject</button>
                <AsyncButton className="btn btn--sm btn--primary" onClick={() => act(() => api.post(`/api/payments/${p.id}/verify`), 'Payment verified')}>Verify</AsyncButton>
              </div>
            </div>
          ))}
          {rej && <ReasonModal title="Reject payment" label="Reason (e.g. money not received)" confirm="Reject" onClose={() => setRej(null)} onSubmit={(reason) => act(() => api.post(`/api/payments/${rej.id}/reject`, { reason }), 'Payment rejected')} />}
        </>
      )}
    </Async>
  )
}

/* ---------------- Message log ---------------- */
export function Notifications() {
  const toast = useToast()
  const [status, setStatus] = useState('')
  const res = useLoad(() => api.get('/api/notifications', { status }), [status])
  const [open, setOpen] = useState(null)
  const [attempts, setAttempts] = useState([])
  const show = async (n) => {
    if (open === n.id) return setOpen(null)
    setOpen(n.id)
    try { setAttempts((await api.get(`/api/notifications/${n.id}/attempts`)).attempts) } catch { setAttempts([]) }
  }
  return (
    <>
      <div className="filters">
        {[['', 'All'], ['failed', 'Failed'], ['queued', 'Queued'], ['retrying', 'Retrying'], ['sent', 'Sent'], ['delivered', 'Delivered'], ['skipped', 'Skipped']].map(([k, l]) => <button key={k} className={`filter-chip ${status === k ? 'active' : ''}`} onClick={() => setStatus(k)}>{l}</button>)}
      </div>
      <Async res={res} empty={(d) => (d.notifications.length ? null : <Empty>No messages{status ? ` with status “${status}”` : ''}.</Empty>)}>
        {({ notifications }) => notifications.map((n) => (
          <div className="msg" key={n.id}>
            <div className="msg__head" role="button" tabIndex={0} onClick={() => show(n)} onKeyDown={(e) => e.key === 'Enter' && show(n)}>
              <span>{n.customer} · {n.reference} · {cap(n.type)}</span><Tag kind={['sent', 'delivered'].includes(n.status) ? 'status-confirmed' : n.status === 'failed' ? 'status-cancelled' : 'warn'}>{cap(n.status)}</Tag>
            </div>
            <div className="form-hint" style={{ margin: 0 }}>{fmtDateTime(n.createdAt)} · {n.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'} to {n.toPhone} · {n.attempts}/{n.maxAttempts} attempts{n.skippedReason ? ` · ${n.skippedReason}` : ''}{n.lastError && n.status !== 'sent' ? ` · ${n.lastError}` : ''}</div>
            {open === n.id && (
              <>
                <pre className="msg__body">{n.body}</pre>
                {attempts.map((a) => <div className="form-hint" key={a.attemptNo} style={{ margin: 0 }}>Attempt {a.attemptNo}: {a.outcome}{a.error ? ` — ${a.error}` : ''} ({fmtDateTime(a.at)})</div>)}
              </>
            )}
            {n.status === 'failed' && <AsyncButton className="btn btn--sm btn--outline" onClick={async () => { try { await api.post(`/api/notifications/${n.id}/retry`); toast('Retry queued'); res.reload() } catch (e) { toast(errMsg(e), 'error') } }}>Retry sending</AsyncButton>}
          </div>
        ))}
      </Async>
    </>
  )
}

/* ---------------- Reports ---------------- */
export function Reports() {
  const [ym, setYm] = useState(currentYM)
  const month = monthKey(ym.y, ym.m)
  const res = useLoad(() => api.get('/api/reports/summary', { month }), [month])
  return (
    <div className="reports">
      <MonthSelector label={monthLabel(ym)} onPrev={() => setYm(addMonth(ym, -1))} onNext={() => setYm(addMonth(ym, 1))} />
      <Async res={res}>
        {(d) => {
          const maxHall = Math.max(1, ...Object.values(d.halls.byHall))
          return (
            <div className="report-cards">
              <div className="report-card">
                <h3>Hall bookings (function dates in {monthLabel(ym)})</h3>
                <div className="report-card__highlight">{fmt(d.halls.collected)} <span className="muted">collected (verified)</span></div>
                <RRow l="Active bookings" v={d.halls.count} /><RRow l="Cancelled" v={d.halls.cancelled} /><RRow l="Billed" v={fmt(d.halls.billed)} />
                <RRow l="Balance due" v={fmt(d.halls.outstanding)} color="var(--warning)" /><RRow l="Awaiting verification" v={fmt(d.halls.awaitingVerification)} color="var(--warning)" />
              </div>
              <div className="report-card">
                <h3>Bulk catering</h3>
                <div className="report-card__highlight">{fmt(d.catering.collected)} <span className="muted">collected (verified)</span></div>
                <RRow l="Orders" v={d.catering.count} /><RRow l="Plates" v={d.catering.plates} /><RRow l="Billed" v={fmt(d.catering.billed)} /><RRow l="Balance due" v={fmt(d.catering.outstanding)} color="var(--warning)" />
                {Object.entries(d.catering.byStatus).map(([k, v]) => <RRow key={k} l={cap(k)} v={v} />)}
              </div>
              <div className="report-card">
                <h3>Vendor margin (delivered orders with vendor cost)</h3>
                <RRow l="Orders" v={d.catering.vendor.ordersWithFinalCost} /><RRow l="Customer revenue" v={fmt(d.catering.vendor.revenue)} /><RRow l="Vendor cost" v={fmt(d.catering.vendor.cost)} /><RRow l="Margin" v={fmt(d.catering.vendor.margin)} color="var(--success)" />
              </div>
              <div className="report-card">
                <h3>Hall utilization</h3>
                {Object.keys(d.halls.byHall).length === 0 && <p className="form-hint">No bookings</p>}
                {Object.entries(d.halls.byHall).map(([h, n]) => (
                  <div key={h} style={{ marginBottom: '.65rem' }}><div className="report-card__row" style={{ border: 'none', padding: '.2rem 0' }}><span>{h}</span><span>{n} booking{n !== 1 ? 's' : ''}</span></div><div className="progress-bar"><div style={{ width: `${(n / maxHall) * 100}%` }} /></div></div>
                ))}
              </div>
              <div className="report-card">
                <h3>Event types</h3>
                {Object.keys(d.halls.byType).length ? Object.entries(d.halls.byType).map(([k, v]) => <RRow key={k} l={k} v={v} />) : <p className="form-hint">No bookings</p>}
                <RRow l="Food confirmed" v={d.halls.foodConfirmed} color="var(--success)" /><RRow l="Food pending" v={d.halls.foodPending} color="var(--warning)" />
              </div>
            </div>
          )
        }}
      </Async>
    </div>
  )
}
const RRow = ({ l, v, color }) => <div className="report-card__row"><span>{l}</span><span style={color ? { color } : undefined}>{v}</span></div>

/* ---------------- Audit log ---------------- */
export function AuditLog() {
  const [type, setType] = useState('')
  const res = useLoad(() => api.get('/api/audit', { entityType: type, limit: 200 }), [type])
  return (
    <div className="section">
      <h2 className="section__title" style={{ marginBottom: '.6rem' }}>Audit Log</h2>
      <div className="filters">{[['', 'All'], ['booking', 'Bookings'], ['catering', 'Catering'], ['payment', 'Payments'], ['invoice', 'Invoices'], ['hall', 'Halls'], ['user', 'Users']].map(([k, l]) => <button key={k} className={`filter-chip ${type === k ? 'active' : ''}`} onClick={() => setType(k)}>{l}</button>)}</div>
      <Async res={res} empty={(d) => (d.events.length ? null : <Empty>No audit entries</Empty>)}>
        {({ events }) => (
          <div className="audit-list">
            {events.map((l) => (
              <div className="audit-item" key={l.id}>
                <div className="audit-item__header"><span className="audit-item__user">{l.user || 'System'}</span><span className="audit-item__time">{fmtDateTime(l.at)}</span></div>
                <div className="audit-item__action">{l.action}</div>
                {l.summary && <div className="audit-item__change">{l.summary}</div>}
              </div>
            ))}
          </div>
        )}
      </Async>
    </div>
  )
}

export { Messages }
