-- Shared rate-limit counters (all app instances use the same PostgreSQL, so limits hold across several ECS tasks).
CREATE TABLE rate_limits (
  key       text PRIMARY KEY,
  hits      int NOT NULL,
  reset_at  timestamptz NOT NULL
);
CREATE INDEX rate_limits_reset_at ON rate_limits (reset_at);
