// Small pill showing a user's palate archetype (e.g. "The Dessert Sipper").
// Rendered next to usernames across the app — Explore leaderboard, "People
// like you" cards, friend modal. Hidden entirely when the target user has
// no flavor preferences, so we never show an empty chip.
//
// Colored by the archetype's dominant flavor cluster so it visually rhymes
// with the chip grid the user already recognizes from their own profile.

import { palateArchetype, palateArchetypeCluster, palateArchetypePalette } from './palateSummary'

export function PalateChip({ flavors, size = 'sm' }: { flavors: string[]; size?: 'xs' | 'sm' }) {
  const label = palateArchetype(flavors)
  if (!label) return null
  const cluster = palateArchetypeCluster(flavors)
  if (!cluster) return null
  const palette = palateArchetypePalette(cluster)

  const fontSize = size === 'xs' ? '0.62rem' : '0.68rem'
  const padding = size === 'xs' ? '0.15rem 0.5rem' : '0.22rem 0.6rem'

  return (
    <span
      className="palate-chip"
      title={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        fontSize,
        fontWeight: 600,
        padding,
        borderRadius: '999px',
        background: palette.bg,
        color: palette.fg,
        border: `1px solid ${palette.border}`,
        lineHeight: 1.2,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  )
}
