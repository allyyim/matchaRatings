// Flavor + body vocabulary shared across the app. Kept in a single module
// so App.tsx, FeedPage, ExplorePage, etc. all read the same source of truth
// when rendering chips, computing recommendations, or seeding demo data.
//
// Order matters — this is the exact left-to-right / top-to-bottom order
// the flavor grid renders in every surface (new-rating modal, edit modal,
// My Matcha Preferences). Grouped by color family so tags of the same
// palette sit adjacent, then the whole grid reads as a rainbow strip.

export const FLAVOR_LIST = [
  // brown / dessert
  'Chocolatey', 'nutty', 'velvety', 'rich',
  // pink / sweet — floral joined this cluster because it's a delicate,
  // fragrant top-note that groups tonally with sweet/creamy, not umami.
  'sweet', 'sugary', 'creamy', 'floral',
  // green / earthy — grassy is new; sits between vegetal and astringent
  // as the classic "fresh cut lawn" note tea drinkers ask for.
  'earthy', 'vegetal', 'grassy',
  // yellow / bracing
  'astringent', 'bitter',
  // blue / silky — umami joined this cluster because its savory, mouth-
  // filling character reads as smooth/silky rather than green/earthy.
  'mellow', 'smooth', 'umami',
] as const

export type BodyProfileValue = 'full-bodied' | 'medium' | 'milky'

export const BODY_PROFILE_OPTIONS: Array<{ value: BodyProfileValue; label: string; desc: string }> = [
  { value: 'full-bodied', label: 'Full-bodied', desc: 'Rich, thick, and coats the tongue — a bold matcha-forward mouthfeel.' },
  { value: 'medium', label: 'Medium', desc: 'Balanced weight and creaminess — not too heavy, not too light.' },
  { value: 'milky', label: 'Milky', desc: 'Lighter and creamier — milk or foam takes the lead over the matcha.' }
]

// Ordering by color group so tags of the same palette sit next to each other.
// Kept in sync with FLAVOR_LIST — same grouping, same order.
export const FLAVOR_COLOR_ORDER: Record<string, number> = {
  chocolatey: 0, nutty: 1, velvety: 2, rich: 3,
  sweet: 4, sugary: 5, creamy: 6, floral: 7,
  earthy: 8, vegetal: 9, grassy: 10,
  astringent: 11, bitter: 12,
  mellow: 13, smooth: 14, umami: 15,
}

export function sortFlavorsByColor(flavors: string[]): string[] {
  return [...flavors].sort((a, b) => {
    const ra = FLAVOR_COLOR_ORDER[String(a).toLowerCase()] ?? 99
    const rb = FLAVOR_COLOR_ORDER[String(b).toLowerCase()] ?? 99
    return ra - rb
  })
}

// Case-insensitive so legacy records (e.g. `Chocolatey`) match the current
// lowercase vocabulary. Without this, mixed-case flavors get filtered out
// of friend-modal chips even though the same data renders fine elsewhere,
// which caused the "palate chip appears on the leaderboard but disappears
// after tapping a user" inconsistency.
export function isKnownFlavor(key: string): boolean {
  const norm = String(key || '').toLowerCase()
  return FLAVOR_LIST.some((f) => String(f).toLowerCase() === norm)
}

export function getBodyProfile(prefs?: Record<string, number>): '' | BodyProfileValue {
  if (!prefs) return ''
  for (const opt of BODY_PROFILE_OPTIONS) {
    if (Number(prefs[`__body:${opt.value}`]) > 0) return opt.value
  }
  return ''
}

export function setBodyProfile(prefs: Record<string, number>, body: '' | BodyProfileValue): Record<string, number> {
  const next = { ...prefs }
  for (const opt of BODY_PROFILE_OPTIONS) {
    delete next[`__body:${opt.value}`]
  }
  if (body) next[`__body:${body}`] = 100
  return next
}

export function bodyProfileLabel(body: string): string {
  const opt = BODY_PROFILE_OPTIONS.find((o) => o.value === body)
  return opt ? opt.label : ''
}

export type ChipPalette = { bg: string; fg: string; border: string }

// Per-flavor palette. Returns background + text + border color for a tag/bubble.
// Groups mirror FLAVOR_LIST clusters:
//   dessert (brown): chocolatey, nutty, velvety, rich
//   sweet (pink):    sweet, sugary, creamy, floral
//   earthy (green):  earthy, vegetal, grassy
//   bracing (yellow):astringent, bitter
//   silky (blue):    mellow, smooth, umami
export function flavorColor(flavor: string): ChipPalette {
  const key = String(flavor || '').toLowerCase()
  if (key === 'chocolatey' || key === 'nutty' || key === 'velvety' || key === 'rich') return { bg: '#815355', fg: '#ffffff', border: '#5c3839' }
  if (key === 'sugary' || key === 'sweet' || key === 'creamy' || key === 'floral') return { bg: '#E0BAD7', fg: '#5a2a4b', border: '#c290b3' }
  if (key === 'earthy' || key === 'vegetal' || key === 'grassy') return { bg: '#63a375', fg: '#ffffff', border: '#4a7d5a' }
  if (key === 'astringent' || key === 'bitter') return { bg: '#F8FA90', fg: '#5c5d1c', border: '#c9cb6d' }
  if (key === 'mellow' || key === 'smooth' || key === 'umami') return { bg: '#A9DEF9', fg: '#1e4a5f', border: '#7fbbdc' }
  return { bg: '#82D99E', fg: '#0b6e4f', border: '#0b6e4f' }
}

// Body palette: varying shades of #3AAFB9.
export function bodyColor(body: string): ChipPalette {
  if (body === 'full-bodied') return { bg: '#26808a', fg: '#ffffff', border: '#1a5f66' }
  if (body === 'medium') return { bg: '#3AAFB9', fg: '#ffffff', border: '#26808a' }
  if (body === 'milky') return { bg: '#8ed5db', fg: '#0e3d43', border: '#5aa9b1' }
  return { bg: '#3AAFB9', fg: '#ffffff', border: '#26808a' }
}
