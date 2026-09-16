// Small % match pill used on user/place recommendation cards.
// Semantic single-hue color scale (green ≥70%, amber 40-70%, red <40%)
// replaces the old rainbow gradient. Native title attribute carries the
// "why this match" hint for hover/long-press without a popover UI.

import { bodyProfileLabel } from './flavors'

type MatchBadgeProps = {
  score: number
  myFlavors: string[]
  theirFlavors: string[]
  myBody?: string
  theirBody?: string
  kind: 'user' | 'place'
}

function scoreColors(score: number): { bg: string; fg: string; border: string } {
  if (score >= 0.7) {
    return { bg: 'linear-gradient(90deg, #b9e7c1 0%, #7fd1a1 100%)', fg: '#0f5132', border: '#4fb977' }
  }
  if (score >= 0.4) {
    return { bg: 'linear-gradient(90deg, #ffe6a8 0%, #ffd47a 100%)', fg: '#7a5a0f', border: '#e0b04a' }
  }
  return { bg: 'linear-gradient(90deg, #ffd5c2 0%, #ffb599 100%)', fg: '#7a2f1a', border: '#e08a70' }
}

function normalize(list: string[]): string[] {
  return list.filter((f) => typeof f === 'string' && !f.startsWith('__')).map((f) => f.toLowerCase())
}

function buildTitle(props: MatchBadgeProps): string {
  const mine = new Set(normalize(props.myFlavors))
  const theirs = new Set(normalize(props.theirFlavors))
  const shared = [...mine].filter((f) => theirs.has(f))
  const parts: string[] = []
  if (shared.length > 0) {
    parts.push(`Shared flavors: ${shared.slice(0, 4).join(', ')}`)
  }
  if (props.myBody && props.theirBody && props.myBody === props.theirBody) {
    parts.push(`Same body: ${bodyProfileLabel(props.myBody)}`)
  }
  return parts.length ? parts.join(' \u2022 ') : `${Math.round(props.score * 100)}% match`
}

export function MatchBadge(props: MatchBadgeProps) {
  const pct = Math.round(props.score * 100)
  const colors = scoreColors(props.score)
  const title = buildTitle(props)

  return (
    <span
      title={title}
      aria-label={`${pct}% match. ${title}`}
      style={{
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        fontSize: '0.72rem',
        background: colors.bg,
        color: colors.fg,
        border: `1px solid ${colors.border}`,
        fontWeight: 700,
        padding: '0.3rem 0.6rem',
        borderRadius: '999px',
        boxShadow: '0 1px 3px rgba(15, 23, 42, 0.08)',
        lineHeight: 1.2,
      }}
    >
      {pct}% match
    </span>
  )
}
