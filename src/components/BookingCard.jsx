import { fmtDate, fmtRange, initials, PAY_LABEL } from '../utils'

export default function BookingCard({ b, onOpen, showPay = true }) {
  const cancelled = b.status === 'cancelled'
  const st = b.money?.state
  return (
    <div className={`booking-card ${cancelled ? 'booking-card--cancelled' : ''}`} onClick={() => onOpen(b.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen(b.id)}>
      <div className="booking-card__avatar">{initials(b.customer.name)}</div>
      <div className="booking-card__info">
        <div className="booking-card__name">{b.customer.name}</div>
        <div className="booking-card__meta">
          <span>{b.date ? fmtDate(b.date) : 'Date not set'}</span>
          <span>{fmtRange(b.startTime, b.endTime, b.endsNextDay)}</span>
          <span>{b.hallName}</span>
        </div>
        <div className="booking-card__tags">
          <span className="tag tag--event">{b.eventType}</span>
          {cancelled ? (
            <span className="tag tag--status-cancelled">Cancelled</span>
          ) : (
            <>
              {showPay && st !== 'none' && <span className={`tag tag--pay-${st === 'overpaid' ? 'paid' : st}`}>{PAY_LABEL[st]}</span>}
              {showPay && b.money?.pending > 0 && <span className="tag tag--warn">Verify payment</span>}
              {b.foodStatus === 'confirmed' ? <span className="tag tag--status-food-confirmed">Food ✓</span> : <span className="tag tag--status-food-pending">Food Pending</span>}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
