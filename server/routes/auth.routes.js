import express from 'express'
import crypto from 'node:crypto'
import { pool } from '../db.js'
import {
  sanitizeUserName,
  normalizeEmail,
  isValidEmail,
} from '../lib/sanitize.js'
import {
  generateToken,
  hashLoginToken,
} from '../lib/crypto.js'
import { requireSession } from '../lib/session.js'
import { authRateLimiter } from '../lib/rateLimits.js'
import { googleClient } from '../lib/googleAuth.js'
import {
  APP_ORIGIN,
  createLoginToken,
  sendMagicLinkEmail,
} from '../lib/mailer.js'
import { DEMO_USER_NAME, DEMO_PHOTO_BASE } from '../lib/constants.js'

const router = express.Router()

router.post('/api/auth/request-link', authRateLimiter, async (req, res) => {
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

router.post('/api/auth/verify', authRateLimiter, async (req, res) => {
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

router.post('/api/auth/google/verify', authRateLimiter, async (req, res) => {
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

router.post('/api/auth/verify-account', authRateLimiter, async (req, res) => {
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

router.post('/api/auth/google/confirm-account', authRateLimiter, async (req, res) => {
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

router.get('/api/auth/link-status', requireSession, async (req, res) => {
  const result = await pool.query(
    'SELECT email FROM accounts WHERE LOWER(user_name) = LOWER($1)',
    [req.session.userName]
  )
  return res.json({ linked: result.rowCount > 0, email: result.rows[0]?.email || null })
})

router.get('/api/auth/check-username', async (req, res) => {
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

// Base URL for demo-only static photo assets. Points to the GitHub Pages
// build so the images load correctly whether the demo runs on Render or on
// the GH Pages mirror. Files are checked in at public/demo/*.png.
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

router.post('/api/auth/demo', authRateLimiter, async (req, res) => {
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

router.post('/api/auth/demo/cleanup', requireSession, async (_req, res) => {
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

router.post('/api/auth/link-email', authRateLimiter, requireSession, async (req, res) => {
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


export default router
