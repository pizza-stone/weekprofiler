ALTER TABLE planner_states ADD COLUMN timer_revision integer NOT NULL DEFAULT 0;

-- Keep acknowledgements independently of the latest state mutation. A lost
-- response can be retried safely after intervening changes from another device.
CREATE TABLE planner_mutations (
  user_id text NOT NULL,
  mutation_id text NOT NULL,
  request_hash text NOT NULL,
  revision integer NOT NULL,
  created_at integer NOT NULL,
  PRIMARY KEY (user_id, mutation_id)
);
