CREATE TABLE IF NOT EXISTS browser_users (
  browser_id TEXT PRIMARY KEY,
  user_name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ratings (
  id BIGSERIAL PRIMARY KEY,
  user_name TEXT NOT NULL,
  photo TEXT NOT NULL,
  rating NUMERIC(2,1) NOT NULL CHECK (rating >= 0 AND rating <= 5),
  greenness NUMERIC(4,1) NOT NULL CHECK (greenness >= 0 AND greenness <= 100),
  location TEXT NOT NULL DEFAULT '',
  thoughts TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ratings_user_name_created_at
ON ratings (user_name, created_at DESC);

-- Stable accounts identified by email, decoupled from any single browser/device.
CREATE TABLE IF NOT EXISTS accounts (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  user_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_user_name_lower
ON accounts (LOWER(user_name));

-- Single-use magic-link tokens for passwordless sign-in and account linking/migration.
CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  user_name TEXT,
  purpose TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_login_tokens_email ON login_tokens (email);
