// In-process TTL cache for expensive read endpoints (similar-users,
// similar-places). Recs don't need to be second-fresh — one 5-minute
// aggregation is plenty for a hackathon-scale app, and it takes a scan
// of ~5000 rating rows off the DB on every Explore mount. Safe to lose
// on process restart; NOT shared across dynos (fine — Render free
// tier is 1).

export const RECS_CACHE_TTL_MS = 5 * 60 * 1000

const recsCache = new Map()

export function recsCacheGet(key) {
  const hit = recsCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > RECS_CACHE_TTL_MS) {
    recsCache.delete(key)
    return null
  }
  return hit.value
}

export function recsCacheSet(key, value) {
  recsCache.set(key, { at: Date.now(), value })
  // Cap the cache so a scripted attack can't grow it unbounded.
  if (recsCache.size > 500) {
    const oldest = recsCache.keys().next().value
    if (oldest !== undefined) recsCache.delete(oldest)
  }
}

// Wipe cache entries touching a specific userName whenever they change
// prefs or add a rating, so recs still feel live.
export function recsCacheInvalidate(userName) {
  if (!userName) return
  const needle = String(userName).toLowerCase()
  for (const key of recsCache.keys()) {
    if (key.startsWith(`u:${needle}|`)) recsCache.delete(key)
  }
}
