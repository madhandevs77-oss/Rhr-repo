-- Outsource bookings may have no date and/or no time, and an outsource slot may run past midnight (start + 3 h).
-- Existing rows keep their values: columns are only relaxed, and the generated ends_at is recomputed from the same inputs.
ALTER TABLE bookings DROP CONSTRAINT bookings_no_overlap;
ALTER TABLE bookings DROP CONSTRAINT bookings_time_order;
ALTER TABLE bookings DROP COLUMN ends_at;

ALTER TABLE bookings ALTER COLUMN event_date DROP NOT NULL;
ALTER TABLE bookings ALTER COLUMN start_time DROP NOT NULL;
ALTER TABLE bookings ALTER COLUMN end_time   DROP NOT NULL;
ALTER TABLE bookings ADD COLUMN ends_next_day boolean NOT NULL DEFAULT false;

ALTER TABLE bookings ADD COLUMN ends_at timestamp
  GENERATED ALWAYS AS (event_date + end_time + CASE WHEN ends_next_day THEN interval '1 day' ELSE interval '0 day' END) STORED;

-- start and end time are given together; an end earlier than the start is only valid when it falls on the next day
ALTER TABLE bookings ADD CONSTRAINT bookings_time_pair  CHECK ((start_time IS NULL) = (end_time IS NULL));
ALTER TABLE bookings ADD CONSTRAINT bookings_time_order CHECK (start_time IS NULL OR (ends_next_day AND end_time <= start_time) OR (NOT ends_next_day AND end_time > start_time));

-- Only bookings that have a real date AND time take part in overlap checking. (A NULL bound in tsrange means "unbounded", which would
-- wrongly clash with everything, so undated/untimed rows are excluded explicitly.)
ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap EXCLUDE USING gist
  (hall_id WITH =, tsrange(starts_at, ends_at, '[)') WITH &&)
  WHERE (status <> 'cancelled' AND starts_at IS NOT NULL AND ends_at IS NOT NULL);
