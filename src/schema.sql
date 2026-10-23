CREATE TABLE IF NOT EXISTS slots (
  id         TEXT PRIMARY KEY,
  provider   TEXT        NOT NULL,
  starts_at  TIMESTAMPTZ NOT NULL,
  ends_at    TIMESTAMPTZ NOT NULL,
  start_raw  TEXT        NOT NULL,
  end_raw    TEXT        NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  id         TEXT PRIMARY KEY,
  slot_id    TEXT        NOT NULL,
  name       TEXT        NOT NULL,
  email      TEXT        NOT NULL,
  status     TEXT        NOT NULL CHECK (status IN ('confirmed','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- LEVEL 3: the whole double-booking guarantee. Never SELECT-then-INSERT.
CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_per_slot
  ON bookings (slot_id) WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS bookings_email_page ON bookings (email, created_at, id);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           TEXT PRIMARY KEY,
  body_hash     TEXT        NOT NULL,
  status_code   INT         NOT NULL,
  response_body JSONB       NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rate_limit_attempts (
  email        TEXT        NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS rl_lookup ON rate_limit_attempts (email, attempted_at);
