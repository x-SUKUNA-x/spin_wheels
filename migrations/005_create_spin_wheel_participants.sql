-- 005: Create spin_wheel_participants table
CREATE TABLE IF NOT EXISTS spin_wheel_participants (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  spin_wheel_id     UUID        NOT NULL REFERENCES spin_wheels(id),
  user_id           UUID        NOT NULL REFERENCES users(id),
  elimination_order INTEGER,
  eliminated_at     TIMESTAMPTZ,
  joined_at         TIMESTAMPTZ DEFAULT now()
);

-- One user can join a given wheel only once
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'spin_wheel_participants_wheel_user_uniq'
  ) THEN
    ALTER TABLE spin_wheel_participants
      ADD CONSTRAINT spin_wheel_participants_wheel_user_uniq
      UNIQUE (spin_wheel_id, user_id);
  END IF;

  -- No duplicate elimination positions within the same wheel
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'spin_wheel_participants_wheel_order_uniq'
  ) THEN
    ALTER TABLE spin_wheel_participants
      ADD CONSTRAINT spin_wheel_participants_wheel_order_uniq
      UNIQUE (spin_wheel_id, elimination_order);
  END IF;
END $$;
