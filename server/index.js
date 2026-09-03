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
  return jwt.sign({ userName, browserId: browserId || '' }, JWT_SECRET, { expiresIn: '7d' })
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
    comboScore: Number(getWeightedScore(rating, greenness).toFixed(2))
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

    await pool.query(
      'INSERT INTO accounts (email, user_name) VALUES ($1, $2)',
      [record.email, record.user_name]
    )
    userName = record.user_name
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
        // Link existing email account to this Google ID
        const existingUserName = emailExists.rows[0].user_name
        await pool.query(
          'UPDATE accounts SET google_id = $1 WHERE email = $2',
          [googleId, email]
        )
        userName = `@${existingUserName}`
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

        // Check if username is available
        const nameTaken = await pool.query(
          'SELECT 1 FROM accounts WHERE LOWER(user_name) = LOWER($1)',
          [sanitizedName]
        )

        const finalName = nameTaken.rowCount > 0 ? `${sanitizedName}_${googleId.slice(0, 6)}` : sanitizedName

        await pool.query(
          'INSERT INTO accounts (email, user_name, google_id) VALUES ($1, $2, $3)',
          [email, finalName, googleId]
        )
        userName = finalName
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

app.post('/api/migrate/ali', async (req, res) => {
  const token = String(req.headers.authorization || '').replace('Bearer ', '').trim()

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: please sign in first' })
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET)
    const currentUserName = payload.userName

    const aliAccount = await pool.query(
      'SELECT id, email, user_name FROM accounts WHERE LOWER(user_name) = LOWER($1)',
      ['Ali']
    )

    if (aliAccount.rowCount === 0) {
      return res.status(404).json({ error: 'Ali account not found' })
    }

    const ali = aliAccount.rows[0]

    if (ali.email !== 'alisonyim3@gmail.com') {
      return res.status(400).json({ error: 'Email mismatch: Ali account not linked to alisonyim3@gmail.com' })
    }

    const aliAccountId = ali.id

    await pool.query('BEGIN')

    await pool.query(
      'UPDATE ratings SET user_name = $1 WHERE user_name = $2',
      [currentUserName, 'Ali']
    )

    await pool.query('COMMIT')

    return res.json({
      success: true,
      message: `Migrated all Ali ratings to ${currentUserName}`,
      migratedCount: (await pool.query(
        'SELECT COUNT(*) FROM ratings WHERE user_name = $1',
        [currentUserName]
      )).rows[0].count
    })
  } catch (error) {
    await pool.query('ROLLBACK').catch(() => null)
    console.error('Migration failed:', error)
    if (error instanceof Error && error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token' })
    }
    return res.status(400).json({ error: 'Migration failed' })
  }
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
    const userResult = await pool.query('SELECT email FROM accounts WHERE LOWER(user_name) = LOWER($1)', [userName])
    if (userResult.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' })
    }

    const email = userResult.rows[0].email

    // Delete ratings
    await pool.query('DELETE FROM ratings WHERE user_name = $1', [userName])

    // Delete follows
    await pool.query('DELETE FROM follows WHERE follower_email = $1 OR following_email = $1', [email])

    // Delete likes
    await pool.query('DELETE FROM rating_likes WHERE email = $1', [email])

    // Delete user preferences
    await pool.query('DELETE FROM user_preferences WHERE email = $1', [email])

    // Delete browser users
    await pool.query('DELETE FROM browser_users WHERE user_name = $1', [userName])

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
    const result = await pool.query(
      `UPDATE accounts SET email = $1 WHERE LOWER(user_name) = LOWER($2) RETURNING user_name, email`,
      ['alisonyim3@gmail.com', 'Ali']
    )

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Ali account not found' })
    }

    return res.json({ ok: true, message: `Ali linked to alisonyim3@gmail.com`, user: result.rows[0] })
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

app.use('/api', requireSession)

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

app.post('/api/ratings', async (req, res) => {
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
    if (!image || !image.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Valid base64 image data is required' })
    }

    const result = await cloudinary.uploader.upload(image, {
      folder: 'matcha-ratings',
      resource_type: 'auto',
      quality: 'auto',
      fetch_format: 'auto'
    })

    return res.json({ url: result.secure_url })
  } catch (error) {
    console.error('Image upload failed:', error)
    return res.status(500).json({ error: 'Image upload failed' })
  }
})

app.put('/api/ratings/:id', async (req, res) => {
  const id = Number(req.params.id)
  const userName = sanitizeUserName(String(req.body?.userName || '').trim())
  const rating = Number(req.body?.rating)
  const incomingGreenness = req.body?.greenness
  const greenness = incomingGreenness === undefined || incomingGreenness === null ? null : Number(incomingGreenness)
  const location = normalizeLocationText(req.body?.location || '')
  const thoughts = sanitizeText(req.body?.thoughts || '', 800)

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
          thoughts = $6
      WHERE id = $1 AND user_name = $2
      RETURNING *
    `,
    [id, userName, rating, greenness, location, thoughts]
  )

  if (updated.rowCount === 0) {
    return res.status(404).json({ error: 'Rating not found for this user' })
  }

  return res.json({ rating: mapRatingRow(updated.rows[0]) })
})

app.delete('/api/ratings/:id', async (req, res) => {
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
  if (!q) {
    return res.json({ friends: [] })
  }

  if (q.length < 1) {
    return res.json({ friends: [] })
  }

  try {
    const result = await pool.query(
      `
        SELECT DISTINCT user_name
        FROM accounts
        WHERE LOWER(user_name) LIKE LOWER($1)
        ORDER BY user_name ASC
        LIMIT 20
      `,
      [`%${q}%`]
    )

    return res.json({ friends: result.rows.map((r) => r.user_name) })
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
      WHERE user_name = $1
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
  const email = req.body?.email || (await pool.query('SELECT email FROM accounts WHERE LOWER(user_name) = LOWER($1)', [req.session.userName])).rows[0]?.email
  if (!email) return res.status(404).json({ error: 'User not found' })

  const result = await pool.query('SELECT * FROM user_preferences WHERE email = $1', [email])
  const prefs = result.rows[0] || { flavors: [], milk_type: [], visited_countries: [] }
  return res.json(prefs)
})

app.post('/api/preferences', async (req, res) => {
  const email = req.body?.email || (await pool.query('SELECT email FROM accounts WHERE LOWER(user_name) = LOWER($1)', [req.session.userName])).rows[0]?.email
  if (!email) return res.status(404).json({ error: 'User not found' })

  const flavors = Array.isArray(req.body?.flavors) ? req.body.flavors : []
  const milkType = Array.isArray(req.body?.milk_type) ? req.body.milk_type : []

  const result = await pool.query(
    `INSERT INTO user_preferences (email, flavors, milk_type, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (email) DO UPDATE SET flavors = $2, milk_type = $3, updated_at = NOW()
     RETURNING *`,
    [email, JSON.stringify(flavors), JSON.stringify(milkType)]
  )
  return res.json(result.rows[0])
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

// Like/unlike rating endpoints
app.post('/api/ratings/:ratingId/like', async (req, res) => {
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

app.delete('/api/ratings/:ratingId/like', async (req, res) => {
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
