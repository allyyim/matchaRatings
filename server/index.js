import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import * as Sentry from '@sentry/node'
import rateLimit from 'express-rate-limit'
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
  return jwt.sign({ userName, browserId }, JWT_SECRET, { expiresIn: '7d' })
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
    if (!userName || !browserId) return null

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
    photo: decryptField(row.photo),
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

app.post('/api/ratings', async (req, res) => {
  const userName = sanitizeUserName(String(req.body?.userName || '').trim())
  const photo = String(req.body?.photo || '').trim()
  const rating = Number(req.body?.rating)
  const greenness = Number(req.body?.greenness)
  const location = normalizeLocationText(req.body?.location || '')
  const thoughts = sanitizeText(req.body?.thoughts || '', 800)

  if (!userName || !photo || !photo.startsWith('data:image/') || Number.isNaN(rating) || Number.isNaN(greenness)) {
    return res.status(400).json({ error: 'Missing required rating fields' })
  }

  if (rating < 0 || rating > 5 || greenness < 0 || greenness > 100) {
    return res.status(400).json({ error: 'rating and greenness must be in valid ranges' })
  }

  if (photo.length > 15_000_000) {
    return res.status(413).json({ error: 'Photo is too large' })
  }

  if (userName.toLowerCase() !== req.session.userName.toLowerCase()) {
    return res.status(403).json({ error: 'Forbidden: user ownership mismatch' })
  }

  const inserted = await pool.query(
    `
      INSERT INTO ratings (user_name, photo, rating, greenness, location, thoughts)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `,
    [userName, encryptField(photo), rating, greenness, location, thoughts]
  )

  return res.status(201).json({ rating: mapRatingRow(inserted.rows[0]) })
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

  if (q.length < 2) {
    return res.json({ friends: [] })
  }

  const result = await pool.query(
    `
      SELECT DISTINCT user_name
      FROM ratings
      WHERE user_name ILIKE $1
      ORDER BY user_name ASC
      LIMIT 20
    `,
    [`%${q}%`]
  )

  return res.json({ friends: result.rows.map((r) => r.user_name) })
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

  const result = await pool.query(
    `
      SELECT location, rating, greenness
      FROM ratings
      WHERE TRIM(location) <> ''
    `
  )

  const placeBuckets = new Map()

  for (const row of result.rows) {
    const { displayName, canonicalKey } = getCanonicalPlaceData(row.location)
    if (!displayName || !canonicalKey) continue

    const rating = Number(row.rating)
    const greenness = Number(row.greenness)
    const scoreOutOf200 = getWeightedScore(rating, greenness)

    const existing = placeBuckets.get(canonicalKey)
    if (existing) {
      existing.totalScore += scoreOutOf200
      existing.entryCount += 1
    } else {
      placeBuckets.set(canonicalKey, {
        placeName: displayName,
        canonicalKey,
        totalScore: scoreOutOf200,
        entryCount: 1
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

  const result = await pool.query(
    `
      SELECT user_name, location
      FROM ratings
      WHERE TRIM(location) <> ''
    `
  )

  const userPlaces = new Map()

  for (const row of result.rows) {
    const userName = String(row.user_name || '').trim()
    const { canonicalKey } = getCanonicalPlaceData(row.location)
    if (!userName || !canonicalKey) continue

    if (!userPlaces.has(userName)) {
      userPlaces.set(userName, new Set())
    }
    userPlaces.get(userName).add(canonicalKey)
  }

  const users = [...userPlaces.entries()]
    .map(([userName, places]) => ({
      userName,
      placeCount: places.size
    }))
    .sort((a, b) => {
      if (b.placeCount !== a.placeCount) return b.placeCount - a.placeCount
      return a.userName.localeCompare(b.userName)
    })
    .slice(0, limit)

  return res.json({ users })
})

app.use((err, _req, res, _next) => {
  console.error(err)
  res.status(500).json({ error: 'Internal server error' })
})

async function start() {
  await initDb()
  app.listen(port, () => {
    console.log(`API server running on http://localhost:${port}`)
  })
}

start().catch((error) => {
  console.error('Failed to start API server:', error)
  process.exit(1)
})
