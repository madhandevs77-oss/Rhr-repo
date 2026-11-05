-- 004_notifications: durable outbox, delivery attempts, templates

CREATE TABLE notification_templates (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key                    text NOT NULL,            -- booking_confirmation | booking_changed | catering_confirmation ...
  channel                text NOT NULL CHECK (channel IN ('sms','whatsapp')),
  language               text NOT NULL CHECK (language IN ('en','ta')),
  body                   text NOT NULL,
  provider_template_name text,                     -- WhatsApp pre-approved template name (if required)
  active                 boolean NOT NULL DEFAULT true,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (key, channel, language)
);

CREATE TABLE notification_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key     text NOT NULL UNIQUE,        -- e.g. booking_confirmed:<booking id>  => no duplicates
  type                text NOT NULL,
  booking_id          uuid REFERENCES bookings(id),
  catering_order_id   uuid REFERENCES catering_orders(id),
  customer_id         uuid REFERENCES customers(id),
  channel             text NOT NULL CHECK (channel IN ('sms','whatsapp')),
  to_phone            text NOT NULL,               -- E.164
  language            text NOT NULL DEFAULT 'en',
  template_key        text NOT NULL,
  body                text NOT NULL,               -- rendered message (no payment instrument data)
  variables           jsonb NOT NULL DEFAULT '{}',
  status              text NOT NULL DEFAULT 'queued' CHECK (status IN
                        ('queued','sending','sent','delivered','failed','dead','skipped')),
  attempts            int NOT NULL DEFAULT 0,
  max_attempts        int NOT NULL DEFAULT 5,
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  locked_until        timestamptz,
  provider            text,
  provider_message_id text,
  last_error          text,
  skipped_reason      text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  delivered_at        timestamptz
);
CREATE INDEX notification_due ON notification_events (next_attempt_at) WHERE status IN ('queued','sending');
CREATE INDEX notification_booking ON notification_events (booking_id);
CREATE INDEX notification_catering ON notification_events (catering_order_id);
CREATE INDEX notification_provider_msg ON notification_events (provider, provider_message_id);

CREATE TABLE notification_attempts (
  id              bigserial PRIMARY KEY,
  event_id        uuid NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
  attempt_no      int NOT NULL,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  outcome         text NOT NULL CHECK (outcome IN ('sent','retryable_error','permanent_error','rate_limited')),
  provider_status text,
  error_code      text,
  error_message   text
);
CREATE INDEX notification_attempts_event ON notification_attempts (event_id);

-- delivery receipts are logged raw (de-duplicated by provider message id + status)
CREATE TABLE notification_receipts (
  id                  bigserial PRIMARY KEY,
  provider            text NOT NULL,
  provider_message_id text NOT NULL,
  status              text NOT NULL,
  error_code          text,
  received_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_message_id, status)
);
