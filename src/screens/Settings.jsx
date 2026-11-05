import { useState } from 'react'
import { api, errMsg } from '../api'
import { Async, AsyncButton, Confirm, Field, useToast } from '../components/common'
import { useApp, useLoad } from '../store'
import { cap } from '../utils'

export default function Settings() {
  const { can } = useApp()
  const res = useLoad(() => api.get('/api/settings'), [])
  const edit = can('settings.edit')
  return (
    <div className="settings">
      <h2 className="section__title" style={{ marginBottom: '.85rem' }}>Settings</h2>
      {!edit && <p className="form-hint">You can view these settings. Only an administrator can change them.</p>}
      <Async res={res}>
        {(s) => (
          <>
            <BusinessForm initial={s.business} edit={edit} />
            <FinanceForm initial={s.finance} edit={edit} />
            {s.notifications && <NotificationForm initial={s.notifications} edit={edit} />}
            {can('notifications.config') && <Templates />}
            {edit && <ServiceOptions />}
            {can('data.admin') && <DataTools />}
          </>
        )}
      </Async>
    </div>
  )
}

function useSave(key, reload) {
  const toast = useToast()
  const { reloadSettings } = useApp()
  return async (body) => {
    try { await api.put(`/api/settings/${key}`, body); await reloadSettings(); toast('Settings saved'); reload?.(); return true } catch (e) { toast(errMsg(e), 'error'); return false }
  }
}

function BusinessForm({ initial, edit }) {
  const [s, setS] = useState({ legalName: '', email: '', taxId: '', invoiceFooter: '', terms: '', bankDetails: '', ...initial })
  const save = useSave('business')
  const set = (k) => (e) => setS({ ...s, [k]: e.target.value })
  return (
    <fieldset className="fs" disabled={!edit}><legend>Restaurant & invoice details</legend>
      <div className="form">
        <Field label="Restaurant name"><input value={s.name} onChange={set('name')} /></Field>
        <Field label="Legal / registered name"><input value={s.legalName} onChange={set('legalName')} /></Field>
        <div className="form-row"><Field label="Phone"><input type="tel" value={s.phone} onChange={set('phone')} /></Field><Field label="Email"><input type="email" value={s.email} onChange={set('email')} /></Field></div>
        <Field label="Address (printed on invoices)"><textarea rows={2} value={s.address} onChange={set('address')} /></Field>
        <Field label="GSTIN / Tax ID"><input value={s.taxId} onChange={set('taxId')} /></Field>
        <Field label="Bank details (printed on invoices)" hint="Optional. Never sent in SMS / WhatsApp messages."><textarea rows={2} value={s.bankDetails} onChange={set('bankDetails')} /></Field>
        <Field label="Terms & conditions"><textarea rows={3} value={s.terms} onChange={set('terms')} /></Field>
        <Field label="Invoice footer"><input value={s.invoiceFooter} onChange={set('invoiceFooter')} /></Field>
        {edit && <AsyncButton onClick={() => save(s)}>Save</AsyncButton>}
      </div>
    </fieldset>
  )
}

function FinanceForm({ initial, edit }) {
  const [s, setS] = useState({ invoicePrefix: 'INV', quotationPrefix: 'QT', advanceMinPercent: 0, quotationValidDays: 7, ...initial })
  const save = useSave('finance')
  const set = (k) => (e) => setS({ ...s, [k]: e.target.value })
  return (
    <fieldset className="fs" disabled={!edit}><legend>Tax & numbering</legend>
      <div className="form">
        <div className="form-row"><Field label="Tax label"><input value={s.taxLabel} onChange={set('taxLabel')} /></Field><Field label="Default tax rate (%)"><input type="number" min={0} max={100} step="any" value={s.defaultTaxRate} onChange={set('defaultTaxRate')} /></Field></div>
        <div className="form-row"><Field label="Invoice prefix" hint="Capital letters/digits"><input value={s.invoicePrefix} onChange={set('invoicePrefix')} /></Field><Field label="Quotation prefix"><input value={s.quotationPrefix} onChange={set('quotationPrefix')} /></Field></div>
        <div className="form-row"><Field label="Minimum advance (%)"><input type="number" min={0} max={100} value={s.advanceMinPercent} onChange={set('advanceMinPercent')} /></Field><Field label="Quotation valid for (days)"><input type="number" min={1} max={90} value={s.quotationValidDays} onChange={set('quotationValidDays')} /></Field></div>
        <p className="form-hint">Invoice numbers are sequential per financial year (April–March) and never reused.</p>
        {edit && <AsyncButton onClick={() => save({ ...s, defaultTaxRate: parseFloat(s.defaultTaxRate) || 0, advanceMinPercent: parseFloat(s.advanceMinPercent) || 0, quotationValidDays: parseInt(s.quotationValidDays, 10) || 7 })}>Save</AsyncButton>}
      </div>
    </fieldset>
  )
}

function NotificationForm({ initial, edit }) {
  const { can } = useApp()
  const [s, setS] = useState(initial)
  const save = useSave('notifications')
  const status = useLoad(() => (can('notifications.config') ? api.get('/api/settings/providers/status') : Promise.resolve(null)), [])
  const p = status.data?.providers
  return (
    <fieldset className="fs" disabled={!edit}><legend>Customer messages (SMS / WhatsApp / email)</legend>
      <div className="form">
        <label className="consent"><input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} /><span>Send customer messages (master switch — off means nothing is sent)</span></label>
        <label className="consent"><input type="checkbox" checked={s.sendBill !== false} onChange={(e) => setS({ ...s, sendBill: e.target.checked })} /><span>Send the <strong>bill</strong> automatically when a booking or order is paid in full (text + email with the invoice PDF)</span></label>
        <label className="consent"><input type="checkbox" checked={s.sendThankYou !== false} onChange={(e) => setS({ ...s, sendThankYou: e.target.checked })} /><span>Send a <strong>thank-you</strong> message after the event / delivery</span></label>
        <div className="form-row">
          <Field label="Thank-you delay (hours after the event ends)"><input type="number" min={0} max={72} value={s.thankYouDelayHours ?? 2} onChange={(e) => setS({ ...s, thankYouDelayHours: e.target.value })} /></Field>
          <Field label="Email provider"><select value={s.emailProvider || 'mock'} onChange={(e) => setS({ ...s, emailProvider: e.target.value })}><option value="mock">Test mode (sends nothing)</option><option value="smtp">Email server (SMTP)</option></select></Field>
        </div>
        <div className="form-row">
          <Field label="SMS provider"><select value={s.smsProvider} onChange={(e) => setS({ ...s, smsProvider: e.target.value })}><option value="mock">Test mode (sends nothing)</option><option value="twilio">Twilio</option></select></Field>
          <Field label="WhatsApp provider"><select value={s.whatsappProvider} onChange={(e) => setS({ ...s, whatsappProvider: e.target.value })}><option value="mock">Test mode (sends nothing)</option><option value="twilio">Twilio</option><option value="meta">Meta WhatsApp Cloud</option></select></Field>
        </div>
        <div className="form-row">
          <Field label="Default channel"><select value={s.defaultChannel} onChange={(e) => setS({ ...s, defaultChannel: e.target.value })}><option value="sms">SMS</option><option value="whatsapp">WhatsApp</option></select></Field>
          <Field label="Max send attempts"><input type="number" min={1} max={10} value={s.maxAttempts} onChange={(e) => setS({ ...s, maxAttempts: e.target.value })} /></Field>
        </div>
        <label className="consent"><input type="checkbox" checked={s.notifyOnSignificantChange} onChange={(e) => setS({ ...s, notifyOnSignificantChange: e.target.checked })} /><span>Tell the customer when date, time or hall changes on a confirmed booking</span></label>
        {p && (
          <div className="provider-status" role="status">
            <strong>Server credentials (set in the server .env, never here):</strong>
            <ul>{[['Twilio SMS', p.twilioSms], ['Twilio WhatsApp', p.twilioWhatsapp], ['Meta WhatsApp', p.metaWhatsapp], ['Email server (SMTP)', p.smtpEmail], ['Payment gateway webhook', p.paymentWebhook]].map(([l, ok]) => <li key={l}>{ok ? '✅' : '⚪'} {l}: {ok ? 'configured' : 'not configured'}</li>)}</ul>
            {(s.smsProvider === 'twilio' && !p.twilioSms) || (s.whatsappProvider === 'twilio' && !p.twilioWhatsapp) || (s.whatsappProvider === 'meta' && !p.metaWhatsapp) || (s.emailProvider === 'smtp' && !p.smtpEmail) ? <div className="form-error">The selected provider has no credentials on the server — messages will fail until they are configured.</div> : null}
          </div>
        )}
        {edit && <AsyncButton onClick={() => save({ ...s, maxAttempts: parseInt(s.maxAttempts, 10) || 5, thankYouDelayHours: parseInt(s.thankYouDelayHours, 10) || 0, emailProvider: s.emailProvider || 'mock', sendBill: s.sendBill !== false, sendThankYou: s.sendThankYou !== false })}>Save</AsyncButton>}
      </div>
    </fieldset>
  )
}

const TPL_LABEL = { booking_confirmation: 'Booking confirmation', booking_changed: 'Booking change notice', catering_confirmation: 'Catering confirmation', bill_ready: 'Bill (invoice ready)', thank_you: 'Thank-you' }
function Templates() {
  const toast = useToast()
  const res = useLoad(() => api.get('/api/notification-templates'), [])
  const [sel, setSel] = useState(null)
  return (
    <fieldset className="fs"><legend>Message templates</legend>
      <Async res={res}>
        {({ templates }) => {
          const t = templates.find((x) => x.id === sel) || null
          return (
            <div className="form">
              <Field label="Template"><select value={sel || ''} onChange={(e) => setSel(e.target.value || null)}><option value="">Choose…</option>{templates.map((x) => <option key={x.id} value={x.id}>{TPL_LABEL[x.key] || cap(x.key)} · {x.channel === 'whatsapp' ? 'WhatsApp' : x.channel === 'email' ? 'Email' : 'SMS'} · {x.language === 'ta' ? 'Tamil' : 'English'}</option>)}</select></Field>
              {t && <TemplateEditor key={t.id} t={t} onSaved={() => { toast('Template saved'); res.reload() }} />}
            </div>
          )
        }}
      </Async>
    </fieldset>
  )
}
function TemplateEditor({ t, onSaved }) {
  const toast = useToast()
  const [body, setBody] = useState(t.body)
  const [subject, setSubject] = useState(t.subject || '')
  const [name, setName] = useState(t.providerTemplateName || '')
  const [active, setActive] = useState(t.active)
  return (
    <>
      {t.channel === 'email' && <Field label="Email subject"><input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} /></Field>}
      <Field label="Message text" hint={`Placeholders: ${(t.variables || []).map((v) => `{{${v}}}`).join(' ')}`}><textarea rows={9} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
      {t.language === 'ta' && <p className="form-hint">Tamil text should be reviewed by a native speaker before going live.</p>}
      {t.channel === 'whatsapp' && <Field label="Approved provider template name" hint="Required by WhatsApp Business for business-initiated messages."><input value={name} onChange={(e) => setName(e.target.value)} /></Field>}
      {t.key === 'bill_ready' && t.channel !== 'email' && <p className="form-hint">{'{{bill_note}}'} says whether the invoice was also emailed.</p>}
      <label className="consent"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /><span>Template active</span></label>
      <AsyncButton onClick={async () => { try { await api.put(`/api/notification-templates/${t.id}`, { body, subject: t.channel === 'email' ? subject : undefined, providerTemplateName: name || null, active }); onSaved() } catch (e) { toast(errMsg(e), 'error') } }}>Save template</AsyncButton>
    </>
  )
}

function ServiceOptions() {
  const { options, reloadOptions } = useApp()
  const toast = useToast()
  const [edits, setEdits] = useState({})
  const val = (o, k) => edits[o.id]?.[k] ?? o[k]
  const set = (o, k, v) => setEdits((e) => ({ ...e, [o.id]: { ...e[o.id], [k]: v } }))
  return (
    <fieldset className="fs"><legend>Bulk catering service options</legend>
      <p className="form-hint">Rename or describe the three service types as you like. Option marked “needs vendor” requires an external partner before preparation starts.</p>
      {options.map((o) => (
        <div className="opt-edit" key={o.id}>
          <strong>Option {o.code}</strong>
          <input value={val(o, 'name')} onChange={(e) => set(o, 'name', e.target.value)} aria-label={`Name of option ${o.code}`} />
          <textarea rows={2} value={val(o, 'description')} onChange={(e) => set(o, 'description', e.target.value)} aria-label={`Description of option ${o.code}`} />
          <label className="consent"><input type="checkbox" checked={val(o, 'requiresVendor')} onChange={(e) => set(o, 'requiresVendor', e.target.checked)} /><span>Needs an external vendor</span></label>
          <label className="consent"><input type="checkbox" checked={val(o, 'active')} onChange={(e) => set(o, 'active', e.target.checked)} /><span>Available for new orders</span></label>
          <AsyncButton className="btn btn--outline btn--sm" disabled={!edits[o.id]} onClick={async () => { try { await api.patch(`/api/catering/options/${o.id}`, edits[o.id]); await reloadOptions(); setEdits((e) => ({ ...e, [o.id]: undefined })); toast('Option saved') } catch (e) { toast(errMsg(e), 'error') } }}>Save option {o.code}</AsyncButton>
        </div>
      ))}
    </fieldset>
  )
}

function DataTools() {
  const toast = useToast()
  const [file, setFile] = useState(null)
  const [report, setReport] = useState(null)
  const [confirm, setConfirm] = useState(false)
  const [err, setErr] = useState('')

  const download = async () => {
    try {
      const r = await fetch('/api/admin/export', { credentials: 'same-origin', headers: { 'X-Requested-With': 'rhr' } })
      if (!r.ok) throw new Error('Export failed')
      const blob = await r.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `rhr-export-${new Date().toLocaleDateString('en-CA')}.json`
      a.click()
      URL.revokeObjectURL(a.href)
      toast('Export downloaded')
    } catch (e) { toast(errMsg(e), 'error') }
  }
  const pick = async (e) => {
    const f = e.target.files[0]
    e.target.value = ''
    setReport(null); setErr(''); setFile(null)
    if (!f) return
    try { const data = JSON.parse(await f.text()); setFile(data); setReport((await api.post('/api/admin/import-legacy?dryRun=1', data)).report) } catch (x) { setErr(x instanceof SyntaxError ? 'That file is not valid JSON' : errMsg(x)) }
  }
  const run = async () => { try { setReport((await api.post('/api/admin/import-legacy', file)).report); setFile(null); toast('Import complete') } catch (e) { setErr(errMsg(e)) } }
  return (
    <fieldset className="fs"><legend>Data, backup & old-data import</legend>
      <div className="settings-block">
        <h3>Export</h3>
        <p>Download a JSON copy of all records (no passwords). For full database backups use <code>npm run backup</code> on the server — see the README.</p>
        <div className="settings-actions"><button className="btn btn--outline" onClick={download}>Download export</button></div>
      </div>
      <div className="settings-block">
        <h3>Import from the old browser-only app</h3>
        <p>Choose the backup file you downloaded from the previous version. You will see a preview first; nothing is saved until you confirm. Importing is safe to repeat — already-imported records are skipped.</p>
        <div className="settings-actions"><label className="btn btn--outline" style={{ cursor: 'pointer' }}>Choose backup file<input type="file" accept="application/json,.json" hidden onChange={pick} /></label></div>
        {err && <div className="form-error" role="alert">{err}</div>}
        {report && (
          <div className="import-report" role="status">
            <strong>{report.dryRun ? 'Preview (nothing saved yet)' : 'Import finished'}</strong>
            <ul>
              <li>Bookings: {report.bookings.imported} {report.dryRun ? 'to import' : 'imported'}, {report.bookings.alreadyPresent} already present, {report.bookings.skipped.length} skipped</li>
              <li>Payments: {report.payments.imported}, skipped {report.payments.skipped} · Customers: {report.customers.created} new</li>
              <li>Halls created: {report.halls.created} · Menu items added: {report.menu.created}</li>
            </ul>
            {report.bookings.skipped.length > 0 && <details><summary>Skipped bookings</summary><ul>{report.bookings.skipped.map((s, i) => <li key={i}>{s.booking}: {s.reason}</li>)}</ul></details>}
            {report.bookings.importedAsCancelled.length > 0 && <details open><summary>Overlaps found in old data (kept as cancelled)</summary><ul>{report.bookings.importedAsCancelled.map((s, i) => <li key={i}>{s.booking}</li>)}</ul></details>}
            {report.warnings.length > 0 && <details><summary>{report.warnings.length} notes</summary><ul>{report.warnings.slice(0, 40).map((w, i) => <li key={i}>{w}</li>)}</ul></details>}
            {report.dryRun && file && <button className="btn btn--primary" onClick={() => setConfirm(true)}>Import now</button>}
          </div>
        )}
      </div>
      {confirm && <Confirm title="Import old data?" message="The records shown in the preview will be added. Existing records are never overwritten." confirmLabel="Import" onClose={() => setConfirm(false)} onConfirm={run} />}
    </fieldset>
  )
}
