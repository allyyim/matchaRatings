export type ShadeOption = { value: number; label: string; color: string; target: number }

// Preferred matcha shade (1..9). Each shade maps to a target greenness %,
// which is what the greenness analyzer produces per-photo. The similar-places
// algorithm blends shade proximity into its match score so users see places
// whose average color matches their ideal cup.
export const SHADE_OPTIONS: ShadeOption[] = [
  { value: 1, label: 'Milky latte',        color: '#f5f0d8', target: 8  },
  { value: 2, label: 'Café blend',         color: '#d4e2a5', target: 20 },
  { value: 3, label: 'Culinary grade',     color: '#b8d693', target: 32 },
  { value: 4, label: 'Everyday usucha',    color: '#a8ce6a', target: 44 },
  { value: 5, label: 'Ceremonial usucha',  color: '#8bbf4d', target: 56 },
  { value: 6, label: 'Premium ceremonial', color: '#5fa832', target: 68 },
  { value: 7, label: 'Koicha (thick tea)', color: '#4a8f22', target: 78 },
  { value: 8, label: 'Shade-grown gyokuro',color: '#2d6e18', target: 88 },
  { value: 9, label: 'Stone-ground umami', color: '#1a4a0e', target: 96 }
]

export function shadeColorForGreenness(greenness: number): string {
  if (typeof greenness !== 'number' || Number.isNaN(greenness)) return '#e9ecef'
  let closest = SHADE_OPTIONS[0]
  let bestDist = Infinity
  for (const s of SHADE_OPTIONS) {
    const d = Math.abs(s.target - greenness)
    if (d < bestDist) { bestDist = d; closest = s }
  }
  return closest.color
}