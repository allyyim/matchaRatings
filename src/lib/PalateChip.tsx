// Small pill showing a user's palate archetype (e.g. "The Dessert Sipper").
// Rendered next to usernames across the app — Explore leaderboard, "People
// like you" cards, friend modal. Hidden entirely when the target user has
// no flavor preferences, so we never show an empty chip.
//
// Colored by the archetype's dominant flavor cluster so it visually rhymes
// with the chip grid the user already recognizes from their own profile.

import type { CSSProperties } from 'react'
import { palateArchetype, palateArchetypeCluster, palateArchetypePaletteFor } from './palateSummary'

type PalateChipProps = {
  flavors: string[]
  size?: 'xs' | 'sm'
  onClick?: () => void
  active?: boolean
  title?: string
}

export function PalateChip({ flavors, size = 'sm', onClick, active = false, title }: PalateChipProps) {
  const label = palateArchetype(flavors)
  if (!label) return null
  const cluster = palateArchetypeCluster(flavors)
  if (!cluster) return null
  const palette = palateArchetypePaletteFor(label, cluster)

  const fontSize = size === 'xs' ? '0.62rem' : '0.68rem'
  const padding = size === 'xs' ? '0.15rem 0.5rem' : '0.22rem 0.6rem'

  const commonStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    fontSize,
    fontWeight: 600,
    padding,
    borderRadius: '999px',
    background: active ? palette.fg : palette.bg,
    color: active ? '#fff' : palette.fg,
    border: `1px solid ${palette.border}`,
    lineHeight: 1.2,
    whiteSpace: 'nowrap',
  }

  if (onClick) {
    return (
      <button
        type="button"
        className="palate-chip palate-chip--interactive"
        title={title || (active ? `Clear ${label} filter` : `Show only ${label}`)}
        onClick={(event) => {
          event.stopPropagation()
          onClick()
        }}
        style={{
          ...commonStyle,
          cursor: 'pointer',
          appearance: 'none',
          WebkitAppearance: 'none',
        }}
      >
        {label}
        {active && <span aria-hidden="true" style={{ marginLeft: '0.35rem', fontWeight: 700 }}>×</span>}
      </button>
    )
  }

  return (
    <span className="palate-chip" title={title || label} style={commonStyle}>
      {label}
    </span>
  )
}
