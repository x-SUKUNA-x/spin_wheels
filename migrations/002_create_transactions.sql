-- 002: Create transactions table
-- NOTE: spin_wheel_id FK is added in 004_create_spin_wheels.sql because
-- the spin_wheels table does not exist yet at this point.
CREATE TABLE IF NOT EXISTS transactions (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID          NOT NULL REFERENCES users(id),
  type            VARCHAR(50)   NOT NULL,
  amount          NUMERIC(18,2) NOT NULL,
  balance_before  NUMERIC(18,2) NOT NULL,
  balance_after   NUMERIC(18,2) NOT NULL,
  spin_wheel_id   UUID,
  description     TEXT,
  created_at      TIMESTAMPTZ   DEFAULT now()
);
