// One-line palate description generated from the user's flavor preferences.
// This is the "signal" moat vs Yelp / Beli: they show ratings, we show
// *what your palate actually is* in plain English. Rule-based (no LLM) so
// it's instant, offline-safe, and demo-reliable.
//
// Clusters mirror the color groups in flavors.ts so the summary rhymes
// with what the user sees in their chip grid.

import type { BodyProfileValue } from './flavors'

type PalateInput = {
  flavors: string[]
  body: '' | BodyProfileValue
  shade?: number
}

type ClusterKey = 'dessert' | 'sweet' | 'earthy' | 'bracing' | 'silky'

const CLUSTER_MAP: Record<string, ClusterKey> = {
  chocolatey: 'dessert', nutty: 'dessert', velvety: 'dessert', rich: 'dessert',
  sweet: 'sweet', sugary: 'sweet', creamy: 'sweet',
  umami: 'earthy', earthy: 'earthy', vegetal: 'earthy', floral: 'earthy',
  astringent: 'bracing', bitter: 'bracing',
  mellow: 'silky', smooth: 'silky',
}

// Adjective + noun phrases each cluster contributes. Two variants so the
// primary and secondary slots read naturally rather than repeating the
// same word twice ("dessert-leaning with a hint of dessert-leaning").
const CLUSTER_LEAD: Record<ClusterKey, string> = {
  dessert: 'dessert-leaning',
  sweet:   'sweet-toothed',
  earthy:  'savory and earthy',
  bracing: 'bracing and bright',
  silky:   'silky and mellow',
}

const CLUSTER_SECONDARY: Record<ClusterKey, string> = {
  dessert: 'chocolate-nutty warmth',
  sweet:   'creamy sweetness',
  earthy:  'grassy umami',
  bracing: 'brisk astringency',
  silky:   'soft mellowness',
}

const BODY_PHRASE: Record<BodyProfileValue, string> = {
  'full-bodied': 'a bold, matcha-forward mouthfeel',
  'medium':      'a balanced medium body',
  'milky':       'a lighter, milky finish',
}

export function summarizePalate({ flavors, body, shade }: PalateInput): string {
  const knownFlavors = (flavors || []).map((f) => String(f).toLowerCase()).filter((f) => f in CLUSTER_MAP)

  // Empty-state — user hasn't set any preferences yet. Return '' so the
  // caller can hide the line entirely rather than showing a placeholder.
  if (knownFlavors.length === 0 && !body && !shade) return ''

  // Count how many picks landed in each cluster, then rank.
  const counts = new Map<ClusterKey, number>()
  for (const f of knownFlavors) {
    const c = CLUSTER_MAP[f]
    counts.set(c, (counts.get(c) || 0) + 1)
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1])

  // Compose the flavor half.
  let flavorPhrase = ''
  if (ranked.length === 1) {
    flavorPhrase = `You lean ${CLUSTER_LEAD[ranked[0][0]]}`
  } else if (ranked.length >= 2) {
    const [top, second] = ranked
    // Only mention the secondary if it's non-trivial vs the top (at least
    // half as strong). Otherwise the "hint of" reads misleadingly loud.
    if (second[1] >= Math.max(1, Math.ceil(top[1] / 2))) {
      flavorPhrase = `You lean ${CLUSTER_LEAD[top[0]]} with a hint of ${CLUSTER_SECONDARY[second[0]]}`
    } else {
      flavorPhrase = `You lean ${CLUSTER_LEAD[top[0]]}`
    }
  }

  // Compose the body / shade half.
  const tail: string[] = []
  if (body) tail.push(BODY_PHRASE[body])
  if (typeof shade === 'number' && shade >= 1 && shade <= 9) {
    if (shade <= 3) tail.push('pale-jade shades')
    else if (shade >= 7) tail.push('deep, vivid greens')
  }

  if (!flavorPhrase && tail.length === 0) return ''
  if (!flavorPhrase) {
    // Only body/shade set — write a body-first sentence.
    return `You favor ${tail.join(' and ')}.`
  }
  if (tail.length === 0) return `${flavorPhrase}.`
  return `${flavorPhrase}, with ${tail.join(' and ')}.`
}
