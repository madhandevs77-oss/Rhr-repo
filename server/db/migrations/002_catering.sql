-- 002_catering: bulk catering / food outsourcing (separate from hall bookings; optionally linked)

CREATE TABLE catering_service_options (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                text NOT NULL UNIQUE CHECK (code IN ('A','B','C')),
  name                text NOT NULL,
  description         text NOT NULL DEFAULT '',
  includes_staff      boolean NOT NULL DEFAULT false,
  includes_utensils   boolean NOT NULL DEFAULT false,
  includes_setup      boolean NOT NULL DEFAULT false,
  requires_vendor     boolean NOT NULL DEFAULT false,
  active              boolean NOT NULL DEFAULT true,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vendors (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  contact_person text NOT NULL DEFAULT '',
  phone          text NOT NULL DEFAULT '',
  email          text NOT NULL DEFAULT '',
  address        text NOT NULL DEFAULT '',
  notes          text NOT NULL DEFAULT '',
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vendors_name_lower ON vendors (lower(name));

CREATE TABLE catering_orders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference          text NOT NULL UNIQUE,
  customer_id        uuid NOT NULL REFERENCES customers(id),
  booking_id         uuid REFERENCES bookings(id),          -- optional link; standalone orders allowed
  service_option_id  uuid NOT NULL REFERENCES catering_service_options(id),
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN
                       ('draft','quotation_sent','awaiting_confirmation','confirmed','preparation',
                        'ready_for_dispatch','delivered','completed','cancelled','exception')),
  status_before_exception text,
  exception_reason   text,
  event_type         text NOT NULL,
  event_date         date NOT NULL,
  delivery_time      time,
  serving_time       time,
  venue_name         text NOT NULL DEFAULT '',
  delivery_address   text NOT NULL DEFAULT '',
  guests             int NOT NULL CHECK (guests > 0 AND guests <= 1000000),
  plates             int NOT NULL CHECK (plates > 0 AND plates <= 1000000),
  contact_person     text NOT NULL DEFAULT '',
  contact_phone      text NOT NULL DEFAULT '' CHECK (contact_phone = '' OR contact_phone ~ '^[0-9]{10}$'),
  meal_category      text NOT NULL DEFAULT 'lunch',
  notes              text NOT NULL DEFAULT '',
  dietary_instructions   text NOT NULL DEFAULT '',
  packaging_requirements text NOT NULL DEFAULT '',
  serving_requirements   text NOT NULL DEFAULT '',
  fulfilment_method  text NOT NULL DEFAULT 'delivery' CHECK (fulfilment_method IN ('delivery','pickup')),
  staff_required     boolean NOT NULL DEFAULT false,
  staff_count        int NOT NULL DEFAULT 0 CHECK (staff_count >= 0 AND staff_count <= 10000),
  staff_charge       numeric(12,2) NOT NULL DEFAULT 0 CHECK (staff_charge >= 0 AND staff_charge <= 99999999.99),
  utensils_required  boolean NOT NULL DEFAULT false,
  equipment_notes    text NOT NULL DEFAULT '',
  equipment_charge   numeric(12,2) NOT NULL DEFAULT 0 CHECK (equipment_charge >= 0 AND equipment_charge <= 99999999.99),
  setup_required     boolean NOT NULL DEFAULT false,
  setup_charge       numeric(12,2) NOT NULL DEFAULT 0 CHECK (setup_charge >= 0 AND setup_charge <= 99999999.99),
  delivery_charge    numeric(12,2) NOT NULL DEFAULT 0 CHECK (delivery_charge >= 0 AND delivery_charge <= 99999999.99),
  pricing_mode       text NOT NULL DEFAULT 'per_plate' CHECK (pricing_mode IN ('per_plate','item_based')),
  price_per_plate    numeric(12,2) NOT NULL DEFAULT 0 CHECK (price_per_plate >= 0 AND price_per_plate <= 9999999.99),
  discount           numeric(12,2) NOT NULL DEFAULT 0 CHECK (discount >= 0 AND discount <= 99999999.99),
  tax_rate           numeric(5,2)  NOT NULL DEFAULT 0 CHECK (tax_rate >= 0 AND tax_rate <= 100),
  billing_name       text,
  billing_address    text,
  billing_tax_id     text,
  cancelled_at       timestamptz,
  cancel_reason      text,
  version            int NOT NULL DEFAULT 1,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX catering_orders_date ON catering_orders (event_date);
CREATE INDEX catering_orders_status ON catering_orders (status);
CREATE INDEX catering_orders_customer ON catering_orders (customer_id);
CREATE INDEX catering_orders_booking ON catering_orders (booking_id);

CREATE TABLE catering_order_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES catering_orders(id) ON DELETE CASCADE,
  menu_item_id uuid REFERENCES menu_items(id),
  name         text NOT NULL,
  meal_type    text,
  unit         text NOT NULL DEFAULT 'plate',
  quantity     numeric(10,2) NOT NULL CHECK (quantity > 0 AND quantity <= 1000000),
  unit_price   numeric(12,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0 AND unit_price <= 9999999.99),
  notes        text NOT NULL DEFAULT '',
  position     int NOT NULL DEFAULT 0
);
CREATE INDEX catering_items_order ON catering_order_items (order_id);

CREATE TABLE catering_order_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid NOT NULL REFERENCES catering_orders(id),
  version        int NOT NULL,
  snapshot       jsonb NOT NULL,
  total          numeric(12,2) NOT NULL,
  change_summary text NOT NULL DEFAULT '',
  reason         text,
  changed_by     uuid REFERENCES users(id),
  approved_by    uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, version)
);
CREATE TRIGGER catering_versions_append_only BEFORE UPDATE OR DELETE ON catering_order_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE catering_quotations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         uuid NOT NULL REFERENCES catering_orders(id),
  quotation_number text NOT NULL UNIQUE,
  version          int NOT NULL,
  order_version    int NOT NULL,
  snapshot         jsonb NOT NULL,
  total            numeric(12,2) NOT NULL,
  valid_until      date,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, version)
);
CREATE TRIGGER catering_quotations_append_only BEFORE UPDATE OR DELETE ON catering_quotations
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Vendor costs are kept entirely separate from customer charges.
CREATE TABLE vendor_assignments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         uuid NOT NULL REFERENCES catering_orders(id),
  vendor_id        uuid NOT NULL REFERENCES vendors(id),
  status           text NOT NULL DEFAULT 'proposed' CHECK (status IN
                     ('proposed','quoted','assigned','accepted','declined','in_preparation','ready','delivered','failed','cancelled')),
  is_active        boolean NOT NULL DEFAULT true,
  quote_amount     numeric(12,2) CHECK (quote_amount IS NULL OR (quote_amount >= 0 AND quote_amount <= 99999999.99)),
  agreed_cost      numeric(12,2) CHECK (agreed_cost IS NULL OR (agreed_cost >= 0 AND agreed_cost <= 99999999.99)),
  final_cost       numeric(12,2) CHECK (final_cost IS NULL OR (final_cost >= 0 AND final_cost <= 99999999.99)),
  notes            text NOT NULL DEFAULT '',
  quoted_at        timestamptz,
  assigned_at      timestamptz,
  accepted_at      timestamptz,
  delivered_at     timestamptz,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vendor_assignments_one_active ON vendor_assignments (order_id) WHERE is_active;
CREATE INDEX vendor_assignments_vendor ON vendor_assignments (vendor_id);
