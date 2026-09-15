// Sip Score math. Extracted so it can be reused (or unit-tested) without
// touching the express app or the db pool.
//
// Formula: rating * 20 + greennessWeight * greenness
// - full weight (1.0) when the star rating is 4+ (user liked it, trust
//   the greenness signal fully)
// - reduced weight (0.8) when the star rating is under 4 (the visual
//   should count for less if the taste was bad)

export const LOW_RATING_GREENNESS_WEIGHT = 0.8
export const FULL_GREENNESS_WEIGHT = 1

export function getWeightedScore(rating, greenness) {
  const greennessWeight = rating >= 4 ? FULL_GREENNESS_WEIGHT : LOW_RATING_GREENNESS_WEIGHT
  return rating * 20 + greenness * greennessWeight
}
