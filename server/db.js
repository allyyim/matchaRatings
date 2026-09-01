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
}
