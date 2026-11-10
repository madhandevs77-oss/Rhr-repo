-- Outsource bookings are either delivered (needs an address) or collected (takeaway).
ALTER TABLE bookings ADD COLUMN fulfilment text CHECK (fulfilment IS NULL OR fulfilment IN ('delivery','takeaway'));
ALTER TABLE bookings ADD COLUMN delivery_address text NOT NULL DEFAULT '';
ALTER TABLE bookings ADD CONSTRAINT bookings_delivery_needs_address
  CHECK (fulfilment IS DISTINCT FROM 'delivery' OR btrim(delivery_address) <> '');
