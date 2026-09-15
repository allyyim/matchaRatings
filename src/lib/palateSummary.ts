// One-line palate identity generated from the user's flavor preferences.
// This is the "signal" moat vs Yelp / Beli: they show ratings, we show
// *who your palate actually is* in plain English, with attitude. Each
// archetype is a short character name plus a punchy tagline so the line
// reads like a personality quiz result, not a data summary.
//
// Rule-based (no LLM) so it's instant, offline-safe, and demo-reliable.

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

// Archetype names — the personality-quiz style label. Kept short so they
// fit alongside the avatar in the profile drawer header.
const PRIMARY_ARCHETYPE: Record<ClusterKey, string> = {
  dessert: 'The Dessert Sipper',
  sweet:   'The Creamy Dreamer',
  earthy:  'The Purist',
  bracing: 'The Grown-Up',
  silky:   'The Smooth Operator',
}

// Punchy sub-tagline for when there's a clear secondary cluster.
// Reads "Primary Archetype with a X streak" — small extra flavor.
const SECONDARY_STREAK: Record<ClusterKey, string> = {
  dessert: 'chocolatey',
  sweet:   'sweet-tooth',
  earthy:  'grassy',
  bracing: 'sharp',
  silky:   'mellow',
}

// Punchy body-line addenda. Each is a self-contained clause we can pin
// to the end of any sentence.
const BODY_TAIL: Record<BodyProfileValue, string> = {
  'full-bodied': 'Bold and matcha-forward.',
  'medium':      'Balanced — never over the top.',
  'milky':       'Softer, milkier finishes only.',
}

export function summarizePalate({ flavors, body, shade }: PalateInput): string {
  const knownFlavors = (flavors || []).map((f) => String(f).toLowerCase()).filter((f) => f in CLUSTER_MAP)

  // Empty state — return '' so the caller hides the line entirely rather
  // than showing a placeholder.
  if (knownFlavors.length === 0 && !body && !shade) return ''

  // Count picks per cluster, rank.
  const counts = new Map<ClusterKey, number>()
  for (const f of knownFlavors) {
    const c = CLUSTER_MAP[f]
    counts.set(c, (counts.get(c) || 0) + 1)
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1])

  let head = ''
  if (ranked.length >= 1) {
    const [top, second] = ranked
    const archetype = PRIMARY_ARCHETYPE[top[0]]
    const hasStreak = second && second[1] >= Math.max(1, Math.ceil(top[1] / 2))
    head = hasStreak
      ? `${archetype} · ${SECONDARY_STREAK[second[0]]} streak`
      : archetype
  }

  // Body / shade addenda. Prefer a body clause; only add shade note if
  // there's no body clause AND the shade is at an extreme.
  const tail: string[] = []
  if (body) {
    tail.push(BODY_TAIL[body])
  } else if (typeof shade === 'number') {
    if (shade <= 3) tail.push('Drawn to pale-jade shades.')
    else if (shade >= 7) tail.push('Drawn to deep, vivid greens.')
  }

  if (!head && tail.length === 0) return ''
  if (!head) return tail.join(' ')
  if (tail.length === 0) return head
  return `${head}. ${tail.join(' ')}`
}

