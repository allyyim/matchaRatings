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

// Which cluster each flavor lives in. Kept in sync with the color-family
// groupings in flavors.ts (dessert=brown, sweet=pink, earthy=green,
// bracing=yellow, silky=blue).
const CLUSTER_MAP: Record<string, ClusterKey> = {
  chocolatey: 'dessert', nutty: 'dessert', velvety: 'dessert', rich: 'dessert',
  sweet: 'sweet', sugary: 'sweet', creamy: 'sweet', floral: 'sweet',
  earthy: 'earthy', vegetal: 'earthy', grassy: 'earthy',
  astringent: 'bracing', bitter: 'bracing',
  mellow: 'silky', smooth: 'silky', umami: 'silky',
}

// Single-cluster archetypes. Fires when one cluster clearly dominates.
const PRIMARY_ARCHETYPE: Record<ClusterKey, string> = {
  dessert: 'The Dessert Sipper',
  sweet:   'The Creamy Dreamer',
  earthy:  'The Purist',
  bracing: 'The Grown-Up',
  silky:   'The Smooth Operator',
}

// Two-cluster combo archetypes. Fires when the top-two clusters are
// competitive (secondary ≥ ~66% of primary count). Order-insensitive —
// the key is a sorted "a+b" so we look up (dessert, sweet) and (sweet,
// dessert) as the same combo. Each name is meant to feel like a
// personality quiz result, not a category label.
const COMBO_ARCHETYPE: Record<string, string> = {
  'dessert+sweet':   'The Confectioner',
  'dessert+earthy':  'The Nostalgic',
  'bracing+dessert': 'The Bittersweet',
  'dessert+silky':   'The Nightcap',
  'earthy+sweet':    'The Garden Party',
  'bracing+sweet':   'The Contrarian',
  'silky+sweet':     'The Cloud Sipper',
  'bracing+earthy':  'The Traditionalist',
  'earthy+silky':    'The Zen Master',
  'bracing+silky':   'The Even Keel',
}

// Three-plus-cluster balanced palates get their own label so we don't
// force a false "top" cluster. Fires when 3+ clusters all sit within
// ~66% of the leader.
const BALANCED_ARCHETYPE = 'The Wildcard'

// Punchy sub-tagline for when there's a *modest* secondary cluster
// (not competitive enough for a combo, but present). Reads "Primary
// Archetype with a X streak".
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

// Build a normalized `a+b` key with clusters in a fixed alphabetical
// order so lookups are order-insensitive.
function comboKey(a: ClusterKey, b: ClusterKey): string {
  return [a, b].sort().join('+')
}

// Returns the ranked list of clusters + counts for a flavors[] input,
// after lowercasing + filtering to known vocabulary. Shared by the chip
// and summary paths so they compute identical archetypes for the same
// input — that was the root cause of "the chip changes when you click
// into someone's profile" (upstream case-mismatch dropped flavors).
function rankClusters(flavors: string[]): Array<[ClusterKey, number]> {
  const known = (flavors || []).map((f) => String(f).toLowerCase()).filter((f) => f in CLUSTER_MAP)
  const counts = new Map<ClusterKey, number>()
  for (const f of known) {
    const c = CLUSTER_MAP[f]
    counts.set(c, (counts.get(c) || 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

// Chooses the archetype label for a ranked cluster list. Encapsulates
// the tie-breaking rules used everywhere (compact chip + full summary).
function archetypeFromRanked(ranked: Array<[ClusterKey, number]>): string {
  if (ranked.length === 0) return ''
  const [top, second, third] = ranked
  const topN = top[1]
  const secondN = second?.[1] ?? 0
  const thirdN = third?.[1] ?? 0
  const CLOSE = (n: number) => n >= Math.max(1, Math.ceil(topN * 0.66))
  // Balanced 3-way — nobody dominates, everyone shows up.
  if (third && CLOSE(secondN) && CLOSE(thirdN)) return BALANCED_ARCHETYPE
  // Competitive 2-way — combo name.
  if (second && CLOSE(secondN)) {
    const combo = COMBO_ARCHETYPE[comboKey(top[0], second[0])]
    if (combo) return combo
  }
  // Everything else — solo primary.
  return PRIMARY_ARCHETYPE[top[0]]
}

// Compact archetype label only — no body/shade tail. Meant for chips
// shown next to other users' names across the app (Explore leaderboard,
// "People like you" cards, friend modal). Returns '' when the user has
// no flavor picks so callers can hide the chip.
export function palateArchetype(flavors: string[]): string {
  return archetypeFromRanked(rankClusters(flavors))
}

// The color cluster driving a user's archetype. Callers can use this to
// tint the chip so 'The Dessert Sipper' picks up the brown palette,
// 'The Purist' picks up green, etc. — visually reinforcing the vocabulary.
// For combo archetypes we return the *primary* cluster so the chip still
// paints in a single color family (readable at chip size).
export function palateArchetypeCluster(flavors: string[]): ClusterKey | null {
  const ranked = rankClusters(flavors)
  return ranked[0]?.[0] ?? null
}

// Chip palette per cluster — matches the flavor-color families in flavors.ts
// (dessert = brown, sweet = pink, earthy = green, bracing = yellow-olive,
// silky = blue) so the archetype visually maps to the same taste family
// the user sees in their flavor grid.
export function palateArchetypePalette(cluster: ClusterKey): { bg: string; fg: string; border: string } {
  switch (cluster) {
    case 'dessert': return { bg: '#f2e3e0', fg: '#5c3839', border: '#d6bab7' }
    case 'sweet':   return { bg: '#f8e3f0', fg: '#5a2a4b', border: '#e0bad7' }
    case 'earthy':  return { bg: '#e2eedb', fg: '#2f5b3a', border: '#b7d6a8' }
    case 'bracing': return { bg: '#f8fadc', fg: '#5c5d1c', border: '#dcdd94' }
    case 'silky':   return { bg: '#e0f0fa', fg: '#1e4a5f', border: '#a9def9' }
  }
}

export function summarizePalate({ flavors, body, shade }: PalateInput): string {
  const ranked = rankClusters(flavors)

  // Empty state — return '' so the caller hides the line entirely rather
  // than showing a placeholder.
  if (ranked.length === 0 && !body && !shade) return ''

  let head = ''
  if (ranked.length >= 1) {
    const archetype = archetypeFromRanked(ranked)
    // If the archetype is a solo primary and a *modest* (not competitive
    // enough for a combo) secondary exists, append a "· <streak>" tail
    // for extra personality. Combo + balanced labels already carry two
    // clusters, so we skip the streak there.
    const [top, second] = ranked
    const isSoloPrimary = archetype === PRIMARY_ARCHETYPE[top[0]]
    const hasModestStreak = isSoloPrimary && second && second[1] >= Math.max(1, Math.ceil(top[1] / 2))
    head = hasModestStreak
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

