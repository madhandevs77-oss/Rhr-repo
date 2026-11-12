import { fmt } from '../utils'

export const SPLIT_METHODS = ['Cash', 'GPay', 'UPI', 'Card']

/** Initial state: one method ticked, no amounts. `sel` maps method -> amount string. */
export const initialSplit = () => ({ Cash: '' })

/**
 * Checkbox per payment method with its own amount. Ticking one method alone needs no amount (it takes the full payment).
 * Returns { splits, error } for the API: splits always add up to `amount`.
 */
export function buildSplits(sel, amount) {
  const methods = Object.keys(sel)
  if (!methods.length) return { error: 'Choose at least one payment method' }
  if (methods.length === 1) return { splits: [{ method: methods[0], amount }] }
  let sum = 0
  for (const m of methods) {
    const v = parseFloat(sel[m])
    if (!(v > 0)) return { error: `Enter a positive amount for ${m}` }
    sum += v
  }
  if (Math.round(sum * 100) !== Math.round(amount * 100)) return { error: `Method amounts add up to ${fmt(sum)} but the payment is ${fmt(amount)}` }
  return { splits: methods.map((m) => ({ method: m, amount: parseFloat(sel[m]) })) }
}

export default function SplitPay({ amount, sel, onChange, methods: choices = SPLIT_METHODS }) {
  const methods = Object.keys(sel)
  const sum = methods.reduce((s, m) => s + (parseFloat(sel[m]) || 0), 0)
  const toggle = (m) => {
    const n = { ...sel }
    if (m in n) delete n[m]
    else n[m] = ''
    onChange(n)
  }
  const multi = methods.length > 1
  const diff = Math.round((amount - sum) * 100) / 100
  return (
    <fieldset className="splitpay">
      <legend>Payment method(s)</legend>
      {choices.map((m) => (
        <div className="splitpay__row" key={m}>
          <label className="splitpay__check"><input type="checkbox" checked={m in sel} onChange={() => toggle(m)} /><span>{m}</span></label>
          {m in sel && multi && <input type="number" inputMode="decimal" min="0" step="any" placeholder="₹ amount" aria-label={`${m} amount`} value={sel[m]} onChange={(e) => onChange({ ...sel, [m]: e.target.value })} />}
        </div>
      ))}
      {multi && (
        <div className={`splitpay__total ${Math.abs(diff) < 0.005 ? 'ok' : 'bad'}`} aria-live="polite">
          Split total {fmt(sum)} of {fmt(amount || 0)}{Math.abs(diff) < 0.005 ? ' ✓' : diff > 0 ? ` — ${fmt(diff)} left to assign` : ` — ${fmt(-diff)} too much`}
        </div>
      )}
    </fieldset>
  )
}
