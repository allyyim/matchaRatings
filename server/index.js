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
import { DEMO_PHOTO_BASE } from './lib/constants.js'
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
  // Google OAuth's implicit-flow popup needs to postMessage the access
  // token back to us and we poll window.closed. The browser default COOP
  // ('same-origin' in some Chromium builds) severs the opener link so
  // the popup silently returns a partial/reused token → Google's
  // /userinfo then 401s and sign-in fails on desktop. 'same-origin-allow-popups'
  // is the recommended value for pages that open OAuth popups: still
  // isolates us from unrelated cross-origin windows, but keeps the
  // opener handle to our own popups intact.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups')
  // Content-Security-Policy: defense-in-depth against XSS. React auto-escapes
  // all rendered user content and the codebase has no dangerouslySetInnerHTML
  // or innerHTML sinks, so this is a belt over an already-tight suspenders.
  // script-src is now hash-pinned: no 'unsafe-inline' — the previously
  // inline bootstrap scripts live in public/bootstrap.js and load via
  // 'self'. Google OAuth's script is allowlisted by host.
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' https://accounts.google.com https://apis.google.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob: https://res.cloudinary.com https://lh3.googleusercontent.com",
      "connect-src 'self' https://photon.komoot.io https://nominatim.openstreetmap.org https://accounts.google.com https://oauth2.googleapis.com https://*.ingest.sentry.io https://*.ingest.us.sentry.io",
      "frame-src https://accounts.google.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
      "upgrade-insecure-requests",
    ].join('; ')
  )
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

// ---------------------------------------------------------------------------
// Router mounting order matters:
//   1. adminRouter   — no session (ops endpoints)
//   2. authRouter    — no session for Google sign-in; routes that need
//                      session (link-status, demo/cleanup) apply
//                      requireSession inline
//   3. exploreRouter — mixed. Public discovery endpoints (/explore/*)
//                      show the same data to signed-out visitors as
//                      signed-in ones, so they must sit BEFORE the gate.
//                      Personalized recs (/similar-users, /similar-places,
//                      /users/similar-preferences) apply requireSession
//                      inline.
//   4. auth gate     — everything past this point requires a session
//   5. business + accountRouter — session-protected
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Note: each router file already prefixes its routes with '/api/...' — so
// we mount them at root, not at '/api'. Mounting at '/api' would produce a
// double prefix ('/api/api/...') and every route would 404 through to
// requireSession, surfacing as a bogus 'Authentication required' error on
// what should be public endpoints (e.g. /api/auth/google/verify).
// ---------------------------------------------------------------------------

app.use(adminRouter)
app.use(authRouter)
app.use(exploreRouter)

// Auth gate. Any /api request that reaches this middleware is a
// session-protected route; pre-gate routers already handled the public ones.
app.use('/api', requireSession)

app.use(ratingsRouter)
app.use(socialRouter)
app.use(accountRouter)

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
