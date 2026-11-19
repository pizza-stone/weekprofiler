-- Random browser tokens are stored only as SHA-256 hashes. OAuth states are
-- consumed atomically on callback; bounded cleanup runs whenever login starts.
CREATE TABLE auth_oauth_states (
  state_hash text PRIMARY KEY NOT NULL,
  binding_hash text NOT NULL,
  verifier text NOT NULL,
  nonce text NOT NULL,
  redirect_uri text NOT NULL,
  created_at integer NOT NULL,
  expires_at integer NOT NULL
);
CREATE INDEX auth_oauth_states_expiry ON auth_oauth_states (expires_at);
CREATE INDEX auth_oauth_states_binding ON auth_oauth_states (binding_hash);

CREATE TABLE auth_sessions (
  token_hash text PRIMARY KEY NOT NULL,
  email text NOT NULL,
  subject text NOT NULL,
  client_id text NOT NULL,
  created_at integer NOT NULL,
  expires_at integer NOT NULL
);
CREATE INDEX auth_sessions_expiry ON auth_sessions (expires_at);
