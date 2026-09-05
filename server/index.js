import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import * as Sentry from '@sentry/node'
import rateLimit from 'express-rate-limit'
import { Resend } from 'resend'
import { OAuth2Client } from 'google-auth-library'
import { v2 as cloudinary } from 'cloudinary'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { initDb, pool } from './db.js'
import { findBestMatch } from 'string-similarity'

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
const APP_SECRET = process.env.APP_SECRET || 'matcha-development-secret-change-me'
const JWT_SECRET = process.env.JWT_SECRET || APP_SECRET
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7
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
const LOW_RATING_GREENNESS_WEIGHT = 0.8
const FULL_GREENNESS_WEIGHT = 1

function getWeightedScore(rating, greenness) {
  const greennessWeight = rating >= 4 ? FULL_GREENNESS_WEIGHT : LOW_RATING_GREENNESS_WEIGHT
  return rating * 20 + greenness * greennessWeight
}

function sanitizeText(value, maxLength = 500) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

function sanitizeUserName(value) {
  return sanitizeText(value, 80).replace(/[^a-zA-Z0-9._-]/g, '')
}

function normalizeLocationText(value) {
  return sanitizeText(value, 200)
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function encryptField(value) {
  if (!value) return ''

  const key = crypto.createHash('sha256').update(APP_SECRET).digest()
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([
    cipher.update(String(value), 'utf8'),
    cipher.final()
  ])
  const tag = cipher.getAuthTag()

  return JSON.stringify({ iv: iv.toString('hex'), content: encrypted.toString('base64'), tag: tag.toString('hex') })
}

function decryptField(value) {
  if (!value) return ''

  const parsed = safeJsonParse(value)
  if (!parsed || !parsed.iv || !parsed.content || !parsed.tag) {
    return String(value)
  }

  try {
    const key = crypto.createHash('sha256').update(APP_SECRET).digest()
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.iv, 'hex'))
    decipher.setAuthTag(Buffer.from(parsed.tag, 'hex'))
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(parsed.content, 'base64')),
      decipher.final()
    ])

    return decrypted.toString('utf8')
  } catch {
    return String(value)
  }
}

function generateToken(userName, browserId) {
  return jwt.sign({ userName, browserId: browserId || '' }, JWT_SECRET, { expiresIn: '365d' })
}

function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase().slice(0, 254)
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254
}

function hashLoginToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex')
}

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

function getSessionFromRequest(req) {
  const authorization = String(req.headers.authorization || '')
  const match = authorization.match(/^Bearer\s+(.+)$/i)
  const token = match ? match[1].trim() : ''
  if (!token) return null

  try {
    const payload = jwt.verify(token, JWT_SECRET)
    if (!payload || typeof payload !== 'object') return null

    const userName = String(payload.userName || '').trim()
    const browserId = String(payload.browserId || '').trim()
    if (!userName) return null

    return {
      userName,
      browserId,
      expiresAt: Date.now() + SESSION_TTL_MS,
      token
    }
  } catch {
    return null
  }
}

function requireSession(req, res, next) {
  const session = getSessionFromRequest(req)
  if (!session) {
    return res.status(401).json({ error: 'Authentication required' })
  }

  req.session = session
  return next()
}

function requireUserOwnership(req, res, next) {
  const sessionUser = String(req.session?.userName || '').trim()
  const candidate = String(req.body?.userName || req.query?.userName || '').trim()

  if (!sessionUser) {
    return res.status(401).json({ error: 'Invalid session' })
  }

  if (!candidate) {
    return res.status(400).json({ error: 'userName is required' })
  }

  if (sessionUser.toLowerCase() !== candidate.toLowerCase()) {
    return res.status(403).json({ error: 'Forbidden: user ownership mismatch' })
  }

  return next()
}

const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' }
})

app.disable('x-powered-by')
app.use(cors({ origin: true, credentials: true }))
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

function mapRatingRow(row) {
  const rating = Number(row.rating)
  const greenness = Number(row.greenness)
  return {
    id: Number(row.id),
    userName: row.user_name,
    photo: row.photo,
    rating,
    greenness,
    location: row.location || '',
    thoughts: row.thoughts || '',
    date: new Date(row.created_at).toLocaleDateString(),
    createdAt: row.created_at,
    comboScore: Number(getWeightedScore(rating, greenness).toFixed(2)),
    flavorPreferences: row.flavor_preferences || {}
  }
}

function normalizeLocationName(rawLocation) {
  const location = String(rawLocation || '').trim()
  if (!location) return ''

  const canonical = location
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return canonical
    .split(' ')
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
}

function getCanonicalPlaceData(rawLocation) {
  const normalizedName = normalizeLocationName(rawLocation)
  if (!normalizedName) {
    return { displayName: '', canonicalKey: '' }
  }

  const firstSegment = normalizedName.split(',')[0].split(' - ')[0].trim()
  const displayName = firstSegment || normalizedName
  const canonicalKey = displayName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return { displayName, canonicalKey }
}

function shouldMergePlaces(canonicalA, canonicalB) {
  if (!canonicalA || !canonicalB) return false
  if (canonicalA === canonicalB) return true

  const compactA = canonicalA.replace(/\s+/g, '')
  const compactB = canonicalB.replace(/\s+/g, '')
  if (compactA && compactA === compactB) {
    return true
  }

  const compactShorter = compactA.length <= compactB.length ? compactA : compactB
  const compactLonger = compactA.length > compactB.length ? compactA : compactB
  if (compactShorter.length >= 5 && compactLonger.startsWith(compactShorter)) {
    return true
  }

  const shorter = canonicalA.length <= canonicalB.length ? canonicalA : canonicalB
  const longer = canonicalA.length > canonicalB.length ? canonicalA : canonicalB
  if (shorter.length >= 4 && longer.startsWith(shorter)) {
    return true
  }

  const tokensA = new Set(canonicalA.split(' ').filter(Boolean))
  const tokensB = new Set(canonicalB.split(' ').filter(Boolean))
  const minTokenCount = Math.min(tokensA.size, tokensB.size)
  if (!minTokenCount) return false

  let overlap = 0
  for (const token of tokensA) {
    if (tokensB.has(token)) {
      overlap += 1
    }
  }

  if (overlap / minTokenCount >= 0.8) {
    return true
  }

  const similarity = findBestMatch(canonicalA, [canonicalB]).bestMatch.rating
  return similarity >= 0.78
}

app.get('/api/health', async (_req, res) => {
  res.json({ ok: true })
})

const authRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a minute and try again.' }
})

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

app.post('/api/auth/verify-account', async (req, res) => {
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

app.post('/api/auth/google/confirm-account', async (req, res) => {
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

app.post('/api/migrate/ali', async (_req, res) => {
  // Disabled: this endpoint used to reassign every 'Ali' rating to the caller,
  // which caused every new signup to steal Ali's ratings. Kept as a 410 so
  // any stale clients that still call it fail loudly instead of doing damage.
  return res.status(410).json({ error: 'This migration endpoint is permanently disabled.' })
})

app.post('/api/admin/link-users', async (req, res) => {
  try {
    const { links } = req.body

    if (!Array.isArray(links)) {
      return res.status(400).json({ error: 'links must be an array' })
    }

    const results = []
    for (const { userName, email } of links) {
      const result = await pool.query(
        'UPDATE accounts SET email = $1 WHERE LOWER(user_name) = LOWER($2) RETURNING user_name, email',
        [email, userName]
      )
      if (result.rowCount > 0) {
        results.push({ userName: result.rows[0].user_name, email: result.rows[0].email, success: true })
      } else {
        results.push({ userName, email, success: false, error: 'User not found' })
      }
    }

    return res.json({ results })
  } catch (error) {
    console.error('Link users failed:', error)
    return res.status(400).json({ error: 'Failed to link users' })
  }
})

app.post('/api/admin/delete-user', async (req, res) => {
  try {
    const { userName } = req.body

    if (!userName) {
      return res.status(400).json({ error: 'userName is required' })
    }

    // Delete all related data
    const userResult = await pool.query('SELECT email, user_name FROM accounts WHERE LOWER(user_name) = LOWER($1)', [userName])
    if (userResult.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' })
    }

    const email = userResult.rows[0].email
    const actualUserName = userResult.rows[0].user_name

    // Delete ratings
    await pool.query('DELETE FROM ratings WHERE LOWER(user_name) = LOWER($1)', [actualUserName])

    // Delete follows
    await pool.query('DELETE FROM follows WHERE follower_email = $1 OR following_email = $1', [email])

    // Delete likes
    await pool.query('DELETE FROM rating_likes WHERE email = $1', [email])

    // Delete user preferences
    await pool.query('DELETE FROM user_preferences WHERE email = $1', [email])

    // Delete browser users
    await pool.query('DELETE FROM browser_users WHERE LOWER(user_name) = LOWER($1)', [actualUserName])

    // Delete login tokens
    await pool.query('DELETE FROM login_tokens WHERE email = $1', [email])

    // Delete account
    await pool.query('DELETE FROM accounts WHERE email = $1', [email])

    return res.json({ ok: true, message: `User ${userName} deleted successfully` })
  } catch (error) {
    console.error('Delete user failed:', error)
    return res.status(400).json({ error: 'Failed to delete user' })
  }
})

app.post('/api/admin/fix-ali', async (req, res) => {
  try {
    // Update accounts table
    const accountResult = await pool.query(
      `UPDATE accounts SET email = $1 WHERE LOWER(user_name) = LOWER($2) RETURNING user_name, email`,
      ['alisonyim3@gmail.com', 'Ali']
    )

    // Update ratings table - replace @Jarel with Ali
    const ratingsResult = await pool.query(
      `UPDATE ratings SET user_name = $1 WHERE user_name = $2 RETURNING id`,
      ['Ali', '@Jarel']
    )

    return res.json({
      ok: true,
      message: `Ali account fixed and ${ratingsResult.rowCount} ratings updated`,
      accountsUpdated: accountResult.rowCount,
      ratingsUpdated: ratingsResult.rowCount
    })
  } catch (error) {
    console.error('Fix Ali failed:', error)
    return res.status(400).json({ error: 'Failed to fix Ali account' })
  }
})

app.post('/api/users/session', async (req, res) => {
  const browserId = String(req.body?.browserId || '').trim()
  const incomingUserName = sanitizeUserName(String(req.body?.userName || '').trim())

  if (!browserId || browserId.length > 128) {
    return res.status(400).json({ error: 'browserId is required and must be valid' })
  }

  const existing = await pool.query(
    'SELECT user_name FROM browser_users WHERE browser_id = $1',
    [browserId]
  )

  if (!incomingUserName && existing.rowCount === 0) {
    return res.status(200).json({ requiresName: true, userName: '', token: '' })
  }

  const userName = incomingUserName || existing.rows[0].user_name
  const token = generateToken(userName, browserId)

  await pool.query(
    `
      INSERT INTO browser_users (browser_id, user_name)
      VALUES ($1, $2)
      ON CONFLICT (browser_id)
      DO UPDATE SET user_name = EXCLUDED.user_name
    `,
    [browserId, userName]
  )

  return res.json({ requiresName: false, userName, token })
})

app.post('/api/telemetry', async (req, res) => {
  const eventName = sanitizeText(String(req.body?.event || '').trim(), 80)
  const page = sanitizeText(String(req.body?.page || '').trim(), 40)
  const properties = req.body?.properties && typeof req.body.properties === 'object' ? req.body.properties : {}

  if (!eventName) {
    return res.status(400).json({ error: 'event is required' })
  }

  telemetryBuffer.push({
    eventName,
    page,
    properties,
    createdAt: new Date().toISOString(),
    userName: req.session?.userName || null
  })

  if (telemetryBuffer.length > 500) {
    telemetryBuffer.splice(0, telemetryBuffer.length - 500)
  }

  return res.json({ ok: true })
})

app.get('/api/telemetry', async (_req, res) => {
  res.json({ events: telemetryBuffer.slice(-50) })
})

app.post('/api/admin/migrate-photos-to-cloudinary', async (req, res) => {
  try {
    console.log('Starting photo migration to Cloudinary...')

    // Get all ratings with photos
    const allRatings = await pool.query(
      'SELECT id, photo, user_name FROM ratings WHERE photo IS NOT NULL AND photo != \'\' ORDER BY created_at DESC'
    )

    console.log(`Found ${allRatings.rows.length} ratings with photos`)

    let uploadedCount = 0
    let skippedCount = 0
    const errors = []

    for (let i = 0; i < allRatings.rows.length; i++) {
      const rating = allRatings.rows[i]
      try {
        console.log(`[${i + 1}/${allRatings.rows.length}] Processing rating ${rating.id}...`)

        // Skip if already a Cloudinary URL
        if (rating.photo.includes('cloudinary.com') || rating.photo.includes('res.cloudinary.com')) {
          console.log(`Skipping - already Cloudinary URL`)
          skippedCount++
          continue
        }

        // Skip if not a data URL or valid image
        if (!rating.photo.startsWith('data:image/')) {
          console.log(`Skipping - invalid photo format: ${rating.photo.substring(0, 50)}`)
          skippedCount++
          continue
        }

        console.log(`Uploading photo (${Math.round(rating.photo.length / 1024)}KB)...`)

        // Upload to Cloudinary with timeout and retry
        let result
        let retries = 0
        const maxRetries = 3

        while (retries < maxRetries) {
          try {
            result = await Promise.race([
              cloudinary.uploader.upload(rating.photo, {
                folder: 'matcha-ratings-migration',
                resource_type: 'auto',
                quality: 'auto',
                fetch_format: 'auto',
                timeout: 60000
              }),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Upload timeout after 60s')), 65000)
              )
            ])
            break // Success
          } catch (uploadError) {
            retries++
            console.error(`Upload attempt ${retries}/${maxRetries} failed:`, uploadError.message)
            if (retries < maxRetries) {
              await new Promise(resolve => setTimeout(resolve, 1000 * retries)) // Backoff
            } else {
              throw uploadError
            }
          }
        }

        // Update database with new URL
        await pool.query(
          'UPDATE ratings SET photo = $1 WHERE id = $2',
          [result.secure_url, rating.id]
        )

        uploadedCount++
        console.log(`✓ Migrated rating ${rating.id}`)

        // Small delay to avoid rate limiting
        if (i < allRatings.rows.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      } catch (error) {
        console.error(`✗ Failed rating ${rating.id}:`, error.message)
        errors.push({ ratingId: rating.id, error: error.message })
      }
    }

    console.log(`Migration complete: ${uploadedCount} uploaded, ${skippedCount} skipped, ${errors.length} errors`)

    return res.json({
      ok: true,
      message: `Photo migration complete`,
      uploadedCount,
      skippedCount,
      errorCount: errors.length,
      errors: errors.slice(0, 10)
    })
  } catch (error) {
    console.error('Photo migration failed:', error)
    return res.status(500).json({ error: 'Photo migration failed', details: String(error.message) })
  }
})

// Protect all /api routes with auth, except the migration endpoint
app.use('/api', (req, res, next) => {
  if (req.path === '/admin/migrate-photos-to-cloudinary') {
    console.log('Skipping auth for migration endpoint')
    return next()
  }
  return requireSession(req, res, next)
})

// Lets an already-logged-in (browser-only) user check if their account has a stable email on file.
app.get('/api/auth/link-status', async (req, res) => {
  const result = await pool.query(
    'SELECT email FROM accounts WHERE LOWER(user_name) = LOWER($1)',
    [req.session.userName]
  )
  return res.json({ linked: result.rowCount > 0, email: result.rows[0]?.email || null })
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

app.post('/api/ratings', requireSession, async (req, res) => {
  const userName = sanitizeUserName(String(req.body?.userName || '').trim())
  const photo = String(req.body?.photo || '').trim()
  const rating = Number(req.body?.rating)
  const greenness = Number(req.body?.greenness)
  const location = normalizeLocationText(req.body?.location || '')
  const thoughts = sanitizeText(req.body?.thoughts || '', 800)
  const flavorPreferences = typeof req.body?.flavorPreferences === 'object' ? req.body.flavorPreferences : {}

  if (!userName || !photo || Number.isNaN(rating) || Number.isNaN(greenness)) {
    return res.status(400).json({ error: 'Missing required rating fields' })
  }

  if (rating < 0 || rating > 5 || greenness < 0 || greenness > 100) {
    return res.status(400).json({ error: 'rating and greenness must be in valid ranges' })
  }

  if (photo.length > 500) {
    return res.status(413).json({ error: 'Photo URL is too long' })
  }

  if (userName.toLowerCase() !== req.session.userName.toLowerCase()) {
    return res.status(403).json({ error: 'Forbidden: user ownership mismatch' })
  }

  const inserted = await pool.query(
    `
      INSERT INTO ratings (user_name, photo, rating, greenness, location, thoughts, flavor_preferences)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `,
    [userName, photo, rating, greenness, location, thoughts, JSON.stringify(flavorPreferences)]
  )

  return res.status(201).json({ rating: mapRatingRow(inserted.rows[0]) })
})

app.post('/api/upload-image', async (req, res) => {
  try {
    const image = String(req.body?.image || '').trim()
    console.log('Image upload requested, data URL length:', image.length)

    if (!image || !image.startsWith('data:image/')) {
      console.error('Invalid image data:', image.substring(0, 50))
      return res.status(400).json({ error: 'Valid base64 image data is required' })
    }

    console.log('Uploading image to Cloudinary...')
    console.log('Cloud name:', process.env.CLOUDINARY_CLOUD_NAME)

    const result = await cloudinary.uploader.upload(image, {
      folder: 'matcha-ratings',
      resource_type: 'auto',
      quality: 'auto',
      fetch_format: 'auto'
    })

    console.log('Image uploaded successfully:', result.secure_url)
    return res.json({ url: result.secure_url })
  } catch (error) {
    console.error('Image upload failed:', error.message)
    console.error('Full error:', error)
    return res.status(500).json({ error: 'Image upload failed', details: String(error.message) })
  }
})

app.put('/api/ratings/:id', requireSession, async (req, res) => {
  const id = Number(req.params.id)
  const userName = sanitizeUserName(String(req.body?.userName || '').trim())
  const rating = Number(req.body?.rating)
  const incomingGreenness = req.body?.greenness
  const greenness = incomingGreenness === undefined || incomingGreenness === null ? null : Number(incomingGreenness)
  const location = normalizeLocationText(req.body?.location || '')
  const thoughts = sanitizeText(req.body?.thoughts || '', 800)
  const photo = req.body?.photo || null
  const rawFlavorPrefs = req.body?.flavorPreferences
  let flavorPreferencesJson = null
  if (rawFlavorPrefs && typeof rawFlavorPrefs === 'object') {
    const cleaned = {}
    for (const [k, v] of Object.entries(rawFlavorPrefs)) {
      const num = Number(v)
      if (!Number.isNaN(num) && num >= 0 && num <= 100) {
        cleaned[String(k)] = num
      }
    }
    flavorPreferencesJson = JSON.stringify(cleaned)
  }

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Valid rating id is required' })
  }

  if (!userName || Number.isNaN(rating)) {
    return res.status(400).json({ error: 'userName and rating are required' })
  }

  if (userName.toLowerCase() !== req.session.userName.toLowerCase()) {
    return res.status(403).json({ error: 'Forbidden: user ownership mismatch' })
  }

  if (greenness !== null && Number.isNaN(greenness)) {
    return res.status(400).json({ error: 'greenness must be a valid number when provided' })
  }

  if (rating < 0 || rating > 5 || (greenness !== null && (greenness < 0 || greenness > 100))) {
    return res.status(400).json({ error: 'rating and greenness must be in valid ranges' })
  }

  const updated = await pool.query(
    `
      UPDATE ratings
      SET rating = $3,
          greenness = COALESCE($4, greenness),
          location = $5,
          thoughts = $6,
          photo = COALESCE($7, photo),
          flavor_preferences = COALESCE($8::jsonb, flavor_preferences)
      WHERE id = $1 AND user_name = $2
      RETURNING *
    `,
    [id, userName, rating, greenness, location, thoughts, photo, flavorPreferencesJson]
  )

  if (updated.rowCount === 0) {
    return res.status(404).json({ error: 'Rating not found for this user' })
  }

  return res.json({ rating: mapRatingRow(updated.rows[0]) })
})

app.delete('/api/ratings/:id', requireSession, async (req, res) => {
  const id = Number(req.params.id)
  const userName = sanitizeUserName(String(req.query.userName || '').trim())

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Valid rating id is required' })
  }

  if (!userName) {
    return res.status(400).json({ error: 'userName query parameter is required' })
  }

  if (userName.toLowerCase() !== req.session.userName.toLowerCase()) {
    return res.status(403).json({ error: 'Forbidden: user ownership mismatch' })
  }

  const deleted = await pool.query(
    `
      DELETE FROM ratings
      WHERE id = $1 AND user_name = $2
      RETURNING id
    `,
    [id, userName]
  )

  if (deleted.rowCount === 0) {
    return res.status(404).json({ error: 'Rating not found for this user' })
  }

  return res.json({ deletedId: Number(deleted.rows[0].id) })
})

app.get('/api/ratings', async (req, res) => {
  const userName = sanitizeUserName(String(req.query.userName || '').trim())
  if (!userName) {
    return res.status(400).json({ error: 'userName query parameter is required' })
  }

  if (userName.toLowerCase() !== req.session.userName.toLowerCase()) {
    return res.status(403).json({ error: 'Forbidden: user ownership mismatch' })
  }

  const result = await pool.query(
    `
      SELECT *
      FROM ratings
      WHERE user_name = $1
      ORDER BY rating DESC, greenness DESC, created_at DESC
    `,
    [userName]
  )

  return res.json({ ratings: result.rows.map(mapRatingRow) })
})

app.get('/api/friends/search', async (req, res) => {
  const q = sanitizeText(String(req.query.q || '').trim(), 40)
  console.log('Raw query param:', req.query.q)
  console.log('Sanitized query:', q)

  if (!q || q.length < 1) {
    return res.json({ friends: [] })
  }

  try {
    // First check if accounts table has any data
    const allAccounts = await pool.query('SELECT user_name FROM accounts LIMIT 5')
    console.log('Sample accounts in DB:', allAccounts.rows.map(r => r.user_name))

    const result = await pool.query(
      `
        SELECT
          a.user_name,
          COUNT(DISTINCT r.location) as place_count
        FROM accounts a
        LEFT JOIN ratings r ON a.user_name = r.user_name AND r.location IS NOT NULL AND r.location != ''
        WHERE LOWER(a.user_name) LIKE LOWER($1)
        GROUP BY a.user_name
        ORDER BY place_count DESC, a.user_name ASC
        LIMIT 20
      `,
      [`%${q}%`]
    )

    console.log('Search query:', q, 'Results found:', result.rows.length, 'Rows:', result.rows.map(r => r.user_name))
    return res.json({ friends: result.rows.map((r) => ({ userName: r.user_name, placeCount: Number(r.place_count) })) })
  } catch (error) {
    console.error('Search failed:', error)
    return res.status(500).json({ error: 'Search failed', friends: [] })
  }
})

app.get('/api/friends/:friendName/ratings', async (req, res) => {
  const friendName = sanitizeUserName(String(req.params.friendName || '').trim())
  if (!friendName) {
    return res.status(400).json({ error: 'friendName is required' })
  }

  const result = await pool.query(
    `
      SELECT *
      FROM ratings
      WHERE LOWER(user_name) = LOWER($1)
      ORDER BY ((rating * 20) + (greenness * CASE WHEN rating >= 4 THEN ${FULL_GREENNESS_WEIGHT} ELSE ${LOW_RATING_GREENNESS_WEIGHT} END)) DESC, created_at DESC
    `,
    [friendName]
  )

  return res.json({
    friendName,
    ratings: result.rows.map(mapRatingRow)
  })
})

app.get('/api/explore/places', async (req, res) => {
  const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 10))

  try {
    const result = await pool.query(
      `
        SELECT location, AVG(rating::numeric) as avg_rating, AVG(greenness::numeric) as avg_greenness, COUNT(*) as entry_count
        FROM ratings
        WHERE TRIM(location) <> ''
        GROUP BY location
      `
    )

    const placeBuckets = new Map()

    for (const row of result.rows) {
      const { displayName, canonicalKey } = getCanonicalPlaceData(row.location)
      if (!displayName || !canonicalKey) continue

      const rating = Number(row.avg_rating)
      const greenness = Number(row.avg_greenness)
      const scoreOutOf200 = getWeightedScore(rating, greenness)

      const existing = placeBuckets.get(canonicalKey)
      if (existing) {
        existing.totalScore += scoreOutOf200
        existing.entryCount += Number(row.entry_count)
      } else {
        placeBuckets.set(canonicalKey, {
          placeName: displayName,
          canonicalKey,
          totalScore: scoreOutOf200,
          entryCount: Number(row.entry_count)
        })
      }
    }

    const mergedBuckets = []
    for (const bucket of placeBuckets.values()) {
      const existingCluster = mergedBuckets.find((cluster) => shouldMergePlaces(cluster.canonicalKey, bucket.canonicalKey))

      if (!existingCluster) {
        mergedBuckets.push({ ...bucket })
        continue
      }

      existingCluster.totalScore += bucket.totalScore
      existingCluster.entryCount += bucket.entryCount

      if (bucket.placeName.length < existingCluster.placeName.length) {
        existingCluster.placeName = bucket.placeName
      }
    }

    const places = mergedBuckets
      .sort((a, b) => {
        const bAverage = b.totalScore / b.entryCount
        const aAverage = a.totalScore / a.entryCount
        if (bAverage !== aAverage) return bAverage - aAverage
        return b.entryCount - a.entryCount
      })
      .slice(0, limit)
      .map((place, index) => ({
        rank: index + 1,
        placeName: place.placeName,
        entryCount: place.entryCount,
        averageScore: Number((place.totalScore / place.entryCount).toFixed(1))
      }))

    return res.json({ places })
  } catch (error) {
    console.error('Explore places error:', error)
    return res.status(500).json({ error: 'Failed to load places' })
  }
})

app.get('/api/explore/places/:placeName/ratings', async (req, res) => {
  const rawPlaceName = String(req.params.placeName || '').trim()
  if (!rawPlaceName) {
    return res.status(400).json({ error: 'placeName is required' })
  }

  const { displayName, canonicalKey } = getCanonicalPlaceData(rawPlaceName)
  if (!displayName || !canonicalKey) {
    return res.json({ placeName: rawPlaceName, ratings: [] })
  }

  const result = await pool.query(
    `
      SELECT *
      FROM ratings
      WHERE TRIM(location) <> ''
    `
  )

  const ratings = result.rows
    .map((row) => ({
      row,
      canonicalKey: getCanonicalPlaceData(row.location).canonicalKey
    }))
    .filter((item) => item.canonicalKey && shouldMergePlaces(item.canonicalKey, canonicalKey))
    .map((item) => mapRatingRow(item.row))
    .sort((a, b) => {
      const scoreB = getWeightedScore(b.rating, b.greenness)
      const scoreA = getWeightedScore(a.rating, a.greenness)
      if (scoreB !== scoreA) return scoreB - scoreA
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    })

  return res.json({
    placeName: displayName,
    ratings
  })
})

app.get('/api/explore/users', async (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50))

  try {
    const result = await pool.query(
      `
        SELECT user_name, COUNT(DISTINCT location) as place_count
        FROM ratings
        WHERE TRIM(location) <> ''
        GROUP BY user_name
        ORDER BY place_count DESC, user_name ASC
        LIMIT $1
      `,
      [limit * 2]
    )

    const users = result.rows
      .map((row) => ({
        userName: String(row.user_name || '').trim(),
        placeCount: Number(row.place_count)
      }))
      .filter((u) => u.userName)
      .slice(0, limit)

    return res.json({ users })
  } catch (error) {
    console.error('Explore users error:', error)
    return res.status(500).json({ error: 'Failed to load users' })
  }
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

// Follow/unfollow endpoints
app.post('/api/follows/:targetUserName', async (req, res) => {
  const followerEmail = (await pool.query('SELECT email FROM accounts WHERE LOWER(user_name) = LOWER($1)', [req.session.userName])).rows[0]?.email
  if (!followerEmail) return res.status(404).json({ error: 'Your account not found' })

  const followingEmail = (await pool.query('SELECT email FROM accounts WHERE LOWER(user_name) = LOWER($1)', [req.params.targetUserName])).rows[0]?.email
  if (!followingEmail) return res.status(404).json({ error: 'Target user not found' })
  if (followerEmail === followingEmail) return res.status(400).json({ error: 'Cannot follow yourself' })

  try {
    await pool.query(
      `INSERT INTO follows (follower_email, following_email) VALUES ($1, $2)`,
      [followerEmail, followingEmail]
    )
    return res.json({ ok: true })
  } catch (error) {
    if ((error).code === '23505') return res.status(409).json({ error: 'Already following' })
    throw error
  }
})

app.delete('/api/follows/:targetUserName', async (req, res) => {
  const followerEmail = (await pool.query('SELECT email FROM accounts WHERE LOWER(user_name) = LOWER($1)', [req.session.userName])).rows[0]?.email
  if (!followerEmail) return res.status(404).json({ error: 'Your account not found' })

  const followingEmail = (await pool.query('SELECT email FROM accounts WHERE LOWER(user_name) = LOWER($1)', [req.params.targetUserName])).rows[0]?.email
  if (!followingEmail) return res.status(404).json({ error: 'Target user not found' })

  await pool.query(
    `DELETE FROM follows WHERE follower_email = $1 AND following_email = $2`,
    [followerEmail, followingEmail]
  )
  return res.json({ ok: true })
})

app.get('/api/follows/check/:targetUserName', async (req, res) => {
  const followerEmail = (await pool.query('SELECT email FROM accounts WHERE LOWER(user_name) = LOWER($1)', [req.session.userName])).rows[0]?.email
  if (!followerEmail) return res.status(404).json({ error: 'Your account not found' })

  const followingEmail = (await pool.query('SELECT email FROM accounts WHERE LOWER(user_name) = LOWER($1)', [req.params.targetUserName])).rows[0]?.email
  if (!followingEmail) return res.status(404).json({ error: 'Target user not found' })

  const result = await pool.query(
    `SELECT 1 FROM follows WHERE follower_email = $1 AND following_email = $2`,
    [followerEmail, followingEmail]
  )
  return res.json({ isFollowing: result.rowCount > 0 })
})

app.get('/api/follows/list', async (req, res) => {
  const email = (await pool.query('SELECT email FROM accounts WHERE LOWER(user_name) = LOWER($1)', [req.session.userName])).rows[0]?.email
  if (!email) return res.status(404).json({ error: 'Your account not found' })

  const result = await pool.query(
    `SELECT a.user_name FROM follows f
     JOIN accounts a ON f.following_email = a.email
     WHERE f.follower_email = $1
     ORDER BY a.user_name`,
    [email]
  )
  return res.json({ following: result.rows.map(r => r.user_name) })
})

// Find users with similar flavor preferences
app.get('/api/similar-users', async (req, res) => {
  const userName = sanitizeUserName(String(req.query.userName || '').trim())
  if (!userName) {
    return res.status(400).json({ error: 'userName is required' })
  }

  try {
    // Get current user's flavor preferences
    const userPrefsResult = await pool.query(
      `SELECT flavors FROM user_preferences WHERE email = (SELECT email FROM accounts WHERE LOWER(user_name) = LOWER($1))`,
      [userName]
    )

    if (userPrefsResult.rowCount === 0) {
      return res.json({ similarUsers: [] })
    }

    const userFlavors = userPrefsResult.rows[0].flavors || {}
    const userFlavorsList = Object.keys(userFlavors).filter(f => userFlavors[f])

    if (userFlavorsList.length === 0) {
      return res.json({ similarUsers: [] })
    }

    // Find other users with matching flavors
    const result = await pool.query(
      `
        SELECT DISTINCT a.user_name, up.flavors, up.milk_type,
          (SELECT COUNT(*) FROM ratings WHERE user_name = a.user_name) as rating_count
        FROM accounts a
        LEFT JOIN user_preferences up ON a.email = up.email
        WHERE LOWER(a.user_name) != LOWER($1)
          AND up.flavors IS NOT NULL
        ORDER BY rating_count DESC
        LIMIT 100
      `,
      [userName]
    )

    // Score users based on flavor preference overlap
    const similarUsers = result.rows
      .map((row) => {
        const otherFlavors = row.flavors || {}
        const otherFlavorsList = Object.keys(otherFlavors).filter(f => otherFlavors[f])
        const matchCount = userFlavorsList.filter(f => otherFlavorsList.includes(f)).length
        const matchScore = matchCount > 0 ? (matchCount / Math.max(userFlavorsList.length, otherFlavorsList.length)) : 0

        return {
          userName: row.user_name,
          flavors: otherFlavorsList,
          milkTypes: row.milk_type || [],
          ratingCount: row.rating_count || 0,
          matchScore: matchScore
        }
      })
      .filter(u => u.matchScore > 0)
      .sort((a, b) => b.matchScore - a.matchScore)

    return res.json({ similarUsers })
  } catch (error) {
    console.error('Similar users lookup failed:', error)
    return res.status(500).json({ error: 'Failed to find similar users' })
  }
})

// Find places with similar flavor profiles
app.get('/api/similar-places', async (req, res) => {
  const flavorsParam = String(req.query.flavors || '').trim()
  const userBody = String(req.query.body || '').trim()
  const userName = String(req.query.userName || '').trim()
  if (!flavorsParam && !userBody) {
    return res.status(400).json({ error: 'flavors parameter is required' })
  }

  try {
    const userFlavorsRaw = flavorsParam.split(',').map(f => f.trim()).filter(f => f)
    const userFlavorsLower = userFlavorsRaw.map(f => f.toLowerCase())
    const userFlavorSet = new Set(userFlavorsLower)

    if (userFlavorsRaw.length === 0 && !userBody) {
      return res.json({ similarPlaces: [] })
    }

    // Pull the current user's already-rated locations so we can exclude them
    // from recommendations - recs should surface NEW places, not remind the
    // user of somewhere they've already logged.
    let visitedLocations = new Set()
    if (userName) {
      try {
        const visited = await pool.query(
          `SELECT DISTINCT LOWER(TRIM(location)) AS loc
             FROM ratings
             WHERE LOWER(user_name) = LOWER($1)
               AND location IS NOT NULL AND location <> ''`,
          [userName]
        )
        visitedLocations = new Set(visited.rows.map(r => r.loc))
      } catch (err) {
        console.warn('Could not load visited locations for recs personalization:', err.message)
      }
    }

    // Pull EVERY rating that has flavor preferences, not just the most recent
    // per location. Aggregating across all raters gives us a much more
    // trustworthy signature for each place.
    const result = await pool.query(
      `
        SELECT r.location, r.flavor_preferences, r.rating
        FROM ratings r
        WHERE r.location IS NOT NULL
          AND r.location != ''
          AND r.flavor_preferences IS NOT NULL
        LIMIT 5000
      `
    )

    // Group ratings by location, then build a frequency profile of flavors
    // Canonical flavor allowlist. Anything not in this set is treated as
    // legacy/junk data (e.g. old "bold" body value written before body moved
    // to the __body:* namespace) and is ignored for aggregation + display.
    const KNOWN_FLAVORS = new Set([
      'sweet', 'nutty', 'umami', 'vegetal', 'sugary', 'astringent',
      'creamy', 'floral', 'earthy', 'chocolatey', 'mellow', 'bitter'
    ])

    // Aggregate per-location: track how often each flavor is chosen (>=75)
    // and body-profile choices across all raters at that place.
    const byLocation = new Map()
    for (const row of result.rows) {
      const key = row.location
      let g = byLocation.get(key)
      if (!g) {
        g = { flavorCounts: {}, bodyCounts: {}, total: 0, ratingSum: 0 }
        byLocation.set(key, g)
      }
      g.total += 1
      g.ratingSum += Number(row.rating) || 0
      const prefs = row.flavor_preferences || {}
      for (const [k, v] of Object.entries(prefs)) {
        if (Number(v) < 75) continue
        if (k.startsWith('__body:')) {
          const body = k.slice('__body:'.length)
          g.bodyCounts[body] = (g.bodyCounts[body] || 0) + 1
        } else if (!k.startsWith('__') && KNOWN_FLAVORS.has(String(k).toLowerCase())) {
          const flavorKey = String(k).toLowerCase()
          g.flavorCounts[flavorKey] = (g.flavorCounts[flavorKey] || 0) + 1
        }
      }
    }

    const similarPlaces = []
    for (const [location, g] of byLocation) {
      if (g.total === 0) continue

      // Skip places the current user has already rated.
      if (visitedLocations.has(String(location).toLowerCase().trim())) continue

      // A flavor is "canonical" for a place if >= 40% of raters marked it,
      // OR (if none reach that bar) fall back to the top 3 most-mentioned.
      const threshold = Math.max(1, Math.ceil(g.total * 0.4))
      const flavorEntries = Object.entries(g.flavorCounts).sort((a, b) => b[1] - a[1])
      let canonicalFlavors = flavorEntries.filter(([, c]) => c >= threshold).map(([k]) => k)
      if (canonicalFlavors.length === 0) {
        canonicalFlavors = flavorEntries.slice(0, 3).map(([k]) => k)
      }

      // Place body: majority vote, must clear the same 40% threshold.
      let placeBody = ''
      const bodyEntries = Object.entries(g.bodyCounts).sort((a, b) => b[1] - a[1])
      if (bodyEntries.length > 0 && bodyEntries[0][1] >= threshold) {
        placeBody = bodyEntries[0][0]
      }

      // === Personalized flavor scoring ===
      // We compute three sub-signals and blend them:
      //
      // 1. userCoverage: of the flavors the user picked, how many does this
      //    place actually hit, weighted by how many raters agreed on each
      //    (so a place where 100% of raters call out "nutty" is a stronger
      //    "nutty" hit than one where only 40% did).
      //
      // 2. placeCoverage: of this place's canonical flavor profile, how
      //    much of it lines up with what the user wants. This penalizes
      //    places whose signature is mostly flavors the user did NOT
      //    select (e.g. an earthy/vegetal place recommended to a sweet
      //    lover just because it happens to also be nutty).
      //
      // 3. mismatchPenalty: subtracts a smaller amount for each canonical
      //    flavor the user did NOT choose, weighted by its prevalence,
      //    so a place with 4 non-user flavors is worse than one with 1.
      let userWeightedHits = 0
      for (const uf of userFlavorsLower) {
        const c = g.flavorCounts[uf] || 0
        if (c > 0) userWeightedHits += c / g.total // 0..1 per flavor
      }
      const userCoverage = userWeightedHits / Math.max(1, userFlavorsLower.length)

      let placeMatched = 0
      let placeMismatched = 0
      let placeMismatchWeighted = 0
      for (const cf of canonicalFlavors) {
        const cfKey = String(cf).toLowerCase()
        const prevalence = (g.flavorCounts[cfKey] || 0) / g.total // 0..1
        if (userFlavorSet.has(cfKey)) {
          placeMatched += 1
        } else {
          placeMismatched += 1
          placeMismatchWeighted += prevalence
        }
      }
      const placeCoverage = placeMatched / Math.max(1, canonicalFlavors.length)
      const mismatchPenalty = placeMismatched > 0
        ? Math.min(0.35, placeMismatchWeighted / Math.max(1, canonicalFlavors.length) * 0.5)
        : 0

      // Blend user-side + place-side coverage. userCoverage says "does this
      // place tick the boxes I want", placeCoverage says "is this place
      // mostly ABOUT the things I want". Both matter for a personal rec.
      const flavorScore = Math.max(
        0,
        (0.55 * userCoverage) + (0.45 * placeCoverage) - mismatchPenalty
      ) // 0..1

      const bodyMatch = userBody && placeBody && userBody === placeBody
      const bodyMismatch = userBody && placeBody && userBody !== placeBody

      // Quality factor from avg star rating: 0.5 (bad) .. 1.0 (5-star).
      const avgRating = g.ratingSum / g.total
      const qualityFactor = 0.5 + Math.max(0, Math.min(5, avgRating)) / 10

      // Combine sub-signals. Flavor is the dominant personal signal; body
      // match is a meaningful bonus when the user has a body pref; quality
      // nudges ties. A body mismatch dings the score a bit so we don't
      // recommend a milky lover a full-bodied place.
      let matchScore = userBody
        ? (flavorScore * 0.60) + (bodyMatch ? 0.28 : (bodyMismatch ? -0.05 : 0)) + (qualityFactor * 0.12)
        : (flavorScore * 0.80) + (qualityFactor * 0.20)

      // Confidence: places with more ratings get up to a 30% boost, single
      // ratings get downweighted so one rater's opinion doesn't dominate.
      const confidence = Math.min(1.3, 0.7 + 0.15 * Math.sqrt(g.total))
      matchScore *= confidence

      // Penalize harsh signature flavors unless user opted in.
      const hasHarshFlavor = canonicalFlavors.some(f => f === 'bitter' || f === 'astringent')
      const userLikesHarsh = userFlavorSet.has('bitter') || userFlavorSet.has('astringent')
      if (hasHarshFlavor && !userLikesHarsh) {
        matchScore *= 0.5
      }

      // Require SOME real personal signal before surfacing a place.
      const hasFlavorSignal = userWeightedHits > 0 || placeMatched > 0
      if (matchScore <= 0 || (!hasFlavorSignal && !bodyMatch)) continue

      similarPlaces.push({
        location,
        flavors: canonicalFlavors.slice(0, 5),
        body: placeBody,
        matchScore: Math.max(0, Math.min(1, matchScore)),
        ratingCount: g.total
      })
    }

    similarPlaces.sort((a, b) => b.matchScore - a.matchScore || b.ratingCount - a.ratingCount)

    return res.json({ similarPlaces: similarPlaces.slice(0, 20) })
  } catch (error) {
    console.error('Similar places lookup failed:', error)
    return res.status(500).json({ error: 'Failed to find similar places' })
  }
})

// Like/unlike rating endpoints
app.post('/api/ratings/:ratingId/like', requireSession, async (req, res) => {
  const ratingId = Number(req.params.ratingId)
  const email = (await pool.query('SELECT email FROM accounts WHERE LOWER(user_name) = LOWER($1)', [req.session.userName])).rows[0]?.email
  if (!email) return res.status(404).json({ error: 'Your account not found' })

  try {
    await pool.query(
      `INSERT INTO rating_likes (rating_id, email) VALUES ($1, $2)`,
      [ratingId, email]
    )
    return res.json({ ok: true })
  } catch (error) {
    if ((error).code === '23505') return res.status(409).json({ error: 'Already liked' })
    throw error
  }
})

app.delete('/api/ratings/:ratingId/like', requireSession, async (req, res) => {
  const ratingId = Number(req.params.ratingId)
  const email = (await pool.query('SELECT email FROM accounts WHERE LOWER(user_name) = LOWER($1)', [req.session.userName])).rows[0]?.email
  if (!email) return res.status(404).json({ error: 'Your account not found' })

  await pool.query(
    `DELETE FROM rating_likes WHERE rating_id = $1 AND email = $2`,
    [ratingId, email]
  )
  return res.json({ ok: true })
})

app.get('/api/ratings/:ratingId/likes', async (req, res) => {
  const ratingId = Number(req.params.ratingId)
  const result = await pool.query(
    `SELECT COUNT(*) as count FROM rating_likes WHERE rating_id = $1`,
    [ratingId]
  )
  return res.json({ likeCount: Number(result.rows[0].count) })
})

// Find users with similar flavor preferences
app.get('/api/users/similar-preferences', async (req, res) => {
  const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 20))

  try {
    // Get current user's preferences
    const userEmail = (await pool.query('SELECT email FROM accounts WHERE LOWER(user_name) = LOWER($1)', [req.session.userName])).rows[0]?.email
    if (!userEmail) return res.status(404).json({ error: 'User not found' })

    // Get all users and their flavor preferences, ordered by rating count
    const result = await pool.query(
      `
        SELECT DISTINCT a.user_name, COUNT(DISTINCT r.id) as ratings_count
        FROM accounts a
        LEFT JOIN ratings r ON LOWER(a.user_name) = LOWER(r.user_name)
        WHERE LOWER(a.user_name) != LOWER($1)
        GROUP BY a.user_name
        ORDER BY ratings_count DESC
        LIMIT $2
      `,
      [req.session.userName, limit]
    )

    return res.json({
      users: result.rows.map(r => ({
        userName: r.user_name,
        ratingsCount: Number(r.ratings_count)
      }))
    })
  } catch (error) {
    console.error('Similar preferences error:', error)
    return res.status(500).json({ error: 'Failed to find similar users' })
  }
})

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

async function start() {
  await initDb()

  // Link users to emails (one-time initialization)
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

  app.listen(port, () => {
    console.log(`API server running on http://localhost:${port}`)
  })
}

start().catch((error) => {
  console.error('Failed to start API server:', error)
  process.exit(1)
})
