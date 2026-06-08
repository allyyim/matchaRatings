import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { initDb, pool } from './db.js'

dotenv.config()

const app = express()
const port = Number(process.env.PORT || 4000)

app.use(cors())
app.use(express.json({ limit: '15mb' }))

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
    comboScore: Number((rating * 20 + greenness).toFixed(2))
  }
}

function normalizeLocationName(rawLocation) {
  const location = String(rawLocation || '').trim()
  if (!location) return ''

  const canonical = location
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (canonical.includes('bonito')) {
    return 'Bonito Cafe'
  }

  if (
    canonical.includes('nanas green') ||
    canonical.includes('nana s green') ||
    canonical === 'nanas' ||
    canonical === 'nana s' ||
    canonical === 'nana'
  ) {
    return "Nana's Green"
  }

  return location.charAt(0).toUpperCase() + location.slice(1).toLowerCase()
}

app.get('/api/health', async (_req, res) => {
  res.json({ ok: true })
})

app.post('/api/users/session', async (req, res) => {
  const browserId = String(req.body?.browserId || '').trim()
  const incomingUserName = String(req.body?.userName || '').trim()

  if (!browserId) {
    return res.status(400).json({ error: 'browserId is required' })
  }

  const existing = await pool.query(
    'SELECT user_name FROM browser_users WHERE browser_id = $1',
    [browserId]
  )

  if (!incomingUserName && existing.rowCount === 0) {
    return res.status(200).json({ requiresName: true })
  }

  const userName = incomingUserName || existing.rows[0].user_name

  await pool.query(
    `
      INSERT INTO browser_users (browser_id, user_name)
      VALUES ($1, $2)
      ON CONFLICT (browser_id)
      DO UPDATE SET user_name = EXCLUDED.user_name
    `,
    [browserId, userName]
  )

  return res.json({ requiresName: false, userName })
})

app.post('/api/ratings', async (req, res) => {
  const userName = String(req.body?.userName || '').trim()
  const photo = String(req.body?.photo || '').trim()
  const rating = Number(req.body?.rating)
  const greenness = Number(req.body?.greenness)
  const location = String(req.body?.location || '').trim()
  const thoughts = String(req.body?.thoughts || '').trim()

  if (!userName || !photo || Number.isNaN(rating) || Number.isNaN(greenness)) {
    return res.status(400).json({ error: 'Missing required rating fields' })
  }

  const inserted = await pool.query(
    `
      INSERT INTO ratings (user_name, photo, rating, greenness, location, thoughts)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `,
    [userName, photo, rating, greenness, location, thoughts]
  )

  return res.status(201).json({ rating: mapRatingRow(inserted.rows[0]) })
})

app.put('/api/ratings/:id', async (req, res) => {
  const id = Number(req.params.id)
  const userName = String(req.body?.userName || '').trim()
  const rating = Number(req.body?.rating)
  const location = String(req.body?.location || '').trim()
  const thoughts = String(req.body?.thoughts || '').trim()

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Valid rating id is required' })
  }

  if (!userName || Number.isNaN(rating)) {
    return res.status(400).json({ error: 'userName and rating are required' })
  }

  const updated = await pool.query(
    `
      UPDATE ratings
      SET rating = $3,
          location = $4,
          thoughts = $5
      WHERE id = $1 AND user_name = $2
      RETURNING *
    `,
    [id, userName, rating, location, thoughts]
  )

  if (updated.rowCount === 0) {
    return res.status(404).json({ error: 'Rating not found for this user' })
  }

  return res.json({ rating: mapRatingRow(updated.rows[0]) })
})

app.delete('/api/ratings/:id', async (req, res) => {
  const id = Number(req.params.id)
  const userName = String(req.query.userName || '').trim()

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Valid rating id is required' })
  }

  if (!userName) {
    return res.status(400).json({ error: 'userName query parameter is required' })
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
  const userName = String(req.query.userName || '').trim()
  if (!userName) {
    return res.status(400).json({ error: 'userName query parameter is required' })
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
  const q = String(req.query.q || '').trim()
  if (!q) {
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
  const friendName = String(req.params.friendName || '').trim()
  if (!friendName) {
    return res.status(400).json({ error: 'friendName is required' })
  }

  const result = await pool.query(
    `
      SELECT *
      FROM ratings
      WHERE user_name = $1
      ORDER BY (rating * 20 + greenness) DESC, created_at DESC
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
    const placeName = normalizeLocationName(row.location)
    if (!placeName) continue

    const rating = Number(row.rating)
    const greenness = Number(row.greenness)
    const scoreOutOf200 = rating * 20 + greenness

    const existing = placeBuckets.get(placeName)
    if (existing) {
      existing.totalScore += scoreOutOf200
      existing.entryCount += 1
    } else {
      placeBuckets.set(placeName, {
        placeName,
        totalScore: scoreOutOf200,
        entryCount: 1
      })
    }
  }

  const places = [...placeBuckets.values()]
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
      averageScore: Number(((place.totalScore / place.entryCount) / 2).toFixed(1))
    }))

  return res.json({ places })
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
    const placeName = normalizeLocationName(row.location)
    if (!userName || !placeName) continue

    if (!userPlaces.has(userName)) {
      userPlaces.set(userName, new Set())
    }
    userPlaces.get(userName).add(placeName)
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
