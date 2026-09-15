import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import crypto from 'node:crypto'
import * as Sentry from '@sentry/node'
import { Resend } from 'resend'
import { OAuth2Client } from 'google-auth-library'
import { v2 as cloudinary } from 'cloudinary'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { initDb, pool } from './db.js'
import {
  sanitizeUserName,
  normalizeEmail,
  isValidEmail,
} from './lib/sanitize.js'
import { recsCacheInvalidate } from './lib/recsCache.js'
import {
  generateToken,
  hashLoginToken,
} from './lib/crypto.js'
import { requireSession } from './lib/session.js'
import {
  apiRateLimiter,
  authRateLimiter,
} from './lib/rateLimits.js'
import adminRouter from './routes/admin.routes.js'
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
const LOGIN_TOKEN_TTL_MS = 1000 * 60 * 15
const APP_ORIGIN = String(process.env.APP_ORIGIN || 'https://allyyim.github.io/matchaRatings').replace(/\/$/, '')
const EMAIL_FROM = process.env.EMAIL_FROM || 'Sip & Score <onboarding@resend.dev>'
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null
const googleClient = process.env.GOOGLE_CLIENT_ID ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID) : null

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
})

const telemetryBuffer = []

async function createLoginToken(email, purpose, userName = null) {
  const rawToken = crypto.randomBytes(32).toString('base64url')
  const tokenHash = hashLoginToken(rawToken)
  const expiresAt = new Date(Date.now() + LOGIN_TOKEN_TTL_MS)

  await pool.query(
    `INSERT INTO login_tokens (token_hash, email, user_name, purpose, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [tokenHash, email, userName, purpose, expiresAt]
  )

  return rawToken
}

async function sendMagicLinkEmail(email, rawToken, purpose) {
  const link = `${APP_ORIGIN}/?authToken=${encodeURIComponent(rawToken)}&purpose=${encodeURIComponent(purpose)}`

  if (!resend) {
    console.log(`[dev] Magic sign-in link for ${email}: ${link}`)
    return link
  }

  const subject = purpose === 'link' ? 'Link your Sip & Score account' : 'Your Sip & Score sign-in link'
  await resend.emails.send({
    from: EMAIL_FROM,
    to: email,
    subject,
    html: `
      <p>Click the link below to sign in to Sip &amp; Score. This link expires in 15 minutes and can only be used once.</p>
      <p><a href="${link}">${link}</a></p>
      <p>If you didn't request this, you can safely ignore this email.</p>
    `
  })

  return null
}

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

// Requests a magic sign-in link for a stable, email-backed account.
// - If the email already has an account, the link signs in as that account's userName.
// - If not, userName must be provided to create a new account (or claim an existing
//   legacy browser-only userName, migrating it to a stable email-backed account).
app.post('/api/auth/request-link', authRateLimiter, async (req, res) => {
  const email = normalizeEmail(req.body?.email)
  const requestedUserName = sanitizeUserName(String(req.body?.userName || '').trim())

  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: 'A valid email is required' })
  }

  const existingAccount = await pool.query('SELECT user_name FROM accounts WHERE email = $1', [email])

  if (existingAccount.rowCount > 0) {
    const rawToken = await createLoginToken(email, 'login', existingAccount.rows[0].user_name)
    await sendMagicLinkEmail(email, rawToken, 'login')
    return res.json({ ok: true, mode: 'login' })
  }

  if (!requestedUserName) {
    return res.status(200).json({ ok: true, mode: 'needs-username' })
  }

  const nameTaken = await pool.query(
    'SELECT 1 FROM accounts WHERE LOWER(user_name) = LOWER($1)',
    [requestedUserName]
  )
  if (nameTaken.rowCount > 0) {
    return res.status(409).json({ error: 'That username is already linked to another account' })
  }

  const rawToken = await createLoginToken(email, 'signup', requestedUserName)
  await sendMagicLinkEmail(email, rawToken, 'signup')
  return res.json({ ok: true, mode: 'signup' })
})

// Verifies a magic-link token, creating the account on first use, and returns a session.
app.post('/api/auth/verify', authRateLimiter, async (req, res) => {
  const rawToken = String(req.body?.token || '').trim()
  const browserId = String(req.body?.browserId || '').trim()

  if (!rawToken) {
    return res.status(400).json({ error: 'token is required' })
  }

  const tokenHash = hashLoginToken(rawToken)
  const tokenRow = await pool.query(
    `SELECT email, user_name, purpose, expires_at, used_at
     FROM login_tokens WHERE token_hash = $1`,
    [tokenHash]
  )

  if (tokenRow.rowCount === 0) {
    return res.status(400).json({ error: 'This link is invalid. Please request a new one.' })
  }

  const record = tokenRow.rows[0]
  if (record.used_at || new Date(record.expires_at).getTime() < Date.now()) {
    return res.status(400).json({ error: 'This link has expired. Please request a new one.' })
  }

  await pool.query('UPDATE login_tokens SET used_at = NOW() WHERE token_hash = $1', [tokenHash])

  const existingAccount = await pool.query('SELECT user_name FROM accounts WHERE email = $1', [record.email])
  let userName = existingAccount.rows[0]?.user_name

  if (!userName) {
    if (!record.user_name) {
      return res.status(400).json({ error: 'No username on file for this link. Please sign up again.' })
    }

    const nameTaken = await pool.query(
      'SELECT 1 FROM accounts WHERE LOWER(user_name) = LOWER($1)',
      [record.user_name]
    )
    if (nameTaken.rowCount > 0) {
      return res.status(409).json({ error: 'That username was just claimed by another account. Please sign up again.' })
    }

    // Create new account with email and username
    await pool.query(
      'INSERT INTO accounts (email, user_name) VALUES ($1, $2)',
      [record.email, record.user_name]
    )
    userName = record.user_name
  } else {
    // Existing account found - verify email matches before using it
    const existingAccount = await pool.query(
      'SELECT email, user_name FROM accounts WHERE LOWER(user_name) = LOWER($1)',
      [userName]
    )
    if (existingAccount.rowCount > 0 && existingAccount.rows[0].email && existingAccount.rows[0].email !== record.email) {
      // Email mismatch - prevent overwriting
      return res.status(409).json({ error: 'This username is already linked to a different email address.' })
    }
  }

  const token = generateToken(userName, browserId)
  return res.json({ userName, email: record.email, token })
})

// Verifies Google OAuth token and creates/links account
app.post('/api/auth/google/verify', authRateLimiter, async (req, res) => {
  const googleToken = String(req.body?.token || '').trim()
  const providedUserName = String(req.body?.userName || '').trim()
  const confirmedUserName = String(req.body?.confirmedUserName || '').trim()
  const browserId = String(req.body?.browserId || '').trim()

  if (!googleToken) {
    return res.status(400).json({ error: 'Missing authentication token' })
  }

  try {
    // Use access token to get user info from Google
    const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${googleToken}` }
    })

    console.log('Google userinfo response status:', userInfoResponse.status)

    if (!userInfoResponse.ok) {
      const errorText = await userInfoResponse.text()
      console.error('Google userinfo error:', userInfoResponse.status, errorText)
      return res.status(401).json({ error: 'Invalid Google token' })
    }

    const userInfo = await userInfoResponse.json()
    console.log('Got user info from Google:', { id: userInfo.id, email: userInfo.email })
    const googleId = userInfo.id
    const email = userInfo.email
    const name = userInfo.name

    // If user was pre-verified by name, link directly
    if (confirmedUserName) {
      // Verify account exists and email hasn't been changed
      const existingAccount = await pool.query(
        'SELECT email FROM accounts WHERE LOWER(user_name) = LOWER($1)',
        [confirmedUserName]
      )
      if (existingAccount.rowCount === 0) {
        return res.status(400).json({ error: 'Account not found' })
      }

      const existingEmail = existingAccount.rows[0].email
      if (existingEmail && existingEmail !== email) {
        return res.status(409).json({ error: 'Email mismatch: this account is linked to a different email' })
      }

      await pool.query(
        'UPDATE accounts SET google_id = $1, email = $2 WHERE LOWER(user_name) = LOWER($3)',
        [googleId, email, confirmedUserName]
      )
      console.log(`Linked Google ID to verified account: ${confirmedUserName}`)
      const token = generateToken(confirmedUserName, browserId)
      return res.json({ userName: confirmedUserName, email, token })
    }

    // Find existing account by Google ID first
    let account = await pool.query(
      'SELECT user_name, email FROM accounts WHERE google_id = $1',
      [googleId]
    )

    let userName
    if (account.rowCount > 0) {
      // Already linked to this Google ID
      userName = account.rows[0].user_name
    } else {
      // Check if email already exists (migrating from old system)
      const emailExists = await pool.query(
        'SELECT user_name FROM accounts WHERE email = $1',
        [email]
      )

      if (emailExists.rowCount > 0) {
        // Email already exists - only allow if user explicitly confirms via confirmedUserName
        // Do NOT auto-link new users to existing accounts
        if (!confirmedUserName) {
          const existingUserName = emailExists.rows[0].user_name
          return res.status(400).json({
            error: 'Email already linked to existing account',
            potentialAccounts: [existingUserName],
            isExistingEmail: true
          })
        }

        // If confirmed, link to existing account
        const existingUserName = emailExists.rows[0].user_name
        await pool.query(
          'UPDATE accounts SET google_id = $1 WHERE email = $2',
          [googleId, email]
        )
        userName = existingUserName
        console.log(`Linked ${email} to Google ID, username: ${existingUserName}`)
      } else {
        // Check if there are existing accounts without email (from old system)
        const accountsWithoutEmail = await pool.query(
          "SELECT user_name FROM accounts WHERE email IS NULL OR email = ''"
        )

        if (accountsWithoutEmail.rowCount > 0) {
          // Prompt to link with existing accounts
          const accountNames = accountsWithoutEmail.rows.map(row => row.user_name)
          return res.status(400).json({
            error: 'Account linking needed',
            potentialAccounts: accountNames
          })
        }

        // New user - require name
        if (!providedUserName) {
          return res.status(400).json({ error: 'New user requires name', isNewUser: true })
        }

        const sanitizedName = sanitizeUserName(providedUserName)

        // Ensure sanitized name is not empty
        if (!sanitizedName) {
          return res.status(400).json({ error: 'Invalid username - must contain alphanumeric characters' })
        }

        // Check if username is available
        const nameTaken = await pool.query(
          'SELECT 1 FROM accounts WHERE LOWER(user_name) = LOWER($1)',
          [sanitizedName]
        )

        if (nameTaken.rowCount > 0) {
          return res.status(409).json({ error: 'Username already taken' })
        }

        await pool.query(
          'INSERT INTO accounts (email, user_name, google_id) VALUES ($1, $2, $3)',
          [email, sanitizedName, googleId]
        )
        userName = sanitizedName
      }
    }

    const token = generateToken(userName, browserId)
    return res.json({ userName, email, token })
  } catch (error) {
    console.error('Google OAuth verification failed:', error)
    return res.status(400).json({ error: 'Invalid Google token' })
  }
})

app.post('/api/auth/verify-account', authRateLimiter, async (req, res) => {
  try {
    const { userName } = req.body

    if (!userName) {
      return res.status(400).json({ error: 'User name is required' })
    }

    const account = await pool.query(
      'SELECT user_name FROM accounts WHERE LOWER(user_name) = LOWER($1)',
      [userName]
    )

    if (account.rowCount > 0) {
      return res.json({ exists: true, userName: account.rows[0].user_name })
    } else {
      return res.status(404).json({ exists: false })
    }
  } catch (error) {
    console.error('Account verification failed:', error)
    return res.status(400).json({ error: 'Account verification failed' })
  }
})

app.post('/api/auth/google/confirm-account', authRateLimiter, async (req, res) => {
  try {
    const { token: googleAccessToken, browserId, confirmedUserName } = req.body

    if (!googleAccessToken || !confirmedUserName) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    // Get user info from Google
    const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${googleAccessToken}` }
    })

    if (!userInfoResponse.ok) {
      return res.status(400).json({ error: 'Invalid Google token' })
    }

    const userInfo = await userInfoResponse.json()
    const googleId = userInfo.id
    const email = userInfo.email

    // Verify the confirmed user exists
    const userExists = await pool.query(
      'SELECT user_name FROM accounts WHERE LOWER(user_name) = LOWER($1)',
      [confirmedUserName]
    )

    if (userExists.rowCount === 0) {
      return res.status(400).json({ error: 'User not found' })
    }

    // Update the account to link Google ID and email
    await pool.query(
      'UPDATE accounts SET google_id = $1, email = $2 WHERE LOWER(user_name) = LOWER($3)',
      [googleId, email, confirmedUserName]
    )

    console.log(`Linked Google ID to existing account: ${confirmedUserName}`)

    const prefixedName = `@${confirmedUserName}`
    const token = generateToken(prefixedName, browserId)
    return res.json({ userName: prefixedName, email, token })
  } catch (error) {
    console.error('Account confirmation failed:', error)
    return res.status(400).json({ error: 'Account linking failed' })
  }
})


// Admin/maintenance routes. Mounted BEFORE the auth gate below so they don't
// require a session — they're used by ops scripts (migrate-photos, delete-user).
app.use('/api', adminRouter)

// Protect all /api routes with auth, except the migration endpoint
app.use('/api', (req, res, next) => {
  if (req.path === '/admin/migrate-photos-to-cloudinary') {
    console.log('Skipping auth for migration endpoint')
    return next()
  }
  if (req.path === '/auth/demo' || req.path === '/auth/check-username') {
    return next()
  }
  return requireSession(req, res, next)
})

// Business route modules. All require session (mounted after the auth gate).
app.use('/api', ratingsRouter)
app.use('/api', socialRouter)
app.use('/api', exploreRouter)

// Lets an already-logged-in (browser-only) user check if their account has a stable email on file.
app.get('/api/auth/link-status', async (req, res) => {
  const result = await pool.query(
    'SELECT email FROM accounts WHERE LOWER(user_name) = LOWER($1)',
    [req.session.userName]
  )
  return res.json({ linked: result.rowCount > 0, email: result.rows[0]?.email || null })
})

// Public availability check for a proposed username during signup.
app.get('/api/auth/check-username', async (req, res) => {
  const raw = String(req.query?.name || '').trim()
  const sanitized = sanitizeUserName(raw)
  if (!sanitized) {
    return res.json({ available: false, reason: 'invalid' })
  }
  const taken = await pool.query(
    'SELECT 1 FROM accounts WHERE LOWER(user_name) = LOWER($1)',
    [sanitized]
  )
  return res.json({ available: taken.rowCount === 0, sanitized })
})

// Demo/recruiter login: mints a token for a fixed "demo" account and seeds sample data on first use.
// The demo account is intentionally hidden from all public/social surfaces (friends search,
// explore leaderboards, similar users/places, follows) so recruiter-facing seed data never
// leaks into the real PWA/website experience for normal users.
const DEMO_USER_NAME = 'demo'
// Base URL for demo-only static photo assets. Points to the GitHub Pages
// build so the images load correctly whether the demo runs on Render or on
// the GH Pages mirror. Files are checked in at public/demo/*.png.
const DEMO_PHOTO_BASE = 'https://allyyim.github.io/matchaRatings/demo'
async function seedDemoData(userName) {
  const seeds = [
    { location: 'Cha Cha Matcha (NYC)', photo: `${DEMO_PHOTO_BASE}/chacha.png`, rating: 4.5, greenness: 78, thoughts: 'Vibrant color, smooth umami finish. Strawberry base peeks through, dropping greenness a touch.', flavors: ['earthy', 'bitter', '__body:medium'] },
    { location: 'Ippodo Tea (Kyoto)', photo: `${DEMO_PHOTO_BASE}/ippodo.png`, rating: 5, greenness: 97, thoughts: 'Benchmark quality. Deep vegetal notes, silky mouthfeel, zero bitterness.', flavors: ['nutty', 'velvety', 'umami', 'chocolatey', '__body:full-bodied'] },
    { location: 'Blue Bottle (SF)', photo: `${DEMO_PHOTO_BASE}/bluebottle.png`, rating: 3.5, greenness: 74, thoughts: 'Balanced but leaned bitter. Iced pour looked a bit muted next to the ceremonial-grade cups.', flavors: ['mellow', 'earthy', '__body:milky'] },
    { location: 'Matchaful (NYC)', photo: `${DEMO_PHOTO_BASE}/matchaful.png`, rating: 4, greenness: 88, thoughts: 'Bright, grassy, with a clean sweet finish. Great daily driver — vivid green through and through.', flavors: ['smooth', 'umami', 'nutty', 'sweet', '__body:medium'] },
    { location: 'Stonemill Matcha (SF)', photo: `${DEMO_PHOTO_BASE}/stonemill.png`, rating: 4.5, greenness: 80, thoughts: 'Rich, creamy, chocolatey undertones. Great with oat milk — strawberry base peeked through so the greenness dipped.', flavors: ['earthy', '__body:medium'] },
    { location: 'Kettl Tea (Brooklyn)', photo: `${DEMO_PHOTO_BASE}/kettl.png`, rating: 4.5, greenness: 92, thoughts: 'Elegant, floral top-notes and lingering umami. Ceremonial grade layered over cold milk.', flavors: ['nutty', 'sweet', 'creamy', '__body:full-bodied'] },
    { location: 'Boba Guys (SF)', rating: 3, greenness: 60, thoughts: 'Solid latte base, but leans sugary. Would order iced.', flavors: ['earthy', 'rich'] }
  ]
  // Convert a ['nutty', 'sweet', '__body:medium'] array into the
  // { nutty: 100, sweet: 100, '__body:medium': 100 } shape the UI reads.
  const flavorsToPrefs = (arr) => {
    const out = {}
    for (const key of arr || []) out[String(key)] = 100
    return out
  }
  for (const s of seeds) {
    await pool.query(
      `INSERT INTO ratings (user_name, photo, rating, greenness, location, thoughts, flavor_preferences, is_seed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)`,
      [userName, s.photo || '', s.rating, s.greenness, s.location, s.thoughts, JSON.stringify(flavorsToPrefs(s.flavors))]
    )
  }
  await pool.query(
    `INSERT INTO user_preferences (email, flavors, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (email) DO UPDATE SET flavors = EXCLUDED.flavors, updated_at = NOW()`,
    [`${userName}@sipandscore.local`, JSON.stringify(['umami', 'vegetal', 'creamy', 'sweet', '__body:medium'])]
  )
}

app.post('/api/auth/demo', authRateLimiter, async (req, res) => {
  const DEMO_USER = 'demo'
  const DEMO_EMAIL = 'demo@sipandscore.local'
  try {
    const existing = await pool.query(
      'SELECT 1 FROM accounts WHERE LOWER(user_name) = LOWER($1)',
      [DEMO_USER]
    )
    if (existing.rowCount === 0) {
      await pool.query(
        'INSERT INTO accounts (email, user_name) VALUES ($1, $2)',
        [DEMO_EMAIL, DEMO_USER]
      )
    }
    const ratingCount = await pool.query(
      'SELECT COUNT(*)::int AS c FROM ratings WHERE LOWER(user_name) = LOWER($1)',
      [DEMO_USER]
    )
    if (ratingCount.rows[0].c === 0) {
      await seedDemoData(DEMO_USER)
    } else {
      // Idempotent backfill: sync the three showcase photos + recalculated
      // greenness onto existing seed rows so demo users who logged in
      // before the photos existed still see them. Safe to run every login.
      const seedUpdates = [
        { location: 'Ippodo Tea (Kyoto)', photo: `${DEMO_PHOTO_BASE}/ippodo.png`, greenness: 97, flavors: ['nutty', 'velvety', 'umami', 'chocolatey', '__body:full-bodied'] },
        { location: 'Kettl Tea (Brooklyn)', photo: `${DEMO_PHOTO_BASE}/kettl.png`, greenness: 92, flavors: ['nutty', 'sweet', 'creamy', '__body:full-bodied'] },
        { location: 'Stonemill Matcha (SF)', photo: `${DEMO_PHOTO_BASE}/stonemill.png`, greenness: 80, flavors: ['earthy', '__body:medium'] },
        { location: 'Cha Cha Matcha (NYC)', photo: `${DEMO_PHOTO_BASE}/chacha.png`, greenness: 78, flavors: ['earthy', 'bitter', '__body:medium'] },
        { location: 'Blue Bottle (SF)', photo: `${DEMO_PHOTO_BASE}/bluebottle.png`, greenness: 74, flavors: ['mellow', 'earthy', '__body:milky'] },
        { location: 'Matchaful (NYC)', photo: `${DEMO_PHOTO_BASE}/matchaful.png`, greenness: 88, flavors: ['smooth', 'umami', 'nutty', 'sweet', '__body:medium'] },
        { location: 'Boba Guys (SF)', photo: '', greenness: 60, flavors: ['earthy', 'rich'] }
      ]
      for (const p of seedUpdates) {
        const prefs = {}
        for (const key of p.flavors || []) prefs[String(key)] = 100
        await pool.query(
          `UPDATE ratings SET photo = $1, greenness = $2, flavor_preferences = $3
             WHERE LOWER(user_name) = LOWER($4) AND is_seed = TRUE
               AND LOWER(location) = LOWER($5)`,
          [p.photo, p.greenness, JSON.stringify(prefs), DEMO_USER, p.location]
        )
      }
    }
    // Auto-follow the maintainer account (allyyim) from the demo account so
    // the Feed tab always has fresh friend activity to show visitors. Uses
    // ON CONFLICT to stay idempotent across repeated demo logins.
    try {
      const allyRow = await pool.query(
        "SELECT email FROM accounts WHERE LOWER(user_name) = LOWER('allyyim')"
      )
      const demoRow = await pool.query(
        'SELECT email FROM accounts WHERE LOWER(user_name) = LOWER($1)',
        [DEMO_USER]
      )
      const allyEmail = allyRow.rows[0]?.email
      const demoEmail = demoRow.rows[0]?.email
      if (allyEmail && demoEmail && allyEmail !== demoEmail) {
        await pool.query(
          `INSERT INTO follows (follower_email, following_email)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [demoEmail, allyEmail]
        )
      }
    } catch (followErr) {
      console.warn('[demo login] auto-follow allyyim failed (non-fatal):', followErr)
    }
    const browserId = String(req.body?.browserId || crypto.randomUUID()).slice(0, 128)
    const token = generateToken(DEMO_USER, browserId)
    return res.json({ userName: DEMO_USER, token })
  } catch (err) {
    console.error('[demo login] failed:', err)
    return res.status(500).json({ error: 'Demo login failed' })
  }
})

// Called from the client when a recruiter logs out of the demo account.
// Drops every rating the demo user added during their session (is_seed = false)
// so the pre-populated logs (is_seed = true) remain pristine for the next
// visitor. Also clears any likes on those deleted ratings, and resets demo's
// user_preferences to the curated defaults so shade / flavor picks don't leak
// to the next demo session.
// Deliberately does NOT require a session: recruiters may already have their
// token cleared client-side before this fires. Instead we hard-scope to the
// demo account server-side so the endpoint can't be abused against real users.
app.post('/api/auth/demo/cleanup', async (_req, res) => {
  try {
    const del = await pool.query(
      `DELETE FROM ratings
         WHERE LOWER(user_name) = LOWER($1)
           AND is_seed = FALSE`,
      [DEMO_USER_NAME]
    )
    await pool.query(
      `UPDATE user_preferences
         SET flavors = $2::jsonb, updated_at = NOW()
       WHERE email = $1`,
      [`${DEMO_USER_NAME}@sipandscore.local`, JSON.stringify(['umami', 'vegetal', 'creamy', 'sweet', '__body:medium'])]
    )
    return res.json({ ok: true, deleted: del.rowCount })
  } catch (err) {
    console.error('[demo cleanup] failed:', err)
    return res.status(500).json({ error: 'Demo cleanup failed' })
  }
})

// Sends a magic link that, once clicked, attaches the current session's username to an email
// so the account becomes accessible from any device/browser going forward.
app.post('/api/auth/link-email', authRateLimiter, async (req, res) => {
  const email = normalizeEmail(req.body?.email)
  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: 'A valid email is required' })
  }

  const emailInUse = await pool.query('SELECT 1 FROM accounts WHERE email = $1', [email])
  if (emailInUse.rowCount > 0) {
    return res.status(409).json({ error: 'That email is already linked to an account' })
  }

  const nameInUse = await pool.query(
    'SELECT 1 FROM accounts WHERE LOWER(user_name) = LOWER($1)',
    [req.session.userName]
  )
  if (nameInUse.rowCount > 0) {
    return res.status(409).json({ error: 'This account already has an email on file' })
  }

  const rawToken = await createLoginToken(email, 'link', req.session.userName)
  const verificationLink = await sendMagicLinkEmail(email, rawToken, 'link')
  return res.json({ ok: true, verificationLink: verificationLink || undefined })
})




// User preferences endpoints
app.get('/api/preferences', async (req, res) => {
  if (!req.session.userName) {
    return res.status(401).json({ error: 'Not authenticated' })
  }

  try {
    const emailResult = await pool.query(
      'SELECT email FROM accounts WHERE LOWER(user_name) = LOWER($1)',
      [req.session.userName]
    )
    const email = emailResult.rows[0]?.email

    if (!email) {
      return res.status(404).json({ error: 'User account not found' })
    }

    const result = await pool.query('SELECT * FROM user_preferences WHERE email = $1', [email])
    const prefs = result.rows[0] || { flavors: [], milk_type: [], visited_countries: [] }
    return res.json(prefs)
  } catch (error) {
    console.error('Failed to load preferences:', error)
    return res.status(500).json({ error: 'Failed to load preferences' })
  }
})

app.post('/api/preferences', async (req, res) => {
  if (!req.session.userName) {
    return res.status(401).json({ error: 'Not authenticated' })
  }

  try {
    const emailResult = await pool.query(
      'SELECT email FROM accounts WHERE LOWER(user_name) = LOWER($1)',
      [req.session.userName]
    )
    const email = emailResult.rows[0]?.email

    if (!email) {
      return res.status(404).json({ error: 'User account not found' })
    }

    const flavors = Array.isArray(req.body?.flavors) ? req.body.flavors : []

    const result = await pool.query(
      `INSERT INTO user_preferences (email, flavors, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (email) DO UPDATE SET flavors = $2, updated_at = NOW()
       RETURNING *`,
      [email, JSON.stringify(flavors)]
    )

    return res.json({ ok: true, preferences: result.rows[0] })
  } catch (error) {
    console.error('Failed to save preferences:', error)
    return res.status(500).json({ error: 'Failed to save preferences' })
  } finally {
    recsCacheInvalidate(req.session.userName)
  }
})

app.post('/account/email', async (req, res) => {
  const { newEmail } = req.body
  if (!newEmail?.trim()) return res.status(400).json({ error: 'Email is required' })

  const email = (await pool.query('SELECT email FROM accounts WHERE LOWER(user_name) = LOWER($1)', [req.session.userName])).rows[0]?.email
  if (!email) return res.status(404).json({ error: 'User not found' })

  try {
    await pool.query('UPDATE accounts SET email = $1 WHERE LOWER(user_name) = LOWER($2)', [newEmail, req.session.userName])
    return res.json({ ok: true, message: 'Email updated successfully' })
  } catch (error) {
    console.error('Failed to update email:', error)
    return res.status(500).json({ error: 'Failed to update email' })
  }
})

// Change the current session's user_name. Cascades the new value into the
// ratings table so leaderboards / friend modals continue to attribute prior
// logs to this user. follows table is keyed by email so it needs no update.
// Reserved names (demo) and already-taken names (case-insensitive) are
// rejected.
app.post('/api/account/username', async (req, res) => {
  if (!req.session?.userName) return res.status(401).json({ error: 'Not signed in' })
  const currentUserName = req.session.userName
  const rawIncoming = String(req.body?.newUserName || '').trim()
  const newUserName = sanitizeUserName(rawIncoming)

  if (!newUserName || newUserName.length < 2) {
    return res.status(400).json({ error: 'Username must be at least 2 characters (letters, numbers, . _ -)' })
  }
  if (newUserName.length > 40) {
    return res.status(400).json({ error: 'Username must be 40 characters or fewer' })
  }
  if (newUserName.toLowerCase() === DEMO_USER_NAME) {
    return res.status(400).json({ error: 'That username is reserved' })
  }
  if (newUserName.toLowerCase() === currentUserName.toLowerCase()) {
    // Same name (possibly different casing) — accept as a no-op rename so
    // the client can still update its display casing.
    try {
      await pool.query('UPDATE accounts SET user_name = $1 WHERE LOWER(user_name) = LOWER($2)', [newUserName, currentUserName])
      await pool.query('UPDATE ratings SET user_name = $1 WHERE LOWER(user_name) = LOWER($2)', [newUserName, currentUserName])
      req.session.userName = newUserName
      return res.json({ ok: true, userName: newUserName })
    } catch (error) {
      console.error('Failed to update casing on username:', error)
      return res.status(500).json({ error: 'Failed to update username' })
    }
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const taken = await client.query('SELECT 1 FROM accounts WHERE LOWER(user_name) = LOWER($1)', [newUserName])
    if (taken.rowCount > 0) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'That username is already taken' })
    }
    await client.query('UPDATE accounts SET user_name = $1 WHERE LOWER(user_name) = LOWER($2)', [newUserName, currentUserName])
    await client.query('UPDATE ratings SET user_name = $1 WHERE LOWER(user_name) = LOWER($2)', [newUserName, currentUserName])
    await client.query('COMMIT')
    req.session.userName = newUserName
    return res.json({ ok: true, userName: newUserName })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('Failed to rename user:', error)
    return res.status(500).json({ error: 'Failed to update username' })
  } finally {
    client.release()
  }
})

// Set (or clear) the profile picture URL for the current session's user.
// The URL should already have been uploaded to Cloudinary via
// /api/upload-image on the client — we only persist the resulting URL here.
app.post('/api/account/avatar', async (req, res) => {
  if (!req.session?.userName) return res.status(401).json({ error: 'Not signed in' })
  const rawUrl = req.body?.avatarUrl
  const avatarUrl = rawUrl === null || rawUrl === '' ? null : String(rawUrl || '').trim()
  if (avatarUrl !== null) {
    if (avatarUrl.length > 500) return res.status(400).json({ error: 'Avatar URL too long' })
    if (!/^https:\/\//i.test(avatarUrl)) return res.status(400).json({ error: 'Avatar must be an https URL' })
  }
  try {
    await pool.query(
      'UPDATE accounts SET avatar_url = $1 WHERE LOWER(user_name) = LOWER($2)',
      [avatarUrl, req.session.userName]
    )
    return res.json({ ok: true, avatarUrl })
  } catch (error) {
    console.error('Failed to update avatar:', error)
    return res.status(500).json({ error: 'Failed to update avatar' })
  }
})

// Returns the current session user's account-level profile fields we render
// in the drawer (right now: avatar_url). Kept separate from /link-status so
// callers can grab this without needing to know linkage state.
app.get('/api/account/me', async (req, res) => {
  if (!req.session?.userName) return res.status(401).json({ error: 'Not signed in' })
  const result = await pool.query(
    'SELECT user_name, avatar_url FROM accounts WHERE LOWER(user_name) = LOWER($1)',
    [req.session.userName]
  )
  const row = result.rows[0]
  return res.json({
    userName: row?.user_name || req.session.userName,
    avatarUrl: row?.avatar_url || null
  })
})

// Follow/unfollow endpoints

// Fetch another user's saved matcha preferences (canonical flavors + body).
// Used by the friend modal so we show what a user *actually set* in their
// profile drawer instead of aggregating over their ratings.
app.get('/api/users/:userName/preferences', async (req, res) => {
  const userName = sanitizeUserName(String(req.params.userName || '').trim())
  if (!userName) {
    return res.status(400).json({ error: 'userName is required' })
  }

  // Hide the demo account's preferences from everyone except demo itself.
  const requesterName = String(req.session?.userName || '').toLowerCase()
  if (userName.toLowerCase() === DEMO_USER_NAME && requesterName !== DEMO_USER_NAME) {
    return res.status(404).json({ error: 'User not found' })
  }

  try {
    // NOTE: no server-side KNOWN_FLAVORS filter here. The client is the
    // single source of truth (isKnownFlavor in src/lib/flavors.ts) — we
    // return every non-`__` key and let the client decide what to render.
    // This avoids the "chip differs between Explore and friend modal"
    // bug that happened when we added a flavor to the client vocabulary
    // but the server allowlist was still stale until the next deploy.

    // Fetch the account's avatar_url alongside preferences so the friend
    // modal can render a profile picture without a second round-trip.
    const avatarResult = await pool.query(
      'SELECT avatar_url FROM accounts WHERE LOWER(user_name) = LOWER($1)',
      [userName]
    )
    const avatarUrl = avatarResult.rows[0]?.avatar_url || null

    const result = await pool.query(
      `SELECT up.flavors
         FROM user_preferences up
         JOIN accounts a ON a.email = up.email
         WHERE LOWER(a.user_name) = LOWER($1)
         LIMIT 1`,
      [userName]
    )

    if (result.rowCount === 0) {
      return res.json({ userName, flavors: [], body: '', avatarUrl })
    }

    const raw = result.rows[0].flavors
    const flavors = []
    let body = ''
    const takeKey = (rawKey, rawVal) => {
      if (rawVal !== undefined && !rawVal) return
      const k = String(rawKey || '').toLowerCase()
      if (k.startsWith('__body:')) {
        body = k.slice('__body:'.length)
      } else if (k && !k.startsWith('__')) {
        if (!flavors.includes(k)) flavors.push(k)
      }
    }
    if (Array.isArray(raw)) {
      for (const item of raw) takeKey(item, undefined)
    } else if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) takeKey(k, v)
    }

    return res.json({ userName, flavors, body, avatarUrl })
  } catch (error) {
    console.error('Fetch user preferences failed:', error)
    return res.status(500).json({ error: 'Failed to load user preferences' })
  }
})

// Find users with similar flavor preferences

// Like/unlike rating endpoints

// Find users with similar flavor preferences

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
