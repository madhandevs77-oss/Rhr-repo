import { useEffect, useRef, useState } from 'react'
import { api, errMsg } from '../api'
import { Confirm, Empty, Field, Icon, Modal, useToast } from '../components/common'
import { useApp } from '../store'
import { fmt, fmtDate, todayStr } from '../utils'

const MAX_MB = 8
const OK_TYPES = ['image/jpeg', 'image/png', 'image/webp']

export default function Halls({ openHall = null, openTab = 'details' }) {
  const { halls, reloadHalls, can } = useApp()
  const toast = useToast()
  const [edit, setEdit] = useState(openHall) // hall id | 'new'
  const [del, setDel] = useState(null)
  if (!can('halls.manage')) return <Empty>Only an administrator can manage halls.</Empty>
  const current = edit && edit !== 'new' ? halls.find((h) => h.id === edit) : null
  return (
    <div className="section">
      <div className="section__header">
        <h2 className="section__title">Manage Halls</h2>
        <button className="btn btn--primary btn--sm" onClick={() => setEdit('new')} data-testid="add-hall">+ Add Hall</button>
      </div>
      {halls.length === 0 && <Empty>No halls yet. Add your first hall, then upload its photos.</Empty>}
      <div className="halls-management-list">
        {halls.map((h) => (
          <div className={`hall-manage-card ${h.active ? '' : 'is-inactive'}`} key={h.id}>
            <div className="hall-manage-card__image">{h.coverUrl ? <img src={h.coverUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <Icon name="home" size={24} />}</div>
            <div className="hall-manage-card__info">
              <div className="hall-manage-card__name">{h.name} {!h.active && <span className="tag tag--status-cancelled">Inactive</span>}</div>
              <div className="hall-manage-card__meta">{`Default charge ${fmt(h.defaultCharge)} · `}{h.images.length} photo{h.images.length !== 1 ? 's' : ''}{h.basePrice > 0 ? ` · ${fmt(h.basePrice)}` : ''}</div>
            </div>
            <div className="hall-manage-card__actions">
              <button onClick={() => setEdit(h.id)} aria-label={`Edit ${h.name}`}><Icon name="edit" size={16} /></button>
              <button className="danger" onClick={() => setDel(h)} aria-label={`Delete ${h.name}`}><Icon name="trash" size={16} /></button>
            </div>
          </div>
        ))}
      </div>
      {edit && <HallEditor hall={current} startTab={openHall && edit === openHall ? openTab : 'details'} onClose={() => setEdit(null)} onCreated={(h) => setEdit(h.id)} />}
      {del && (
        <Confirm title={`Delete ${del.name}?`} message="Its photos are removed. Halls that already have bookings cannot be deleted — deactivate them instead so history is kept." confirmLabel="Delete" danger onClose={() => setDel(null)}
          onConfirm={async () => { try { await api.del(`/api/halls/${del.id}`); await reloadHalls(); toast('Hall deleted', 'warning') } catch (e) { toast(errMsg(e), 'error') } }} />
      )}
    </div>
  )
}

function HallEditor({ hall, startTab = 'details', onClose, onCreated }) {
  const { reloadHalls } = useApp()
  const toast = useToast()
  const [tab, setTab] = useState(startTab)
  const [h, setH] = useState(() => ({ name: hall?.name || '', description: hall?.description || '', defaultCharge: hall?.defaultCharge ?? '', basePrice: hall?.basePrice || '', facilities: hall?.facilities || [], active: hall?.active ?? true, availabilityNote: hall?.availabilityNote || '' }))
  const [fac, setFac] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const addFac = () => {
    const v = fac.trim()
    if (v && !h.facilities.some((x) => x.toLowerCase() === v.toLowerCase()) && h.facilities.length < 30) setH((s) => ({ ...s, facilities: [...s.facilities, v] }))
    setFac('')
  }
  const save = async () => {
    if (!h.name.trim()) return setErr('Hall name is required')
    if (h.basePrice !== '' && !(parseFloat(h.basePrice) >= 0)) return setErr('Price must be zero or more')
    setBusy(true); setErr('')
    const payload = { name: h.name.trim(), description: h.description.trim(), defaultCharge: parseFloat(h.defaultCharge) || 0, basePrice: parseFloat(h.basePrice) || 0, facilities: h.facilities, active: h.active, availabilityNote: h.availabilityNote.trim() }
    try {
      if (hall) { await api.patch(`/api/halls/${hall.id}`, payload); await reloadHalls(); toast('Hall saved'); onClose() }
      else { const r = await api.post('/api/halls', payload); await reloadHalls(); toast('Hall created — now add photos'); onCreated(r.hall); setTab('photos') }
    } catch (e) { setErr(errMsg(e)); setBusy(false) }
  }
  useEffect(() => { if (hall) setBusy(false) }, [hall])

  return (
    <Modal title={hall ? `Edit ${hall.name}` : 'Add Hall'} onClose={onClose}
      footer={tab === 'details' ? <><button className="btn btn--secondary" onClick={onClose}>{hall ? 'Close' : 'Cancel'}</button><button className="btn btn--primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : hall ? 'Save' : 'Save & add photos'}</button></> : <button className="btn btn--secondary" onClick={onClose}>Done</button>}>
      <div className="seg" role="tablist">
        {[['details', 'Details'], ['photos', 'Photos'], ['availability', 'Availability']].map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} disabled={!hall && k !== 'details'} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'details' && (
        <div className="form" style={{ marginTop: '.8rem' }}>
          <Field label="Hall name *"><input value={h.name} onChange={(e) => setH({ ...h, name: e.target.value })} maxLength={100} /></Field>
          <div className="form-row">
            <Field label="Default maintenance charge (₹)" hint="Per 3-hour booking; used for new bookings only"><input type="number" min={0} value={h.defaultCharge} onChange={(e) => setH({ ...h, defaultCharge: e.target.value })} /></Field>
            <Field label="Base price (₹)" hint="Pre-fills the booking form"><input type="number" min={0} value={h.basePrice} onChange={(e) => setH({ ...h, basePrice: e.target.value })} /></Field>
          </div>
          <Field label="Description"><textarea rows={3} value={h.description} onChange={(e) => setH({ ...h, description: e.target.value })} maxLength={2000} /></Field>
          <Field label="Facilities" hint="e.g. AC, Stage, Parking, Generator, Dining area">
            <div className="chips">{h.facilities.map((f) => <span className="chip" key={f}>{f}<button type="button" onClick={() => setH((s) => ({ ...s, facilities: s.facilities.filter((x) => x !== f) }))} aria-label={`Remove ${f}`}>×</button></span>)}</div>
            <div className="chip-add"><input value={fac} onChange={(e) => setFac(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addFac() } }} placeholder="Add facility" maxLength={60} /><button type="button" className="btn btn--outline btn--sm" onClick={addFac}>Add</button></div>
          </Field>
          <Field label="Availability note" hint="Shown to staff when booking (e.g. closed on Mondays)"><input value={h.availabilityNote} onChange={(e) => setH({ ...h, availabilityNote: e.target.value })} maxLength={500} /></Field>
          <label className="consent"><input type="checkbox" checked={h.active} onChange={(e) => setH({ ...h, active: e.target.checked })} /><span>Available for booking (untick to hide this hall from new bookings; existing bookings are kept)</span></label>
          {err && <div className="form-error" role="alert">{err}</div>}
        </div>
      )}
      {tab === 'photos' && hall && <PhotoManager hall={hall} />}
      {tab === 'availability' && hall && <Blackouts hall={hall} />}
    </Modal>
  )
}

function PhotoManager({ hall }) {
  const { reloadHalls } = useApp()
  const toast = useToast()
  const [staged, setStaged] = useState([]) // [{file, url, error}]
  const [progress, setProgress] = useState(null)
  const [err, setErr] = useState('')
  const [del, setDel] = useState(null)
  const [drag, setDrag] = useState(false)
  const input = useRef(null)
  const replaceFor = useRef(null)
  const replaceInput = useRef(null)
  const images = hall.images

  useEffect(() => () => staged.forEach((s) => URL.revokeObjectURL(s.url)), []) // eslint-disable-line react-hooks/exhaustive-deps

  const stage = (files) => {
    setErr('')
    const room = 20 - images.length - staged.length
    const next = []
    for (const f of files) {
      let error = ''
      if (!OK_TYPES.includes(f.type)) error = 'Only JPG, PNG or WebP images'
      else if (f.size > MAX_MB * 1048576) error = `Larger than ${MAX_MB} MB`
      else if (next.filter((x) => !x.error).length >= room) error = 'Photo limit (20) reached'
      next.push({ file: f, url: URL.createObjectURL(f), error })
    }
    setStaged((s) => [...s, ...next])
  }
  const unstage = (i) => setStaged((s) => { URL.revokeObjectURL(s[i].url); return s.filter((_, j) => j !== i) })
  const valid = staged.filter((s) => !s.error)

  const upload = async () => {
    setErr('')
    const batches = []
    for (let i = 0; i < valid.length; i += 10) batches.push(valid.slice(i, i + 10))
    try {
      let done = 0
      for (const b of batches) {
        const fd = new FormData()
        b.forEach((s) => fd.append('images', s.file, s.file.name))
        setProgress(0)
        await api.upload(`/api/halls/${hall.id}/images`, fd, { onProgress: (p) => setProgress(Math.round(((done * 100) + p * b.length) / valid.length)) })
        done += b.length
      }
      staged.forEach((s) => URL.revokeObjectURL(s.url))
      setStaged([])
      await reloadHalls()
      toast(`${valid.length} photo${valid.length > 1 ? 's' : ''} uploaded`)
    } catch (e) { setErr(errMsg(e)); await reloadHalls() }
    setProgress(null)
  }
  const run = async (fn, msg) => { try { await fn(); await reloadHalls(); if (msg) toast(msg) } catch (e) { toast(errMsg(e), 'error') } }
  const move = (i, d) => {
    const ids = images.map((x) => x.id)
    const j = i + d
    if (j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    run(() => api.put(`/api/halls/${hall.id}/images/order`, { ids }))
  }
  const doReplace = async (file) => {
    const id = replaceFor.current
    if (!file || !id) return
    if (!OK_TYPES.includes(file.type) || file.size > MAX_MB * 1048576) return toast(`Use a JPG, PNG or WebP under ${MAX_MB} MB`, 'error')
    const fd = new FormData()
    fd.append('image', file, file.name)
    setProgress(0)
    try { await api.upload(`/api/halls/${hall.id}/images/${id}/replace`, fd, { onProgress: setProgress }); await reloadHalls(); toast('Photo replaced') } catch (e) { toast(errMsg(e), 'error') }
    setProgress(null)
  }

  return (
    <div style={{ marginTop: '.8rem' }}>
      <div className={`dropzone ${drag ? 'drag' : ''}`} onDragOver={(e) => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); stage([...e.dataTransfer.files]) }}>
        <Icon name="upload" size={26} />
        <p><strong>Add photos</strong><br /><span>JPG, PNG or WebP · up to {MAX_MB} MB each · min 400×300 · max 20 per hall</span></p>
        <button className="btn btn--outline btn--sm" onClick={() => input.current.click()} disabled={progress !== null}>Choose photos</button>
        <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden data-testid="hall-file-input" onChange={(e) => { stage([...e.target.files]); e.target.value = '' }} />
      </div>

      {staged.length > 0 && (
        <div className="staged">
          <div className="photo-grid">
            {staged.map((s, i) => (
              <div className={`photo-grid__item ${s.error ? 'has-error' : ''}`} key={s.url}>
                <img src={s.url} alt={s.file.name} />
                {s.error && <span className="photo-grid__err">{s.error}</span>}
                <button onClick={() => unstage(i)} aria-label={`Remove ${s.file.name}`} disabled={progress !== null}>×</button>
              </div>
            ))}
          </div>
          {progress !== null && <div className="progress" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${progress}%` }} /><span>{progress}%</span></div>}
          <button className="btn btn--primary btn--block" onClick={upload} disabled={!valid.length || progress !== null} data-testid="upload-btn">{progress !== null ? 'Uploading…' : `Upload ${valid.length} photo${valid.length !== 1 ? 's' : ''}`}</button>
        </div>
      )}
      {err && <div className="form-error" role="alert" style={{ marginTop: '.6rem' }}>{err}</div>}

      <h3 className="subhead">Current photos ({images.length})</h3>
      {images.length === 0 ? <Empty>No photos yet. Photos appear on the home screen and when choosing this hall for a booking.</Empty> : (
        <div className="photo-list">
          {images.map((im, i) => (
            <div className="photo-card" key={im.id}>
              <img src={im.thumbUrl} alt={`${hall.name} photo ${i + 1}`} loading="lazy" />
              {im.isCover && <span className="photo-card__cover">Cover</span>}
              <div className="photo-card__bar">
                <button onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move earlier"><Icon name="arrowL" size={16} /></button>
                <button onClick={() => move(i, 1)} disabled={i === images.length - 1} aria-label="Move later"><Icon name="arrowR" size={16} /></button>
                <button onClick={() => run(() => api.patch(`/api/halls/${hall.id}/images/${im.id}`, { isCover: true }), 'Cover photo set')} disabled={im.isCover} aria-label="Set as cover"><Icon name="star" size={16} /></button>
                <button onClick={() => { replaceFor.current = im.id; replaceInput.current.click() }} aria-label="Replace photo"><Icon name="upload" size={16} /></button>
                <button className="danger" onClick={() => setDel(im)} aria-label="Delete photo"><Icon name="trash" size={16} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
      <input ref={replaceInput} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { doReplace(e.target.files[0]); e.target.value = '' }} />
      {progress !== null && staged.length === 0 && <div className="progress"><div style={{ width: `${progress}%` }} /><span>{progress}%</span></div>}
      {del && <Confirm title="Delete this photo?" message="The photo is removed permanently." confirmLabel="Delete" danger onClose={() => setDel(null)} onConfirm={() => run(() => api.del(`/api/halls/${hall.id}/images/${del.id}`), 'Photo deleted')} />}
    </div>
  )
}

function Blackouts({ hall }) {
  const { reloadHalls } = useApp()
  const toast = useToast()
  const [f, setF] = useState({ startDate: todayStr(), endDate: todayStr(), reason: '' })
  const [err, setErr] = useState('')
  const add = async () => {
    setErr('')
    if (f.endDate < f.startDate) return setErr('End date must be on or after the start date')
    try { await api.post(`/api/halls/${hall.id}/blackouts`, f); await reloadHalls(); setF({ ...f, reason: '' }); toast('Unavailable period added') } catch (e) { setErr(errMsg(e)) }
  }
  return (
    <div style={{ marginTop: '.8rem' }}>
      <p className="form-hint">Block dates when this hall cannot be booked (maintenance, holidays). Existing bookings are not affected.</p>
      {hall.blackouts.length === 0 && <Empty>No unavailable periods.</Empty>}
      {hall.blackouts.map((b) => (
        <div className="inv-row" key={b.id}><div><strong>{fmtDate(b.startDate)}{b.endDate !== b.startDate ? ` → ${fmtDate(b.endDate)}` : ''}</strong><div className="form-hint" style={{ margin: 0 }}>{b.reason || 'No reason given'}</div></div>
          <button className="btn btn--sm btn--text danger" onClick={async () => { try { await api.del(`/api/halls/${hall.id}/blackouts/${b.id}`); await reloadHalls() } catch (e) { toast(errMsg(e), 'error') } }}>Remove</button></div>
      ))}
      <div className="form" style={{ marginTop: '.8rem' }}>
        <div className="form-row">
          <Field label="From"><input type="date" value={f.startDate} min={todayStr()} onChange={(e) => setF({ ...f, startDate: e.target.value, endDate: e.target.value > f.endDate ? e.target.value : f.endDate })} /></Field>
          <Field label="To"><input type="date" value={f.endDate} min={f.startDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></Field>
        </div>
        <Field label="Reason"><input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="e.g. Maintenance" maxLength={200} /></Field>
        {err && <div className="form-error" role="alert">{err}</div>}
        <button className="btn btn--outline" onClick={add}>Add unavailable period</button>
      </div>
    </div>
  )
}
