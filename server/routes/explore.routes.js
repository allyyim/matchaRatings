import express from 'express'
import { pool } from '../db.js'
import { normalizeLocationText } from '../lib/sanitize.js'
import { getWeightedScore } from '../lib/scoring.js'
import { normalizeLocationName, getCanonicalPlaceData, shouldMergePlaces } from '../lib/places.js'
import { mapRatingRow } from '../lib/mappers.js'
import { recsCacheGet, recsCacheSet } from '../lib/recsCache.js'
import { recsRateLimiter } from '../lib/rateLimits.js'
import { requireSession } from '../lib/session.js'
import { DEMO_USER_NAME } from '../lib/constants.js'

const router = express.Router()

router.get('/api/explore/places', async (req, res) => {
  const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 10))

  try {
    const result = await pool.query(
      `
        SELECT location, AVG(rating::numeric) as avg_rating, AVG(greenness::numeric) as avg_greenness, COUNT(*) as entry_count
        FROM ratings
        WHERE TRIM(location) <> ''
          AND LOWER(user_name) <> 'demo'
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

router.get('/api/explore/places/:placeName/ratings', async (req, res) => {
  const rawPlaceName = String(req.params.placeName || '').trim()
  if (!rawPlaceName) {
    return res.status(400).json({ error: 'placeName is required' })
  }

  const { displayName, canonicalKey } = getCanonicalPlaceData(rawPlaceName)
  if (!displayName || !canonicalKey) {
    return res.json({ placeName: rawPlaceName, ratings: [] })
  }

  // Pre-filter on the DB side using the longest distinctive token of the
  // canonical key. This turns a full-table scan into an index probe against
  // idx_ratings_lower_location. Fall back to a broad scan if the canonical
  // key had no useful token (rare — mostly happens for single-char names).
  const distinctiveToken = String(canonicalKey)
    .split(/\s+/)
    .filter((t) => t.length >= 3)
    .sort((a, b) => b.length - a.length)[0] || ''

  const result = distinctiveToken
    ? await pool.query(
        `SELECT id, user_name, photo, rating, greenness, location, thoughts, created_at, flavor_preferences
           FROM ratings
          WHERE TRIM(location) <> ''
            AND LOWER(user_name) <> 'demo'
            AND LOWER(location) LIKE '%' || $1 || '%'
          LIMIT 3000`,
        [distinctiveToken]
      )
    : await pool.query(
        `SELECT id, user_name, photo, rating, greenness, location, thoughts, created_at, flavor_preferences
           FROM ratings
          WHERE TRIM(location) <> ''
            AND LOWER(user_name) <> 'demo'
          LIMIT 3000`
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

router.get('/api/explore/users', recsRateLimiter, async (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50))

  try {
    // Aggregate ratings per user first in a CTE, THEN join preferences once
    // per user. Previous version did MAX(p.flavors::text) so the JSONB column
    // could survive a GROUP BY — that cast round-trip was both fragile
    // (breaks on any non-array JSON) and slow. This shape lets Postgres
    // return native JSONB, which node-pg auto-parses.
    const result = await pool.query(
      `
        WITH rating_stats AS (
          SELECT
            MIN(r.user_name) AS user_name,
            LOWER(r.user_name) AS user_key,
            COUNT(*)::int AS place_count
          FROM ratings r
          WHERE TRIM(r.location) <> ''
            AND LOWER(r.user_name) <> 'demo'
          GROUP BY LOWER(r.user_name)
          ORDER BY place_count DESC, MIN(r.user_name) ASC
          LIMIT $1
        )
        SELECT DISTINCT ON (rs.user_key)
          rs.user_name,
          rs.place_count,
          a.avatar_url,
          p.flavors AS flavors
        FROM rating_stats rs
        LEFT JOIN accounts a ON LOWER(a.user_name) = rs.user_key
        LEFT JOIN user_preferences p ON p.email = a.email
        ORDER BY rs.user_key, rs.place_count DESC
      `,
      [limit * 2]
    )

    const users = result.rows
      .map((row) => {
        // flavors is now native JSONB → node-pg gives us a parsed JS value.
        const rawFlavors = Array.isArray(row.flavors) ? row.flavors : []
        const flavors = rawFlavors.filter((f) => typeof f === 'string' && !f.startsWith('__'))
        const bodyEntry = rawFlavors.find((f) => typeof f === 'string' && f.startsWith('__body:'))
        const body = bodyEntry ? String(bodyEntry).slice('__body:'.length) : ''
        return {
          userName: String(row.user_name || '').trim(),
          placeCount: Number(row.place_count),
          avatarUrl: row.avatar_url || null,
          flavors,
          body,
        }
      })
      .filter((u) => u.userName)
      .sort((a, b) => b.placeCount - a.placeCount || a.userName.localeCompare(b.userName))
      .slice(0, limit)

    return res.json({ users })
  } catch (error) {
    console.error('Explore users error:', error)
    return res.status(500).json({ error: 'Failed to load users' })
  }
})

router.get('/api/similar-users', requireSession, recsRateLimiter, async (req, res) => {
  const userName = req.session.userName

  // v3 in the cache key retires v2 entries whose `flavors` field was
  // the intersection instead of the target user's full flavor set.
  const cacheKey = `u:${userName.toLowerCase()}|similar-users|v3`
  const cached = recsCacheGet(cacheKey)
  if (cached) return res.json(cached)

  try {
    // No server-side flavor allowlist — client (isKnownFlavor in
    // src/lib/flavors.ts) owns the vocabulary. Similarity scoring works
    // on the raw intersection either way; keeping this filter-free means
    // adding a flavor to the client no longer requires a server deploy.

    // Parse a stored flavor prefs blob (array or object) into
    // { flavors:Set, body:string }. The client sends flavors as an array
    // of strings — where body is packed as "__body:<value>" — but older
    // rows may have been stored as objects, so accept both.
    const parsePrefs = (raw) => {
      const flavors = new Set()
      let body = ''
      const takeKey = (rawKey, rawVal) => {
        if (rawVal !== undefined && !rawVal) return
        const k = String(rawKey || '').toLowerCase()
        if (k.startsWith('__body:')) {
          body = k.slice('__body:'.length)
        } else if (k && !k.startsWith('__')) {
          flavors.add(k)
        }
      }
      if (Array.isArray(raw)) {
        for (const item of raw) takeKey(item, undefined)
      } else if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) takeKey(k, v)
      }
      return { flavors, body }
    }

    // Current user's prefs
    const userPrefsResult = await pool.query(
      `SELECT flavors FROM user_preferences WHERE email = (SELECT email FROM accounts WHERE LOWER(user_name) = LOWER($1))`,
      [userName]
    )

    if (userPrefsResult.rowCount === 0) {
      return res.json({ similarUsers: [] })
    }

    const me = parsePrefs(userPrefsResult.rows[0].flavors || {})

    // Nothing to match on
    if (me.flavors.size === 0 && !me.body) {
      return res.json({ similarUsers: [] })
    }

    // Candidate pool: users with either flavor prefs or a body pref set
    const result = await pool.query(
      `
        SELECT DISTINCT a.user_name, up.flavors,
          (SELECT COUNT(*) FROM ratings WHERE LOWER(user_name) = LOWER(a.user_name)) AS rating_count
        FROM accounts a
        LEFT JOIN user_preferences up ON a.email = up.email
        WHERE LOWER(a.user_name) <> LOWER($1)
          AND LOWER(a.user_name) <> 'demo'
          AND up.flavors IS NOT NULL
        ORDER BY rating_count DESC
        LIMIT 200
      `,
      [userName]
    )

    const myFlavorCount = me.flavors.size

    const similarUsers = result.rows
      .map((row) => {
        const them = parsePrefs(row.flavors || {})
        const shared = [...me.flavors].filter((f) => them.flavors.has(f))
        const sharedCount = shared.length

        // Two-sided coverage: what fraction of *my* flavors do they hit,
        // and what fraction of *theirs* do I cover. Blend 55/45 toward mine
        // so recs feel personalized to what I care about while still
        // rewarding taste-twins with tight overlap.
        const userCoverage = myFlavorCount > 0 ? sharedCount / myFlavorCount : 0
        const placeCoverage = them.flavors.size > 0 ? sharedCount / them.flavors.size : 0
        let flavorScore = 0.55 * userCoverage + 0.45 * placeCoverage

        // Penalize noisy taste profiles: if they picked lots of flavors I
        // don't like, subtract a small amount proportional to the surplus.
        if (them.flavors.size > 0) {
          const surplus = [...them.flavors].filter((f) => !me.flavors.has(f)).length
          const surplusRatio = surplus / them.flavors.size
          flavorScore -= Math.min(0.25, surplusRatio * 0.25)
        }
        flavorScore = Math.max(0, flavorScore)

        // Body match is a strong signal for matcha style; +0.18 exact match,
        // -0.10 mismatch. If either side has no body set, neutral.
        let bodyScore = 0
        if (me.body && them.body) {
          bodyScore = me.body === them.body ? 0.18 : -0.10
        }

        // Small quality/confidence bump for users with actual rating history
        const ratingCount = Number(row.rating_count) || 0
        const activityBoost = Math.min(0.08, Math.log10(1 + ratingCount) * 0.04)

        // Only apply the activity boost when there's a real taste signal —
        // otherwise brand-new accounts with 0 shared flavors would surface
        // just because they have some rating history.
        const baseScore = flavorScore + bodyScore
        const matchScore = baseScore > 0
          ? Math.max(0, Math.min(1, baseScore + activityBoost))
          : 0

        return {
          userName: row.user_name,
          // Full flavor set — the client renders the archetype chip
          // (PalateChip) from this. Sending only the intersection here
          // would make Jason's archetype flip based on the viewer's
          // palate, which caused chip labels to disagree across tabs
          // and to visibly shift whenever the viewer updated their
          // own prefs. sharedFlavors below is what the "Shared flavors"
          // section renders.
          flavors: [...them.flavors],
          sharedFlavors: shared,
          body: them.body,
          ratingCount,
          matchScore,
        }
      })
      .filter((u) => u.matchScore > 0)
      .sort((a, b) => b.matchScore - a.matchScore)

    console.log(`[similar-users] ${userName} → evaluated ${result.rowCount} candidates, returning ${similarUsers.length}`)
    const payload = { similarUsers }
    recsCacheSet(cacheKey, payload)
    return res.json(payload)
  } catch (error) {
    console.error('Similar users lookup failed:', error)
    return res.status(500).json({ error: 'Failed to find similar users' })
  }
})

// Find places with similar flavor profiles
router.get('/api/similar-places', requireSession, async (req, res) => {
  const flavorsParam = String(req.query.flavors || '').trim()
  const userBody = String(req.query.body || '').trim()
  // Caller identity from the session, not the query string.
  const userName = req.session.userName
  const userShade = Number.parseInt(String(req.query.shade || '0'), 10) || 0
  // Target greenness % per shade (1..9). Must stay in sync with SHADE_OPTIONS
  // in the client (src/App.tsx).
  const SHADE_TARGETS = [8, 20, 32, 44, 56, 68, 78, 88, 96]
  const targetGreenness = userShade >= 1 && userShade <= 9 ? SHADE_TARGETS[userShade - 1] : null
  if (!flavorsParam && !userBody) {
    return res.status(400).json({ error: 'flavors parameter is required' })
  }

  const cacheKey = `u:${userName.toLowerCase()}|similar-places|f:${flavorsParam}|b:${userBody}|s:${userShade}`
  const cached = recsCacheGet(cacheKey)
  if (cached) return res.json(cached)

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
        SELECT r.location, r.flavor_preferences, r.rating, r.greenness
        FROM ratings r
        WHERE r.location IS NOT NULL
          AND r.location != ''
          AND r.flavor_preferences IS NOT NULL
          AND LOWER(r.user_name) <> 'demo'
        LIMIT 5000
      `
    )

    // Group ratings by location, then build a frequency profile of flavors
    // Canonical flavor allowlist. Anything not in this set is treated as
    // legacy/junk data (e.g. old "bold" body value written before body moved
    // to the __body:* namespace) and is ignored for aggregation + display.
    const KNOWN_FLAVORS = new Set([
      'sweet', 'nutty', 'umami', 'vegetal', 'sugary', 'astringent',
      'creamy', 'floral', 'earthy', 'chocolatey', 'mellow', 'bitter',
      'rich', 'velvety', 'grassy', 'smooth'
    ])

    // Aggregate per-location: track how often each flavor is chosen (>=75)
    // and body-profile choices across all raters at that place.
    const byLocation = new Map()
    for (const row of result.rows) {
      const key = row.location
      let g = byLocation.get(key)
      if (!g) {
        g = { flavorCounts: {}, bodyCounts: {}, total: 0, ratingSum: 0, greennessSum: 0, greennessCount: 0 }
        byLocation.set(key, g)
      }
      g.total += 1
      g.ratingSum += Number(row.rating) || 0
      const greenNum = Number(row.greenness)
      if (Number.isFinite(greenNum)) {
        g.greennessSum += greenNum
        g.greennessCount += 1
      }
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

      // Shade preference: if the user has picked an ideal cup color, blend in
      // how close this place's average greenness is to their target. Places
      // with no greenness data get a neutral 0 bonus (neither helped nor hurt).
      const avgGreenness = g.greennessCount > 0 ? g.greennessSum / g.greennessCount : null
      if (targetGreenness !== null && avgGreenness !== null) {
        const shadeMatch = 1 - Math.min(1, Math.abs(avgGreenness - targetGreenness) / 60)
        // Blend at 20% weight — dominant signal is still flavor+body.
        matchScore = matchScore * 0.8 + shadeMatch * 0.2
      }

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
        ratingCount: g.total,
        avgGreenness: avgGreenness !== null ? Math.round(avgGreenness * 10) / 10 : null
      })
    }

    similarPlaces.sort((a, b) => b.matchScore - a.matchScore || b.ratingCount - a.ratingCount)

    const payload = { similarPlaces: similarPlaces.slice(0, 20) }
    recsCacheSet(cacheKey, payload)
    return res.json(payload)
  } catch (error) {
    console.error('Similar places lookup failed:', error)
    return res.status(500).json({ error: 'Failed to find similar places' })
  }
})

router.get('/api/users/similar-preferences', requireSession, recsRateLimiter, async (req, res) => {
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
          AND LOWER(a.user_name) <> 'demo'
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


export default router
