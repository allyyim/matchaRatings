import express from 'express'
import { v2 as cloudinary } from 'cloudinary'
import { pool } from '../db.js'
import { sanitizeUserName } from '../lib/sanitize.js'
import { recsCacheInvalidate } from '../lib/recsCache.js'
import { DEMO_USER_NAME } from '../lib/constants.js'

const router = express.Router()

router.get('/api/preferences', async (req, res) => {
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

router.post('/api/preferences', async (req, res) => {
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

router.post('/api/account/email', async (req, res) => {
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

router.post('/api/account/username', async (req, res) => {
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

router.post('/api/account/avatar', async (req, res) => {
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

router.get('/api/account/me', async (req, res) => {
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

router.get('/api/users/:userName/preferences', async (req, res) => {
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


export default router
