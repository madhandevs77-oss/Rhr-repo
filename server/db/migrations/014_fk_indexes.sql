-- Indexes for foreign keys that are looked up on request paths (blackout check per booking, refunds of a payment, a customer's messages).
CREATE INDEX hall_blackouts_hall ON hall_blackouts (hall_id);
CREATE INDEX payments_refund_of ON payments (refund_of) WHERE refund_of IS NOT NULL;
CREATE INDEX notification_events_customer ON notification_events (customer_id);
