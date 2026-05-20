-- 004: Create spin_wheels table
CREATE TABLE IF NOT EXISTS spin_wheels (
  id                          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by                  UUID          NOT NULL REFERENCES users(id),
  status                      VARCHAR(20)   NOT NULL DEFAULT 'waiting'
                                            CHECK (status IN ('waiting', 'spinning', 'completed', 'aborted')),
  entry_fee_snapshot          NUMERIC(18,2) NOT NULL,
  winner_pool_percent_snapshot NUMERIC(5,2) NOT NULL,
  admin_pool_percent_snapshot  NUMERIC(5,2) NOT NULL,
  app_pool_percent_snapshot    NUMERIC(5,2) NOT NULL,
  winner_pool_accumulated     NUMERIC(18,2) NOT NULL DEFAULT 0.00,
  admin_pool_accumulated      NUMERIC(18,2) NOT NULL DEFAULT 0.00,
  app_pool_accumulated        NUMERIC(18,2) NOT NULL DEFAULT 0.00,
  winner_user_id              UUID          REFERENCES users(id),
  started_at                  TIMESTAMPTZ,
  completed_at                TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ   DEFAULT now(),
  updated_at                  TIMESTAMPTZ   DEFAULT now()
);

-- Now that spin_wheels exists, add the deferred FK from transactions
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'transactions_spin_wheel_id_fkey'
  ) THEN
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_spin_wheel_id_fkey
      FOREIGN KEY (spin_wheel_id) REFERENCES spin_wheels(id);
  END IF;
END $$;
