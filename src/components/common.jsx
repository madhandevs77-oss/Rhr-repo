import { Children, cloneElement, createContext, isValidElement, useCallback, useContext, useEffect, useId, useRef, useState } from 'react'
//

/* ---------- Toasts ---------- */
const ToastCtx = createContext(() => {})
export const useToast = () => useContext(ToastCtx)

export function ToastProvider({ children, onReady }) {
  const [t, setT] = useState(null)
  const timer = useRef()
  const show = useCallback((message, type = 'success') => {
    clearTimeout(timer.current)
    setT({ message, type, k: Date.now() })
    timer.current = setTimeout(() => setT(null), 2800)
  }, [])
  useEffect(() => {
    onReady?.(show)
  }, [show, onReady])
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {t && (
        <div key={t.k} className={`toast toast--${t.type}`} role="status">
          {t.message}
        </div>
      )}
    </ToastCtx.Provider>
  )
}

/* ---------- Modal ---------- */
export function Modal({ title, onClose, children, footer, small }) {
  useEffect(() => {
    const h = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal__overlay" onClick={onClose} />
      <div className={`modal__content ${small ? 'modal__content--small' : ''}`}>
        <div className="modal__header">
          <h2>{title}</h2>
          <button className="modal__close" onClick={onClose} aria-label="Close">
            <Icon name="x" size={20} />
          </button>
        </div>
        <div className="modal__body">{children}</div>
        {footer && <div className="modal__footer">{footer}</div>}
      </div>
    </div>
  )
}

export function Confirm({ title, message, confirmLabel = 'Confirm', danger, onConfirm, onClose }) {
  return (
    <Modal
      title={title}
      small
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
          <button
            className={`btn ${danger ? 'btn--danger' : 'btn--primary'}`}
            onClick={() => {
              onConfirm()
              onClose()
            }}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="modal__desc">{message}</p>
    </Modal>
  )
}

/* ---------- Icons ---------- */
const PATHS = {
  back: <path d="M15 18l-6-6 6-6" />,
  chevR: <path d="M9 18l6-6-6-6" />,
  chevD: <path d="M6 9l6 6 6-6" />,
  x: <path d="M18 6L6 18M6 6l12 12" />,
  plus: <path d="M12 5v14M5 12h14" />,
  search: (<><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></>),
  home: (<><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" /><polyline points="9,22 9,12 15,12 15,22" /></>),
  cal: (<><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></>),
  food: (<><path d="M18 8h1a4 4 0 010 8h-1" /><path d="M2 8h16v9a4 4 0 01-4 4H6a4 4 0 01-4-4V8z" /></>),
  more: (<><circle cx="12" cy="12" r="1" /><circle cx="12" cy="5" r="1" /><circle cx="12" cy="19" r="1" /></>),
  list: (<><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></>),
  users: (<><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87" /><path d="M16 3.13a4 4 0 010 7.75" /></>),
  chart: (<><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></>),
  file: (<><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14,2 14,8 20,8" /></>),
  gear: (<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" /></>),
  phone: <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" />,
  rupee: (<><line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" /></>),
  edit: (<><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" /></>),
  truck: (<><rect x="1" y="3" width="15" height="13" /><polygon points="16 8 20 8 23 11 23 16 16 16 16 8" /><circle cx="5.5" cy="18.5" r="2.5" /><circle cx="18.5" cy="18.5" r="2.5" /></>),
  printer: (<><polyline points="6 9 6 2 18 2 18 9" /><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2" /><rect x="6" y="14" width="12" height="8" /></>),
  check: <polyline points="20 6 9 17 4 12" />,
  upload: (<><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></>),
  star: <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />,
  arrowL: <path d="M19 12H5M12 19l-7-7 7-7" />,
  arrowR: <path d="M5 12h14M12 5l7 7-7 7" />,
  trash: (<><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" /></>),
}
export function Icon({ name, size = 22 }) {
  if (name === 'wa')
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
        <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
      </svg>
    )
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  )
}

/* ---------- Shared bits ---------- */
export function Empty({ children }) {
  return (
    <div className="empty-state">
      <p>{children}</p>
    </div>
  )
}

export function Field({ label, children, hint }) {
  const id = useId()
  // associate the label with its single input so screen readers (and tests) can find it
  const only = Children.count(children) === 1 && isValidElement(children) && typeof children.type === 'string' ? children : null
  const control = only && !only.props.id ? cloneElement(only, { id }) : children
  return (
    <div className="form-group">
      {label && <label htmlFor={only ? only.props.id || id : undefined}>{label}</label>}
      {control}
      {hint && <span className="form-hint">{hint}</span>}
    </div>
  )
}

export function MonthSelector({ label, onPrev, onNext }) {
  return (
    <div className="month-selector">
      <button className="month-selector__arrow" onClick={onPrev} aria-label="Previous month"><Icon name="back" size={20} /></button>
      <span className="month-selector__month">{label}</span>
      <button className="month-selector__arrow" onClick={onNext} aria-label="Next month"><Icon name="chevR" size={20} /></button>
    </div>
  )
}

/* ---------- Async states ---------- */
export const Spinner = ({ label = 'Loading…' }) => (
  <div className="spinner-wrap" role="status" aria-live="polite"><span className="spinner" aria-hidden="true" /><span>{label}</span></div>
)
export function ErrorState({ error, onRetry }) {
  return (
    <div className="error-state" role="alert">
      <p>{error?.message || 'Something went wrong'}</p>
      {onRetry && <button className="btn btn--outline btn--sm" onClick={onRetry}>Try again</button>}
    </div>
  )
}
/** Renders loading / error / content from a useLoad() result. */
export function Async({ res, children, empty }) {
  if (res.loading && !res.data) return <Spinner />
  if (res.error) return <ErrorState error={res.error} onRetry={res.reload} />
  if (!res.data) return null
  return empty?.(res.data) ? empty(res.data) : children(res.data)
}
/** Button that disables itself while its async onClick runs (prevents double submits). */
export function AsyncButton({ onClick, children, className = 'btn btn--primary', disabled, ...rest }) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      {...rest}
      className={className}
      disabled={busy || disabled}
      onClick={async (e) => {
        setBusy(true)
        try { await onClick(e) } finally { setBusy(false) }
      }}
    >
      {busy ? 'Please wait…' : children}
    </button>
  )
}
export const Tag = ({ kind, children }) => <span className={`tag tag--${kind}`}>{children}</span>

/** ⋮ button that opens a small dropdown of actions. items: [{ label, onClick, danger, disabled }] */
export function KebabMenu({ items, label = 'Actions' }) {
  const [open, setOpen] = useState(false)
  const [up, setUp] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false) }
    const esc = (e) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', close)
    window.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc) }
  }, [open])
  return (
    <span className="kebab" ref={ref}>
      <button type="button" className="kebab__btn" aria-haspopup="menu" aria-expanded={open} aria-label={label} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setUp(window.innerHeight - r.bottom < 250 && r.top > 250); setOpen((v) => !v) }}>⋮</button>
      {open && (
        <div className={`kebab__menu ${up ? 'kebab__menu--up' : ''}`} role="menu">
          {items.filter(Boolean).map((it) => (
            <button type="button" role="menuitem" key={it.label} className={it.danger ? 'danger' : ''} disabled={it.disabled} onClick={() => { setOpen(false); it.onClick() }}>{it.label}</button>
          ))}
        </div>
      )}
    </span>
  )
}
