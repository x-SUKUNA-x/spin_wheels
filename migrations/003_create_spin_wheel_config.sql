-- 003: Create spin_wheel_config table (single-row, database-driven config)
CREATE TABLE IF NOT EXISTS spin_wheel_config (
  id                            INTEGER       PRIMARY KEY DEFAULT 1
                                              CHECK (id = 1),
  entry_fee                     NUMERIC(18,2) NOT NULL DEFAULT 10.00,
  winner_pool_percent           NUMERIC(5,2)  NOT NULL DEFAULT 70.00,
  admin_pool_percent            NUMERIC(5,2)  NOT NULL DEFAULT 20.00,
  app_pool_percent              NUMERIC(5,2)  NOT NULL DEFAULT 10.00,
  min_participants              INTEGER       NOT NULL DEFAULT 3,
  auto_start_seconds            INTEGER       NOT NULL DEFAULT 180,
  elimination_interval_seconds  INTEGER       NOT NULL DEFAULT 7,
  updated_at                    TIMESTAMPTZ   DEFAULT now(),

  CONSTRAINT pool_percents_sum_100
    CHECK (winner_pool_percent + admin_pool_percent + app_pool_percent = 100)
);

-- Seed the single config row (skip if it already exists)
INSERT INTO spin_wheel_config (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;
