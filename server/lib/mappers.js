// Shared row shape for /api/ratings*, /api/friends/*/ratings,
// /api/feed/following, /api/explore/places/*/ratings. Kept as one place
// so the client can trust that every rating object has the same fields.

import { getWeightedScore } from './scoring.js'

export function mapRatingRow(row) {
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
    comboScore: Number(getWeightedScore(rating, greenness).toFixed(2)),
    flavorPreferences: row.flavor_preferences || {}
  }
}
