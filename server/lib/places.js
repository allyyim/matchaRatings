// Place-name normalization + fuzzy merge logic. Same input string ->
// same canonical form so "Boba Guys - Market", "boba guys market" and
// "Boba Guys" all aggregate to the same Explore row.
//
// Extracted from server/index.js so the same rules can be reused by
// admin/data-cleanup scripts without spinning up the whole app.

import { findBestMatch } from 'string-similarity'

export function normalizeLocationName(rawLocation) {
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

export function getCanonicalPlaceData(rawLocation) {
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

export function shouldMergePlaces(canonicalA, canonicalB) {
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
