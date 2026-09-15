// Admin + one-off migration endpoints. These sit BEFORE the general
// /api auth gate in index.js so an operator (not a signed-in user) can
// call them from a shell without a session token — but they are NOT
// unauthenticated: every /admin/* route is gated by
// `requireAdminSecret`, which demands `Authorization: Bearer
// $ADMIN_SECRET`. If ADMIN_SECRET is not set in env, the whole family
// 503s instead of silently allowing anyone through.
//
// If you add anything user-facing here, move it out — this file is
// intentionally not behind session auth.

import express from 'express'
import crypto from 'node:crypto'
import { v2 as cloudinary } from 'cloudinary'
import { pool } from '../db.js'
import { validateImageDataUrl } from '../lib/imageValidation.js'
import { requireAdminSecret } from '../lib/session.js'
import { adminRateLimiter } from '../lib/rateLimits.js'

const router = express.Router()

// Gate every /admin/* route below with the shared secret + tighter rate
// limit. The legacy /migrate/ali is a hard 410 either way, so it stays
// public (a permanently-disabled endpoint is safe to hit).
router.use('/admin', adminRateLimiter, requireAdminSecret)

// Legacy migration that used to reassign every 'Ali' rating to the
// caller — caused every new signup to steal Ali's ratings. Kept as a
// hard 410 so stale clients fail loudly instead of doing damage.
router.post('/migrate/ali', async (_req, res) => {
  return res.status(410).json({ error: 'This migration endpoint is permanently disabled.' })
})

router.post('/admin/link-users', async (req, res) => {
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

router.post('/admin/delete-user', async (req, res) => {
  try {
    const { userName } = req.body

    if (!userName) {
      return res.status(400).json({ error: 'userName is required' })
    }

    const userResult = await pool.query(
      'SELECT email, user_name FROM accounts WHERE LOWER(user_name) = LOWER($1)',
      [userName]
    )
    if (userResult.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' })
    }

    const email = userResult.rows[0].email
    const actualUserName = userResult.rows[0].user_name

    await pool.query('DELETE FROM ratings WHERE LOWER(user_name) = LOWER($1)', [actualUserName])
    await pool.query('DELETE FROM follows WHERE follower_email = $1 OR following_email = $1', [email])
    await pool.query('DELETE FROM rating_likes WHERE email = $1', [email])
    await pool.query('DELETE FROM user_preferences WHERE email = $1', [email])
    await pool.query('DELETE FROM browser_users WHERE LOWER(user_name) = LOWER($1)', [actualUserName])
    await pool.query('DELETE FROM login_tokens WHERE email = $1', [email])
    await pool.query('DELETE FROM accounts WHERE email = $1', [email])

    return res.json({ ok: true, message: `User ${userName} deleted successfully` })
  } catch (error) {
    console.error('Delete user failed:', error)
    return res.status(400).json({ error: 'Failed to delete user' })
  }
})

router.post('/admin/fix-ali', async (_req, res) => {
  try {
    const accountResult = await pool.query(
      `UPDATE accounts SET email = $1 WHERE LOWER(user_name) = LOWER($2) RETURNING user_name, email`,
      ['alisonyim3@gmail.com', 'Ali']
    )

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

// One-shot bulk migration: pull every data:image/... blob out of the
// ratings table and re-upload it to Cloudinary, swapping the DB value
// with the secure_url. Idempotent (skips existing Cloudinary URLs).
router.post('/admin/migrate-photos-to-cloudinary', async (_req, res) => {
  try {
    console.log('Starting photo migration to Cloudinary...')

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

        if (rating.photo.includes('cloudinary.com') || rating.photo.includes('res.cloudinary.com')) {
          console.log(`Skipping - already Cloudinary URL`)
          skippedCount++
          continue
        }

        if (!rating.photo.startsWith('data:image/')) {
          console.log(`Skipping - invalid photo format`)
          skippedCount++
          continue
        }

        // Validate the stored data URL against the same rules as fresh
        // uploads. Historical rows might have questionable payloads that
        // pre-date the byte-level check.
        const validation = validateImageDataUrl(rating.photo)
        if (!validation.ok) {
          console.log(`Skipping rating ${rating.id} - failed validation: ${validation.error}`)
          skippedCount++
          continue
        }
        const { buffer, mime } = validation
        const dataUri = `data:${mime};base64,${buffer.toString('base64')}`

        console.log(`Uploading photo (${Math.round(dataUri.length / 1024)}KB)...`)

        let result
        let retries = 0
        const maxRetries = 3

        while (retries < maxRetries) {
          try {
            const publicId = `migrated-${rating.id}-${crypto.randomBytes(8).toString('hex')}`
            result = await Promise.race([
              cloudinary.uploader.upload(dataUri, {
                folder: 'matcha-ratings-migration',
                resource_type: 'image',
                public_id: publicId,
                use_filename: false,
                unique_filename: false,
                overwrite: false,
                quality: 'auto',
                fetch_format: 'auto',
                timeout: 60000
              }),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Upload timeout after 60s')), 65000)
              )
            ])
            break
          } catch (uploadError) {
            retries++
            console.error(`Upload attempt ${retries}/${maxRetries} failed:`, uploadError.message)
            if (retries < maxRetries) {
              await new Promise(resolve => setTimeout(resolve, 1000 * retries))
            } else {
              throw uploadError
            }
          }
        }

        await pool.query(
          'UPDATE ratings SET photo = $1 WHERE id = $2',
          [result.secure_url, rating.id]
        )

        uploadedCount++
        console.log(`✓ Migrated rating ${rating.id}`)

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

export default router
