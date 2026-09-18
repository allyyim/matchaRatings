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
  earthy: 'earthy', vegetal: 'earthy', grassy: 'earthy', umami: 'earthy',
  astringent: 'bracing', bitter: 'bracing',
  mellow: 'silky', bold: 'silky',
  // Legacy alias: existing rows may still have `smooth` — keep it in the
  // silky cluster so old chip data doesn't silently disappear.
  smooth: 'silky',
}

// Single-cluster archetypes. Fires when one cluster clearly dominates.
const PRIMARY_ARCHETYPE: Record<ClusterKey, string> = {
  dessert: 'The Dessert Sipper',
  sweet:   'The Creamy Dreamer',
  earthy:  'The Purist',
  bracing: 'The Bitter End',
  silky:   'The Smooth Operator',
}

// Two-cluster combo archetypes. Fires when the top-two clusters are
// competitive (secondary ≥ ~66% of primary count). Order-insensitive —
// the key is a sorted "a+b" so we look up (dessert, sweet) and (sweet,
// dessert) as the same combo. Each name is meant to feel like a
// personality quiz result, not a category label.
// All combo names lean into tea/matcha vocabulary — traditional pairings,
// tea varietals, and prep rituals — to match the solo archetype voice
// (Dessert Sipper, Creamy Dreamer, Purist, etc).
const COMBO_ARCHETYPE: Record<string, string> = {
  'dessert+sweet':   'The Wagashi Pair',   // matcha's classic sweet companion
  'dessert+earthy':  'The Hojicha Head',   // roasted green — sweet + earthy
  'bracing+dessert': 'The Koicha Kid',     // thick ceremonial matcha — rich + bracing
  'dessert+silky':   'The Latte Artist',   // sweet + silky = latte territory
  'earthy+sweet':    'The Bloom Chaser',   // sweet + earthy — florals in a green field
  'bracing+sweet':   'The Yuzu Sipper',    // bright citrus + green sharpness
  'silky+sweet':     'The Foam Chaser',    // frothy sweet foam vibes
  'bracing+earthy':  'The Stone Milled',   // traditional ishiusu-ground matcha
  'earthy+silky':    'The Ceremonial',     // classic matcha meditation vibe, no cliches
  'bracing+silky':   'The Gyokuro',        // shade-grown umami + bright edge
}

// Three-plus-cluster balanced palates get their own label so we don't
// force a false "top" cluster. Fires when 3+ clusters all sit within
// ~66% of the leader. Named "The Cloud Whisker" — a bit of everything,
// whipped together into one silky palate.
const BALANCED_ARCHETYPE = 'The Cloud Whisker'

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

// Cluster fallback palette — matches flavor-color families in flavors.ts
// (dessert = brown, sweet = pink, earthy = green, bracing = yellow-olive,
// silky = blue). Used when we don't have a per-archetype override.
export function palateArchetypePalette(cluster: ClusterKey): { bg: string; fg: string; border: string } {
  switch (cluster) {
    case 'dessert': return { bg: '#f2e3e0', fg: '#5c3839', border: '#d6bab7' }
    case 'sweet':   return { bg: '#f8e3f0', fg: '#5a2a4b', border: '#e0bad7' }
    case 'earthy':  return { bg: '#e2eedb', fg: '#2f5b3a', border: '#b7d6a8' }
    case 'bracing': return { bg: '#f8fadc', fg: '#5c5d1c', border: '#dcdd94' }
    case 'silky':   return { bg: '#e0f0fa', fg: '#1e4a5f', border: '#a9def9' }
  }
}

// Per-archetype pastel palettes. Each archetype gets its own hue so combo
// archetypes visually differ from their solo cousins (e.g. The Wagashi Pair
// reads as peach, not the plain pink of Creamy Dreamer). Combo hues are
// chosen as visual blends of their two clusters — brown+pink → peach,
// green+blue → teal, pink+blue → lavender — so the chip color still hints
// at the underlying flavor mix.
const ARCHETYPE_PALETTE: Record<string, { bg: string; fg: string; border: string }> = {
  // Solo — each on its own distinct hue, roughly aligned to its cluster
  // family but pushed for max separation from the combo pastels below.
  'The Dessert Sipper':  { bg: '#efdcc8', fg: '#5c3a1f', border: '#d6b78e' }, // cocoa tan
  'The Creamy Dreamer':  { bg: '#fadbe8', fg: '#6a1f47', border: '#f0aecc' }, // rose pink
  'The Purist':          { bg: '#d9ecc4', fg: '#2f5b1e', border: '#b0d488' }, // sage green
  'The Bitter End':      { bg: '#f0f4b8', fg: '#5c5d10', border: '#d9de78' }, // chartreuse
  'The Smooth Operator': { bg: '#d3e9f7', fg: '#123c58', border: '#93c9e9' }, // sky blue
  // Combos — 10 unique hues around the wheel. Each blend still hints at
  // its two clusters, but hues are pushed apart enough that no two chips
  // read the same at ~24px.
  'The Wagashi Pair':    { bg: '#fcd7c5', fg: '#7a2f18', border: '#f5a985' }, // coral peach   (dessert+sweet)
  'The Hojicha Head':    { bg: '#f4c9a8', fg: '#5a2a10', border: '#dd9866' }, // rust          (dessert+earthy)
  'The Koicha Kid':      { bg: '#f5deb0', fg: '#5b3b0a', border: '#e0b96a' }, // amber gold    (dessert+bracing)
  'The Latte Artist':    { bg: '#e6ccc3', fg: '#4a2822', border: '#c99b8c' }, // mocha rose    (dessert+silky)
  'The Bloom Chaser':    { bg: '#cceecc', fg: '#1e5533', border: '#8fd4a2' }, // mint          (sweet+earthy)
  'The Yuzu Sipper':     { bg: '#fbf4b1', fg: '#6b5c0a', border: '#e8db6f' }, // lemon         (sweet+bracing)
  'The Foam Chaser':     { bg: '#e2d0f0', fg: '#3a1e5c', border: '#c19cdd' }, // lavender      (sweet+silky)
  'The Stone Milled':    { bg: '#dde0a4', fg: '#454819', border: '#b8bd63' }, // olive         (earthy+bracing)
  'The Ceremonial':      { bg: '#b8e0dd', fg: '#103a3a', border: '#7bbfbb' }, // teal          (earthy+silky)
  'The Gyokuro':         { bg: '#b4e6cf', fg: '#0e4a34', border: '#6ec7a1' }, // seafoam       (bracing+silky)
  // Balanced 3+ — periwinkle, its own corner of the wheel so nobody
  // confuses it with Foam Chaser (lavender) or Smooth Operator (sky).
  'The Cloud Whisker':   { bg: '#d5d4f2', fg: '#22235c', border: '#a1a1e0' }, // periwinkle
}

// Palette for a specific archetype label, falling back to the primary
// cluster palette if we don't have a hand-picked override.
export function palateArchetypePaletteFor(
  label: string,
  fallbackCluster: ClusterKey,
): { bg: string; fg: string; border: string } {
  return ARCHETYPE_PALETTE[label] || palateArchetypePalette(fallbackCluster)
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

  const tail = describePalate({ flavors, body, shade })

  if (!head && !tail) return ''
  if (!head) return tail
  if (!tail) return head
  return `${head}. ${tail}`
}

// Description-only: body + shade addenda without the archetype head.
// Used by surfaces that render the archetype as a chip and want the
// remaining palate context as a subtitle underneath.
export function describePalate({ flavors, body, shade }: PalateInput): string {
  const ranked = rankClusters(flavors)
  if (ranked.length === 0 && !body && !shade) return ''

  const tail: string[] = []
  // Streak line — surfaced here so the description carries the "secondary
  // flavor" nuance that would otherwise be hidden inside the chip.
  if (ranked.length >= 1) {
    const [top, second] = ranked
    const archetype = archetypeFromRanked(ranked)
    const isSoloPrimary = archetype === PRIMARY_ARCHETYPE[top[0]]
    const hasModestStreak = isSoloPrimary && second && second[1] >= Math.max(1, Math.ceil(top[1] / 2))
    if (hasModestStreak) {
      tail.push(`With a ${SECONDARY_STREAK[second[0]]} streak.`)
    }
  }
  if (body) {
    tail.push(BODY_TAIL[body])
  } else if (typeof shade === 'number') {
    if (shade <= 3) tail.push('Drawn to pale-jade shades.')
    else if (shade >= 7) tail.push('Drawn to deep, vivid greens.')
  }
  return tail.join(' ')
}

