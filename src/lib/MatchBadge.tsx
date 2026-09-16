// Small info-carrying badge used for the "N% match" pill on user/place
// recommendation cards. Click/tap to reveal a plain-English explanation
// of what drove the score. Everything lives in the client — no server
// change needed because both the flavor list and the viewer's own
// preferences are already known here.

import { useEffect, useRef, useState } from 'react'
import { bodyProfileLabel } from './flavors'

type MatchBadgeProps = {
  score: number
  myFlavors: string[]
  theirFlavors: string[]
  myBody?: string
  theirBody?: string
  kind: 'user' | 'place'
}

// Consistent single-hue color scale so users can read "how good a match"
// at a glance instead of decoding a rainbow gradient. Palette matches
// the app's green/amber/red semantic tones.
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

function buildReasons(props: MatchBadgeProps): string[] {
  const reasons: string[] = []
  const mine = new Set(normalize(props.myFlavors))
  const theirs = new Set(normalize(props.theirFlavors))
  const shared = [...mine].filter((f) => theirs.has(f))
  if (shared.length > 0) {
    const preview = shared.slice(0, 3).join(', ')
    reasons.push(
      shared.length === 1
        ? `Both love ${preview}`
        : `Shared flavor notes: ${preview}${shared.length > 3 ? `, +${shared.length - 3} more` : ''}`
    )
  }
  if (props.myBody && props.theirBody && props.myBody === props.theirBody) {
    reasons.push(`Same matcha body preference (${bodyProfileLabel(props.myBody)})`)
  }
  if (reasons.length === 0) {
    reasons.push(
      props.kind === 'user'
        ? 'Similar taste profile overall'
        : 'Overlaps with what you\u2019ve rated highly'
    )
  }
  return reasons
}

export function MatchBadge(props: MatchBadgeProps) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLSpanElement | null>(null)
  const pct = Math.round(props.score * 100)
  const colors = scoreColors(props.score)

  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      if (!wrapperRef.current) return
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const reasons = buildReasons(props)

  return (
    <span
      ref={wrapperRef}
      style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        aria-expanded={open}
        aria-label={`${pct}% match. Tap to see why.`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.25rem',
          fontSize: '0.72rem',
          background: colors.bg,
          color: colors.fg,
          border: `1px solid ${colors.border}`,
          fontWeight: 700,
          padding: '0.3rem 0.6rem',
          borderRadius: '999px',
          boxShadow: '0 1px 3px rgba(15, 23, 42, 0.08)',
          cursor: 'pointer',
          appearance: 'none',
          lineHeight: 1.2,
        }}
      >
        {pct}% match
        <span
          aria-hidden="true"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '0.95rem',
            height: '0.95rem',
            borderRadius: '999px',
            border: `1px solid ${colors.border}`,
            fontSize: '0.65rem',
            fontWeight: 700,
            fontStyle: 'italic',
            fontFamily: 'Georgia, serif',
          }}
        >
          i
        </span>
      </button>
      {open && (
        <div
          role="tooltip"
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            zIndex: 30,
            minWidth: 220,
            maxWidth: 280,
            background: 'white',
            border: '1px solid rgba(15, 23, 42, 0.1)',
            borderRadius: '0.75rem',
            boxShadow: '0 10px 24px rgba(15, 23, 42, 0.15), 0 2px 6px rgba(15, 23, 42, 0.06)',
            padding: '0.7rem 0.85rem',
            fontSize: '0.78rem',
            color: '#334155',
            textAlign: 'left',
            lineHeight: 1.4,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: '0.35rem', color: '#0f5132' }}>
            Why {pct}%?
          </div>
          <ul style={{ margin: 0, paddingLeft: '1rem' }}>
            {reasons.map((r, i) => (
              <li key={i} style={{ marginBottom: i === reasons.length - 1 ? 0 : '0.2rem' }}>{r}</li>
            ))}
          </ul>
        </div>
      )}
    </span>
  )
}
