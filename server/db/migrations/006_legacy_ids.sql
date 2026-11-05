-- 006_legacy_ids: makes the legacy (browser-storage) import safely idempotent and collision-proof.
ALTER TABLE bookings ADD COLUMN legacy_id text;
CREATE UNIQUE INDEX bookings_legacy_id ON bookings (legacy_id) WHERE legacy_id IS NOT NULL;
