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
