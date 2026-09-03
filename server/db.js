import pg from 'pg'
import dotenv from 'dotenv'

dotenv.config()

const { Pool } = pg

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
})

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS browser_users (
      browser_id TEXT PRIMARY KEY,
      user_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)

  await pool.query(`
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
  `)

  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'ratings'
          AND column_name = 'greenness'
          AND data_type <> 'numeric'
      ) THEN
        ALTER TABLE ratings
          ALTER COLUMN greenness TYPE NUMERIC(4,1)
          USING ROUND(greenness::NUMERIC, 1);
      END IF;
    END $$;
  `)

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE table_schema = 'public'
          AND table_name = 'ratings'
          AND constraint_name = 'ratings_greenness_check'
      ) THEN
        ALTER TABLE ratings
          ADD CONSTRAINT ratings_greenness_check
          CHECK (greenness >= 0 AND greenness <= 100);
      END IF;
    END $$;
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ratings_user_name_created_at
    ON ratings (user_name, created_at DESC);
  `)

  // Stable accounts identified by email, decoupled from any single browser/device.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      user_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_user_name_lower
    ON accounts (LOWER(user_name));
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_accounts_email
    ON accounts (email);
  `)

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'accounts'
          AND column_name = 'google_id'
      ) THEN
        ALTER TABLE accounts ADD COLUMN google_id TEXT;
      END IF;
    END $$;
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_accounts_google_id
    ON accounts (google_id);
  `)

  // Single-use magic-link tokens for passwordless sign-in and account linking/migration.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS login_tokens (
      token_hash TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      user_name TEXT,
      purpose TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_login_tokens_email ON login_tokens (email);
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_login_tokens_expires_at
    ON login_tokens (expires_at);
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_browser_users_user_name
    ON browser_users (user_name);
  `)

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'ratings'
          AND column_name = 'flavor_preferences'
      ) THEN
        ALTER TABLE ratings
          ADD COLUMN flavor_preferences JSONB DEFAULT '{}';
      END IF;
    END $$;
  `)

  // User preferences for personalized filtering and recommendations
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE REFERENCES accounts(email) ON DELETE CASCADE,
      flavors JSONB DEFAULT '[]',
      milk_type JSONB DEFAULT '[]',
      visited_countries JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_user_preferences_email
    ON user_preferences (email);
  `)

  // Follow relationships for social features
  await pool.query(`
    CREATE TABLE IF NOT EXISTS follows (
      id BIGSERIAL PRIMARY KEY,
      follower_email TEXT NOT NULL REFERENCES accounts(email) ON DELETE CASCADE,
      following_email TEXT NOT NULL REFERENCES accounts(email) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(follower_email, following_email),
      CHECK (follower_email != following_email)
    );
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_follows_follower
    ON follows (follower_email);
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_follows_following
    ON follows (following_email);
  `)

  // Likes on ratings for social engagement
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rating_likes (
      id BIGSERIAL PRIMARY KEY,
      rating_id BIGINT NOT NULL REFERENCES ratings(id) ON DELETE CASCADE,
      email TEXT NOT NULL REFERENCES accounts(email) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(rating_id, email)
    );
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_rating_likes_rating
    ON rating_likes (rating_id);
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_rating_likes_email
    ON rating_likes (email);
  `)
}
