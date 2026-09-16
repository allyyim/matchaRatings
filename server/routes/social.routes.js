import express from 'express'
import { pool } from '../db.js'
import { sanitizeText } from '../lib/sanitize.js'
import { getWeightedScore } from '../lib/scoring.js'
import { mapRatingRow } from '../lib/mappers.js'
import { requireSession } from '../lib/session.js'
import { DEMO_USER_NAME } from '../lib/constants.js'

const router = express.Router()

router.get('/api/friends/search', async (req, res) => {
  const q = sanitizeText(String(req.query.q || '').trim(), 40)

  if (!q || q.length < 1) {
    return res.json({ friends: [] })
  }

  try {
    const result = await pool.query(
      `
        SELECT
          a.user_name,
          COUNT(r.id) as place_count
        FROM accounts a
        LEFT JOIN ratings r ON LOWER(r.user_name) = LOWER(a.user_name) AND r.location IS NOT NULL AND r.location != ''
        WHERE LOWER(a.user_name) LIKE LOWER($1)
          AND LOWER(a.user_name) <> 'demo'
        GROUP BY a.user_name
        ORDER BY place_count DESC, a.user_name ASC
        LIMIT 20
      `,
      [`%${q}%`]
    )

    return res.json({ friends: result.rows.map((r) => ({ userName: r.user_name, placeCount: Number(r.place_count) })) })
  } catch (error) {
    console.error('Search failed:', error)
    return res.status(500).json({ error: 'Search failed', friends: [] })
  }
})

router.get('/api/friends/:friendName/ratings', async (req, res) => {
  // Don't run through sanitizeUserName here — it strips characters that
  // *were* allowed at registration time on older seeds and would silently
  // return zero rows for those legitimate accounts ("I see they rated a
  // place but the modal is empty"). The DB comparison is case-insensitive
  // and the query is parameterized, so a length-clamped raw value is safe.
  const raw = String(req.params.friendName || '').trim().slice(0, 80)
  const friendName = raw
  if (!friendName) {
    return res.status(400).json({ error: 'friendName is required' })
  }

  // Never expose the demo/recruiter account's seeded ratings to other users.
  const requesterName = String(req.session?.userName || '').toLowerCase()
  if (friendName.toLowerCase() === DEMO_USER_NAME && requesterName !== DEMO_USER_NAME) {
    return res.status(404).json({ error: 'User not found' })
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

  // Never allow a proxy or the service worker to cache another user's
  // ratings — a stale response from before a rename/new rating causes
  // the "empty modal" bug even when the leaderboard shows a nonzero
  // place count.
  res.setHeader('Cache-Control', 'no-store')
  return res.json({
    friendName,
    ratings: result.rows.map(mapRatingRow)
  })
})

router.post('/api/follows/:targetUserName', async (req, res) => {
  // Prevent normal users from following/social-linking the demo account.
  if (String(req.params.targetUserName || '').toLowerCase() === DEMO_USER_NAME) {
    return res.status(404).json({ error: 'Target user not found' })
  }
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

router.delete('/api/follows/:targetUserName', async (req, res) => {
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

router.get('/api/follows/check/:targetUserName', async (req, res) => {
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

router.get('/api/follows/list', async (req, res) => {
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

// Returns recent ratings from every user the current session follows,
// newest first. Powers the Feed tab's "friend activity" row.
router.get('/api/feed/following', async (req, res) => {
  const email = (await pool.query('SELECT email FROM accounts WHERE LOWER(user_name) = LOWER($1)', [req.session?.userName])).rows[0]?.email
  if (!email) return res.status(404).json({ error: 'Your account not found' })

  const limit = Math.min(Math.max(parseInt(String(req.query.limit || '30'), 10) || 30, 1), 100)
  try {
    const result = await pool.query(
      `SELECT r.id, r.user_name, r.photo, r.rating, r.greenness, r.location, r.thoughts,
              r.created_at, r.flavor_preferences, followed_acct.avatar_url,
              COALESCE(lc.count, 0)::int AS like_count,
              CASE WHEN mine.email IS NOT NULL THEN true ELSE false END AS liked_by_me
         FROM ratings r
         JOIN accounts followed_acct ON LOWER(followed_acct.user_name) = LOWER(r.user_name)
         JOIN follows f ON f.following_email = followed_acct.email
         LEFT JOIN (SELECT rating_id, COUNT(*) AS count FROM rating_likes GROUP BY rating_id) lc
                ON lc.rating_id = r.id
         LEFT JOIN rating_likes mine ON mine.rating_id = r.id AND mine.email = $1
        WHERE f.follower_email = $1
          AND LOWER(followed_acct.user_name) <> $2
        ORDER BY r.created_at DESC
        LIMIT $3`,
      [email, DEMO_USER_NAME, limit]
    )
    res.setHeader('Cache-Control', 'no-store')
    return res.json({
      ratings: result.rows.map(r => {
        const rating = Number(r.rating)
        const greenness = Number(r.greenness)
        return {
          id: r.id,
          userName: r.user_name,
          photo: r.photo,
          rating,
          greenness,
          location: r.location,
          thoughts: r.thoughts,
          date: r.created_at,
          createdAt: r.created_at,
          comboScore: Number(getWeightedScore(rating, greenness).toFixed(2)),
          flavorPreferences: r.flavor_preferences || {},
          userAvatarUrl: r.avatar_url || null,
          likeCount: Number(r.like_count) || 0,
          likedByMe: !!r.liked_by_me
        }
      })
    })
  } catch (error) {
    console.error('feed/following error', error)
    return res.status(500).json({ error: 'Failed to load feed' })
  }
})


export default router
