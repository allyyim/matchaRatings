import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import * as Sentry from '@sentry/node'
import { v2 as cloudinary } from 'cloudinary'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { initDb, pool } from './db.js'
import { requireSession } from './lib/session.js'
import { apiRateLimiter } from './lib/rateLimits.js'
import adminRouter from './routes/admin.routes.js'
import authRouter from './routes/auth.routes.js'
import accountRouter from './routes/account.routes.js'
import ratingsRouter from './routes/ratings.routes.js'
import exploreRouter from './routes/explore.routes.js'
import socialRouter from './routes/social.routes.js'

dotenv.config()

Sentry.init({
  dsn: process.env.SENTRY_DSN || '',
  environment: process.env.NODE_ENV || 'development',
  release: `matcha-ratings@${process.env.npm_package_version || 'dev'}`,
  tracesSampleRate: 1.0,
  enableLogs: true
})

const app = express()
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
app.set('trust proxy', 1)
const port = Number(process.env.PORT || 4000)

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
})

// CORS allowlist. Production frontend lives on GitHub Pages; dev happens
// on Vite's default 5173 / preview 4173 and localhost:3001 for same-origin
// server calls. Anything else is rejected. Env override lets us add extra
// origins (staging, custom domain) without a code change.
const CORS_ALLOWED_ORIGINS = (() => {
  const base = [
    'https://allyyim.github.io',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:4173',
    'http://127.0.0.1:4173',
    'http://localhost:3001',
    'http://127.0.0.1:3001',
  ]
  const extra = String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return new Set([...base, ...extra])
})()

app.disable('x-powered-by')
app.use(cors({
  origin(origin, callback) {
    // No Origin header = same-origin request (e.g. server rendering the
    // built SPA, curl for /health). Allow.
    if (!origin) return callback(null, true)
    if (CORS_ALLOWED_ORIGINS.has(origin)) return callback(null, true)
    return callback(new Error(`Origin ${origin} not allowed by CORS`))
  },
  credentials: true,
}))
app.use(express.json({ limit: '15mb' }))
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('X-XSS-Protection', '0')
  next()
})
app.use('/api', apiRateLimiter)

app.get('/', (_req, res) => {
  res.status(200).send('Matcha Ratings API is running. Use /api/health for health checks.')
})

app.get('/api/health', async (_req, res) => {
  res.json({ ok: true })
})

// Cheap warmup route. External cron pings this every ~10 minutes to keep both
// the Render dyno awake AND the Supabase pooler connection primed, so the
// first user request after opening the app doesn't have to eat a cold start.
// It intentionally does one trivial query so a paused DB gets nudged too.
app.get('/api/warm', async (_req, res) => {
  try {
    await pool.query('SELECT 1')
    return res.json({ ok: true, warm: true })
  } catch (err) {
    // Even on DB error we return 200 so the cron doesn't page us; the point
    // is just to keep the process running.
    console.warn('warm probe: db not reachable yet:', err.message)
    return res.json({ ok: true, warm: false })
  }
})

// Periodic cleanup of expired magic-link tokens. Without this the
// login_tokens table grows forever (every sign-in adds a row). Runs once
// an hour and only touches rows whose expiry is already in the past.
setInterval(() => {
  pool.query(`DELETE FROM login_tokens WHERE expires_at < NOW() - INTERVAL '1 day'`)
    .catch((err) => console.warn('login_tokens cleanup failed:', err.message))
}, 60 * 60 * 1000).unref?.()

// ---------------------------------------------------------------------------
// Router mounting order matters:
//   1. adminRouter   — no session (ops endpoints)
//   2. authRouter    — no session for signup/signin; routes that need session
//                      (link-status, demo/cleanup, link-email) apply
//                      requireSession inline
//   3. auth gate     — everything past this point requires a session
//   4. business + accountRouter — session-protected
// ---------------------------------------------------------------------------

app.use('/api', adminRouter)
app.use('/api', authRouter)

// Auth gate. Any /api request that reaches this middleware is a
// session-protected route; pre-gate routers already handled the public ones.
app.use('/api', requireSession)

app.use('/api', ratingsRouter)
app.use('/api', socialRouter)
app.use('/api', exploreRouter)
app.use('/api', accountRouter)

app.use((err, _req, res, _next) => {
  console.error(err)
  res.status(500).json({ error: 'Internal server error' })
})

// Serve static files from dist directory
app.use(express.static('dist'))

// SPA fallback - serve index.html for all non-API routes
app.use((_req, res) => {
  res.sendFile('dist/index.html', { root: '.' })
})

async function initBackground() {
  try {
    await initDb()
    console.log('✓ Database schema ready')
  } catch (error) {
    console.error('initDb failed (will retry on next request):', error)
    return
  }

  try {
    const usersToLink = [
      { userName: 'daniella', email: 'daniella.choy@gmail.com' },
      { userName: 'zakoray', email: 'clarence.z.choy@gmail.com' }
    ]

    for (const { userName, email } of usersToLink) {
      const result = await pool.query(
        'UPDATE accounts SET email = $1 WHERE LOWER(user_name) = LOWER($2) AND (email IS NULL OR email = \'\') RETURNING user_name',
        [email, userName]
      )
      if (result.rowCount > 0) {
        console.log(`✓ Linked ${userName} to ${email}`)
      }
    }
  } catch (error) {
    console.error('Error linking users:', error)
  }

  // One-shot backfill: sync demo showcase photos, greenness, and flavors
  // onto seed rows for any pre-existing demo account. Idempotent — safe to
  // run every boot.
  try {
    const demoSeedUpdates = [
      { location: 'Ippodo Tea (Kyoto)', photo: `${DEMO_PHOTO_BASE}/ippodo.png`, greenness: 97, flavors: ['nutty', 'velvety', 'umami', 'chocolatey', '__body:full-bodied'] },
      { location: 'Kettl Tea (Brooklyn)', photo: `${DEMO_PHOTO_BASE}/kettl.png`, greenness: 92, flavors: ['nutty', 'sweet', 'creamy', '__body:full-bodied'] },
      { location: 'Stonemill Matcha (SF)', photo: `${DEMO_PHOTO_BASE}/stonemill.png`, greenness: 80, flavors: ['earthy', '__body:medium'] },
      { location: 'Cha Cha Matcha (NYC)', photo: `${DEMO_PHOTO_BASE}/chacha.png`, greenness: 78, flavors: ['earthy', 'bitter', '__body:medium'] },
      { location: 'Blue Bottle (SF)', photo: `${DEMO_PHOTO_BASE}/bluebottle.png`, greenness: 74, flavors: ['mellow', 'earthy', '__body:milky'] },
      { location: 'Matchaful (NYC)', photo: `${DEMO_PHOTO_BASE}/matchaful.png`, greenness: 88, flavors: ['smooth', 'umami', 'nutty', 'sweet', '__body:medium'] },
      { location: 'Boba Guys (SF)', photo: '', greenness: 60, flavors: ['earthy', 'rich'] }
    ]
    for (const p of demoSeedUpdates) {
      const prefs = {}
      for (const key of p.flavors || []) prefs[String(key)] = 100
      const flavorsJson = JSON.stringify(prefs)
      const r = await pool.query(
        `UPDATE ratings SET photo = $1, greenness = $2, flavor_preferences = $3
           WHERE LOWER(user_name) = LOWER($4) AND is_seed = TRUE
             AND LOWER(location) = LOWER($5)
             AND (photo IS DISTINCT FROM $1 OR greenness <> $2 OR flavor_preferences::text <> $3)`,
        [p.photo, p.greenness, flavorsJson, DEMO_USER_NAME, p.location]
      )
      if (r.rowCount > 0) {
        console.log(`✓ Backfilled demo row for ${p.location}`)
      }
    }
  } catch (error) {
    console.error('Demo seed backfill failed:', error)
  }
}

app.listen(port, () => {
  console.log(`API server running on http://localhost:${port}`)
  initBackground().catch((error) => {
    console.error('Background init failed:', error)
  })
})
