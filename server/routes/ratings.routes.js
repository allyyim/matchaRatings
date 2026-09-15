import express from 'express'
import crypto from 'node:crypto'
import { v2 as cloudinary } from 'cloudinary'
import { pool } from '../db.js'
import { sanitizeText, normalizeLocationText } from '../lib/sanitize.js'
import { getWeightedScore } from '../lib/scoring.js'
import { getCanonicalPlaceData, shouldMergePlaces } from '../lib/places.js'
import { mapRatingRow } from '../lib/mappers.js'
import { recsCacheInvalidate } from '../lib/recsCache.js'
import { requireSession } from '../lib/session.js'
import { validateImageDataUrl } from '../lib/imageValidation.js'
import { uploadRateLimiter } from '../lib/rateLimits.js'

const router = express.Router()

router.post('/api/ratings', requireSession, async (req, res) => {
  // Identity is taken from the session, not the request body. The client
  // can send whatever userName it wants; we ignore it. This makes it
  // structurally impossible to log a rating under another user's name
  // even if the ownership-check line were ever accidentally removed.
  const userName = req.session.userName
  const photo = String(req.body?.photo || '').trim()
  const rating = Number(req.body?.rating)
  const greenness = Number(req.body?.greenness)
  const location = normalizeLocationText(req.body?.location || '')
  const thoughts = sanitizeText(req.body?.thoughts || '', 800)
  const flavorPreferences = typeof req.body?.flavorPreferences === 'object' ? req.body.flavorPreferences : {}

  if (Number.isNaN(rating) || Number.isNaN(greenness)) {
    return res.status(400).json({ error: 'Missing required rating fields' })
  }

  if (rating < 0 || rating > 5 || greenness < 0 || greenness > 100) {
    return res.status(400).json({ error: 'rating and greenness must be in valid ranges' })
  }

  if (photo.length > 500) {
    return res.status(413).json({ error: 'Photo URL is too long' })
  }

  const inserted = await pool.query(
    `
      INSERT INTO ratings (user_name, photo, rating, greenness, location, thoughts, flavor_preferences)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `,
    [userName, photo, rating, greenness, location, thoughts, JSON.stringify(flavorPreferences)]
  )

  recsCacheInvalidate(userName)
  return res.status(201).json({ rating: mapRatingRow(inserted.rows[0]) })
})

// User photo upload. Accepts a data:image/<png|jpeg|gif|webp>;base64,<payload>
// blob (client pre-resizes on device) and forwards it to Cloudinary.
//
// Every trust signal from the client is validated:
//  - MIME whitelist (data URL prefix)
//  - Payload size ≤ 8 MB decoded
//  - Magic-byte signature matches the declared MIME
//  - Cloudinary `resource_type: 'image'` so the storage layer also rejects
//    anything that somehow bypassed the byte check
//  - Filename is server-generated (random 16-byte hex); we never use the
//    client's filename, so directory traversal is structurally impossible
router.post('/api/upload-image', uploadRateLimiter, requireSession, async (req, res) => {
  const validation = validateImageDataUrl(req.body?.image)
  if (!validation.ok) {
    return res.status(validation.status).json({ error: validation.error })
  }
  const { buffer, mime } = validation

  try {
    // Server-side public_id so the client can never influence the storage
    // path. Cloudinary appends the correct extension based on `format` /
    // detected content.
    const publicId = `${req.session.userName.toLowerCase()}-${crypto.randomBytes(16).toString('hex')}`

    // Upload the raw buffer (not the data URL) so Cloudinary can't be
    // tricked into treating a spoofed data-URL prefix as authoritative.
    const dataUri = `data:${mime};base64,${buffer.toString('base64')}`

    const result = await cloudinary.uploader.upload(dataUri, {
      folder: 'matcha-ratings',
      resource_type: 'image',
      public_id: publicId,
      use_filename: false,
      unique_filename: false,
      overwrite: false,
      quality: 'auto',
      fetch_format: 'auto',
      timeout: 60000,
    })

    return res.json({ url: result.secure_url })
  } catch (error) {
    console.error('Image upload failed:', error.message)
    return res.status(500).json({ error: 'Image upload failed' })
  }
})

router.put('/api/ratings/:id', requireSession, async (req, res) => {
  const id = Number(req.params.id)
  // Identity from session, never from the request body.
  const userName = req.session.userName
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

  if (Number.isNaN(rating)) {
    return res.status(400).json({ error: 'rating is required' })
  }

  if (greenness !== null && Number.isNaN(greenness)) {
    return res.status(400).json({ error: 'greenness must be a valid number when provided' })
  }

  if (rating < 0 || rating > 5 || (greenness !== null && (greenness < 0 || greenness > 100))) {
    return res.status(400).json({ error: 'rating and greenness must be in valid ranges' })
  }

  // Same guard as POST /api/ratings: photos must be short URLs (Cloudinary),
  // never base64 data-URLs. Historical rows may still have blobs, but no NEW
  // write is allowed to reintroduce them — that's how storage stays flat.
  if (photo !== null && typeof photo === 'string' && photo.length > 500) {
    return res.status(413).json({ error: 'Photo URL is too long' })
  }

  // WHERE user_name = $2 uses the session name, so a stolen id from another
  // user still resolves to 0 rows → 404, never an accidental edit.
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

  recsCacheInvalidate(userName)
  return res.json({ rating: mapRatingRow(updated.rows[0]) })
})

router.delete('/api/ratings/:id', requireSession, async (req, res) => {
  const id = Number(req.params.id)
  const userName = req.session.userName

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Valid rating id is required' })
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

// Dedupe near-identical ratings for the caller. Two rows are considered the
// same log if they share (user_name, location, rating, greenness) AND their
// created_at values fall within 10 seconds of each other — the common
// double-submit case where a network retry inserted a second copy of the same
// tap. We keep the earliest id in each cluster and delete the rest.
router.post('/api/ratings/dedupe', requireSession, async (req, res) => {
  const userName = req.session.userName

  try {
    const result = await pool.query(
      `
        WITH clusters AS (
          SELECT
            id,
            MIN(id) OVER (
              PARTITION BY LOWER(user_name), LOWER(COALESCE(location, '')), rating, greenness,
                           (EXTRACT(EPOCH FROM created_at)::bigint / 10)
            ) AS keeper_id
          FROM ratings
          WHERE LOWER(user_name) = LOWER($1)
        )
        DELETE FROM ratings
        WHERE id IN (SELECT id FROM clusters WHERE id <> keeper_id)
        RETURNING id
      `,
      [userName]
    )

    const remaining = await pool.query(
      'SELECT COUNT(*)::int AS c FROM ratings WHERE LOWER(user_name) = LOWER($1)',
      [userName]
    )

    return res.json({
      removed: result.rowCount,
      removedIds: result.rows.map((r) => Number(r.id)),
      remaining: Number(remaining.rows[0]?.c || 0)
    })
  } catch (error) {
    console.error('Dedupe failed:', error)
    return res.status(500).json({ error: 'Dedupe failed' })
  }
})

router.get('/api/ratings', async (req, res) => {
  const userName = req.session.userName

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

router.post('/api/ratings/:ratingId/like', requireSession, async (req, res) => {
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

router.delete('/api/ratings/:ratingId/like', requireSession, async (req, res) => {
  const ratingId = Number(req.params.ratingId)
  const email = (await pool.query('SELECT email FROM accounts WHERE LOWER(user_name) = LOWER($1)', [req.session.userName])).rows[0]?.email
  if (!email) return res.status(404).json({ error: 'Your account not found' })

  await pool.query(
    `DELETE FROM rating_likes WHERE rating_id = $1 AND email = $2`,
    [ratingId, email]
  )
  return res.json({ ok: true })
})

router.get('/api/ratings/:ratingId/likes', async (req, res) => {
  const ratingId = Number(req.params.ratingId)
  const result = await pool.query(
    `SELECT COUNT(*) as count FROM rating_likes WHERE rating_id = $1`,
    [ratingId]
  )
  return res.json({ likeCount: Number(result.rows[0].count) })
})


export default router
