import { useState } from 'react'
import { Field, Modal } from './common'
import { fmt } from '../utils'

export function ImpactDialog({ impact, onClose, onConfirm, busy }) {
  const req = impact.required || []
  const im = impact.impact || {}
  const [checks, setChecks] = useState({})
  const [reason, setReason] = useState('')
  const needReason = impact.reasonRequired || req.includes('financial')
  const ok = req.every((k) => checks[k]) && (!needReason || reason.trim().length >= 3)
  const LABEL = {
    financial: im.totalChanged ? `I confirm the total changes from ${fmt(im.previousTotal)} to ${fmt(im.newTotal)}.` : 'I confirm these financial changes.',
    schedule: 'I confirm the date / time / hall change. The customer will be notified.',
    invoice: 'I understand the existing invoice will be superseded by a new one (the old invoice stays on record).',
  }
  return (
    <Modal title="Confirm changes" onClose={onClose} footer={<><button className="btn btn--secondary" onClick={onClose}>Back to editing</button><button className="btn btn--primary" disabled={!ok || busy} onClick={() => onConfirm(Object.fromEntries(req.map((k) => [k, true])), reason.trim())}>{busy ? 'Saving…' : 'Confirm & save'}</button></>}>
      <p className="modal__desc">{impact.message}</p>
      {im.previousTotal !== undefined && (
        <div className="impact">
          <div><span>Previous total</span><strong>{fmt(im.previousTotal)}</strong></div>
          <div><span>Revised total</span><strong>{fmt(im.newTotal)}</strong></div>
          <div><span>Difference</span><strong className={im.difference > 0 ? 'up' : 'down'}>{im.difference > 0 ? '+' : ''}{fmt(im.difference)}</strong></div>
          <div><span>Received so far</span><strong>{fmt(im.paid)}</strong></div>
          <div><span>New balance</span><strong>{im.newBalance < 0 ? `Refund due ${fmt(-im.newBalance)}` : fmt(im.newBalance)}</strong></div>
        </div>
      )}
      {req.map((k) => (
        <label className="consent" key={k}><input type="checkbox" checked={!!checks[k]} onChange={(e) => setChecks((c) => ({ ...c, [k]: e.target.checked }))} /><span>{LABEL[k] || k}</span></label>
      ))}
      {needReason && <Field label="Reason for the change *"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Customer added stage decoration" /></Field>}
    </Modal>
  )
}

