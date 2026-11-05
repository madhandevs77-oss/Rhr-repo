-- 001_core: users, sessions, settings, counters, audit, halls, customers, bookings
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------- users & sessions ----------
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL,
  name          text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin','manager','staff')),
  active        boolean NOT NULL DEFAULT true,
  failed_logins int NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_lower ON users (lower(username));

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  ip           text,
  user_agent   text
);
CREATE INDEX sessions_user ON sessions (user_id);

-- ---------- settings / counters ----------
CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);

-- Gap-free, transaction-safe counters (booking refs, invoice numbers ...)
CREATE TABLE counters (
  name       text NOT NULL,
  period     text NOT NULL,
  last_value bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (name, period)
);

CREATE FUNCTION next_counter(p_name text, p_period text, p_start bigint DEFAULT 0) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  INSERT INTO counters (name, period, last_value) VALUES (p_name, p_period, p_start + 1)
  ON CONFLICT (name, period) DO UPDATE SET last_value = counters.last_value + 1
  RETURNING last_value INTO v;
  RETURN v;
END $$;

-- ---------- audit (append-only) ----------
CREATE TABLE audit_events (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  user_id     uuid,
  user_name   text,
  action      text NOT NULL,
  entity_type text,
  entity_id   text,
  summary     text,
  details     jsonb,
  ip          text
);
CREATE INDEX audit_entity ON audit_events (entity_type, entity_id);
CREATE INDEX audit_at ON audit_events (at DESC);

CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed (append-only / immutable)', TG_OP, TG_TABLE_NAME USING ERRCODE = '42501';
END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------- halls ----------
CREATE TABLE halls (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  description       text NOT NULL DEFAULT '',
  capacity          int  NOT NULL CHECK (capacity > 0 AND capacity <= 100000),
  facilities        text[] NOT NULL DEFAULT '{}',
  base_price        numeric(12,2) NOT NULL DEFAULT 0 CHECK (base_price >= 0 AND base_price <= 99999999.99),
  active            boolean NOT NULL DEFAULT true,
  availability_note text NOT NULL DEFAULT '',
  legacy_id         text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX halls_name_lower ON halls (lower(name));

CREATE TABLE hall_images (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hall_id       uuid NOT NULL REFERENCES halls(id) ON DELETE CASCADE,
  storage_key   text NOT NULL UNIQUE,           -- server-generated, never the uploaded filename
  original_name text,                            -- display only, sanitised
  mime          text NOT NULL,
  size_bytes    int  NOT NULL,
  width         int  NOT NULL,
  height        int  NOT NULL,
  position      int  NOT NULL,
  is_cover      boolean NOT NULL DEFAULT false,
  uploaded_by   uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hall_images_position UNIQUE (hall_id, position) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX hall_images_one_cover ON hall_images (hall_id) WHERE is_cover;

CREATE TABLE hall_blackouts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hall_id    uuid NOT NULL REFERENCES halls(id) ON DELETE CASCADE,
  start_date date NOT NULL,
  end_date   date NOT NULL,
  reason     text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);

-- ---------- customers ----------
CREATE TABLE customers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  phone           text NOT NULL CHECK (phone ~ '^[0-9]{10}$'),
  alt_phone       text CHECK (alt_phone IS NULL OR alt_phone ~ '^[0-9]{10}$'),
  email           text,
  address         text NOT NULL DEFAULT '',
  billing_name    text,
  billing_address text,
  billing_tax_id  text,
  notes           text NOT NULL DEFAULT '',
  language        text NOT NULL DEFAULT 'en' CHECK (language IN ('en','ta')),
  message_consent boolean NOT NULL DEFAULT false,
  consent_at      timestamptz,
  consent_source  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX customers_phone ON customers (phone);
CREATE INDEX customers_name ON customers (lower(name));

-- ---------- bookings ----------
CREATE TABLE bookings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference   text NOT NULL UNIQUE,
  customer_id uuid NOT NULL REFERENCES customers(id),
  hall_id     uuid NOT NULL REFERENCES halls(id),
  event_type  text NOT NULL,
  event_date  date NOT NULL,
  start_time  time NOT NULL,
  end_time    time NOT NULL,
  guests      int  NOT NULL CHECK (guests > 0 AND guests <= 100000),
  hall_charge numeric(12,2) NOT NULL DEFAULT 0 CHECK (hall_charge >= 0 AND hall_charge <= 99999999.99),
  discount    numeric(12,2) NOT NULL DEFAULT 0 CHECK (discount >= 0 AND discount <= 99999999.99),
  tax_rate    numeric(5,2)  NOT NULL DEFAULT 0 CHECK (tax_rate >= 0 AND tax_rate <= 100),
  catering_plates          int CHECK (catering_plates IS NULL OR (catering_plates >= 0 AND catering_plates <= 1000000)),
  catering_price_per_plate numeric(12,2) CHECK (catering_price_per_plate IS NULL OR (catering_price_per_plate >= 0 AND catering_price_per_plate <= 9999999.99)),
  catering_notes text NOT NULL DEFAULT '',
  food_items  jsonb NOT NULL DEFAULT '[]',
  food_status text NOT NULL DEFAULT 'pending' CHECK (food_status IN ('pending','confirmed')),
  notes       text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'tentative' CHECK (status IN ('tentative','confirmed','cancelled','completed')),
  cancelled_at  timestamptz,
  cancel_reason text,
  version     int NOT NULL DEFAULT 1,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  starts_at   timestamp GENERATED ALWAYS AS (event_date + start_time) STORED,
  ends_at     timestamp GENERATED ALWAYS AS (event_date + end_time) STORED,
  CONSTRAINT bookings_time_order CHECK (end_time > start_time),
  -- THE double-booking guard: no two non-cancelled bookings may overlap in the same hall.
  -- Half-open ranges [start,end) so back-to-back bookings are allowed.
  CONSTRAINT bookings_no_overlap EXCLUDE USING gist
    (hall_id WITH =, tsrange(starts_at, ends_at, '[)') WITH &&) WHERE (status <> 'cancelled')
);
CREATE INDEX bookings_date ON bookings (event_date);
CREATE INDEX bookings_customer ON bookings (customer_id);
CREATE INDEX bookings_status ON bookings (status);

CREATE TABLE booking_charges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  description text NOT NULL,
  quantity    numeric(10,2) NOT NULL CHECK (quantity > 0 AND quantity <= 1000000),
  unit_price  numeric(12,2) NOT NULL CHECK (unit_price >= 0 AND unit_price <= 99999999.99),
  position    int NOT NULL DEFAULT 0
);
CREATE INDEX booking_charges_booking ON booking_charges (booking_id);

CREATE TABLE booking_changes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   uuid NOT NULL REFERENCES bookings(id),
  from_version int NOT NULL,
  to_version   int NOT NULL,
  changed_by   uuid REFERENCES users(id),
  changed_by_name text,
  changed_at   timestamptz NOT NULL DEFAULT now(),
  summary      text NOT NULL,
  changes      jsonb NOT NULL,
  total_before numeric(12,2),
  total_after  numeric(12,2),
  reason       text
);
CREATE INDEX booking_changes_booking ON booking_changes (booking_id, to_version);
CREATE TRIGGER booking_changes_append_only BEFORE UPDATE OR DELETE ON booking_changes
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------- menu ----------
CREATE TABLE menu_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  category   text NOT NULL,
  unit       text NOT NULL DEFAULT 'plate' CHECK (unit IN ('plate','kg','litre','piece','tray','packet')),
  unit_price numeric(12,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0 AND unit_price <= 9999999.99),
  meal_types text[] NOT NULL DEFAULT '{}',
  active     boolean NOT NULL DEFAULT true,
  sort       int NOT NULL DEFAULT 0,
  legacy_id  text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX menu_items_cat_name ON menu_items (category, lower(name));
