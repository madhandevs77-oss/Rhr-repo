-- 003_finance: payments, allocations, invoices (immutable once issued)

CREATE TABLE payments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id        uuid REFERENCES bookings(id),
  catering_order_id uuid REFERENCES catering_orders(id),
  kind              text NOT NULL DEFAULT 'payment' CHECK (kind IN ('payment','refund')),
  refund_of         uuid REFERENCES payments(id),
  amount            numeric(12,2) NOT NULL CHECK (amount > 0 AND amount <= 99999999.99),
  method            text NOT NULL CHECK (method IN ('Cash','UPI','Bank Transfer','Card','Cheque','Other')),
  stage             text NOT NULL DEFAULT 'part' CHECK (stage IN ('advance','part','final','refund')),
  paid_on           date NOT NULL,
  reference         text NOT NULL DEFAULT '',          -- UPI ref / cheque no. / gateway txn id (display)
  notes             text NOT NULL DEFAULT '',
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected','reversed')),
  status_reason     text,
  source            text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','gateway')),
  provider          text,
  external_ref      text,                               -- gateway event/txn id -> idempotency
  idempotency_key   text,
  recorded_by       uuid REFERENCES users(id),
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  verified_by       uuid REFERENCES users(id),
  verified_at       timestamptz,
  CONSTRAINT payments_one_target CHECK ((booking_id IS NOT NULL)::int + (catering_order_id IS NOT NULL)::int = 1),
  CONSTRAINT payments_refund_ref CHECK ((kind = 'refund') = (refund_of IS NOT NULL))
);
CREATE UNIQUE INDEX payments_idem ON payments (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX payments_external ON payments (provider, external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX payments_booking ON payments (booking_id);
CREATE INDEX payments_catering ON payments (catering_order_id);

CREATE TABLE payment_allocations (
  payment_id uuid NOT NULL REFERENCES payments(id),
  bucket     text NOT NULL CHECK (bucket IN ('hall','catering','other')),
  amount     numeric(12,2) NOT NULL CHECK (amount > 0),
  PRIMARY KEY (payment_id, bucket)
);

-- Payments are never deleted and their money fields never change; only status moves forward.
CREATE FUNCTION payments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payments cannot be deleted; reverse them instead' USING ERRCODE = '42501';
  END IF;
  IF NEW.amount <> OLD.amount OR NEW.kind <> OLD.kind OR NEW.booking_id IS DISTINCT FROM OLD.booking_id
     OR NEW.catering_order_id IS DISTINCT FROM OLD.catering_order_id OR NEW.method <> OLD.method
     OR NEW.paid_on <> OLD.paid_on OR NEW.refund_of IS DISTINCT FROM OLD.refund_of THEN
    RAISE EXCEPTION 'payment financial fields are immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('rejected','reversed') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'payment is already %; no further transitions', OLD.status USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'verified' AND NEW.status NOT IN ('verified','reversed') THEN
    RAISE EXCEPTION 'a verified payment can only be reversed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payments_guard_t BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION payments_guard();
CREATE FUNCTION allocations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payment allocations are immutable' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER allocations_guard_t BEFORE UPDATE OR DELETE ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION allocations_guard();

CREATE TABLE invoices (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number    text NOT NULL UNIQUE,
  booking_id        uuid REFERENCES bookings(id),
  catering_order_id uuid REFERENCES catering_orders(id),
  version           int  NOT NULL,
  status            text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','superseded','void')),
  issued_at         timestamptz NOT NULL DEFAULT now(),
  issued_by         uuid REFERENCES users(id),           -- NULL = issued automatically by the system
  issue_trigger     text NOT NULL CHECK (issue_trigger IN ('payment_verified','manual')),
  total             numeric(12,2) NOT NULL,
  paid              numeric(12,2) NOT NULL,
  fingerprint       text NOT NULL,                       -- hash of invoice-relevant booking data at issue time
  snapshot          jsonb NOT NULL,                      -- everything printed on the invoice, frozen
  superseded_by     uuid REFERENCES invoices(id),
  status_reason     text,
  status_changed_at timestamptz,
  status_changed_by uuid REFERENCES users(id),
  CONSTRAINT invoices_one_target CHECK ((booking_id IS NOT NULL)::int + (catering_order_id IS NOT NULL)::int = 1),
  UNIQUE (booking_id, version),
  UNIQUE (catering_order_id, version)
);
-- At most ONE live (issued) invoice per booking / order  => idempotent issuance under races.
CREATE UNIQUE INDEX invoices_one_live_booking  ON invoices (booking_id)        WHERE status = 'issued' AND booking_id IS NOT NULL;
CREATE UNIQUE INDEX invoices_one_live_catering ON invoices (catering_order_id) WHERE status = 'issued' AND catering_order_id IS NOT NULL;

CREATE FUNCTION invoices_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'invoices cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF NEW.invoice_number <> OLD.invoice_number OR NEW.snapshot <> OLD.snapshot OR NEW.total <> OLD.total
     OR NEW.paid <> OLD.paid OR NEW.fingerprint <> OLD.fingerprint OR NEW.version <> OLD.version
     OR NEW.issued_at <> OLD.issued_at OR NEW.booking_id IS DISTINCT FROM OLD.booking_id
     OR NEW.catering_order_id IS DISTINCT FROM OLD.catering_order_id THEN
    RAISE EXCEPTION 'issued invoices are immutable; supersede or void them instead' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'issued' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'invoice is already %', OLD.status USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoices_guard_t BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoices_guard();
