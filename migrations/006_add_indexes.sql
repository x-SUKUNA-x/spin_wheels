-- 006: Add indexes for query performance

-- Users
CREATE INDEX IF NOT EXISTS idx_users_email    ON users (email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);

-- Spin wheels
CREATE INDEX IF NOT EXISTS idx_spin_wheels_status     ON spin_wheels (status);
CREATE INDEX IF NOT EXISTS idx_spin_wheels_created_by ON spin_wheels (created_by);

-- Spin wheel participants
CREATE INDEX IF NOT EXISTS idx_swp_spin_wheel_id ON spin_wheel_participants (spin_wheel_id);
CREATE INDEX IF NOT EXISTS idx_swp_user_id       ON spin_wheel_participants (user_id);

-- Transactions
CREATE INDEX IF NOT EXISTS idx_transactions_user_id       ON transactions (user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_spin_wheel_id ON transactions (spin_wheel_id);
