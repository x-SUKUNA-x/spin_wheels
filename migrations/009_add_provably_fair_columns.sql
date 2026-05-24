ALTER TABLE spin_wheels
ADD COLUMN server_seed VARCHAR(255),
ADD COLUMN server_seed_hash VARCHAR(255),
ADD COLUMN client_seed VARCHAR(255),
ADD COLUMN final_hash VARCHAR(255);
