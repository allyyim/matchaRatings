// First-run activation card on Home. Shows three tasks that unblock the
// "aha" moment (personalized recs + a populated Feed):
//   1. Set flavor preferences
//   2. Log first matcha rating
//   3. Follow at least one person
//
// Auto-hides once all three are done. User can also dismiss it early
// (persisted in localStorage) — we won't nag once you've dismissed it.
// Not shown to the demo account (they get the slide-deck onboarding
// on every login), and not shown to established users (>=3 ratings).

import { useMemo, useState } from 'react'

type OnboardingChecklistProps = {
  currentUserName: string
  isDemoAccount: boolean
  isLoading: boolean
  ratingCount: number
  flavorCount: number
  followingCount: number
  onGoToPrefs: () => void
  onGoToNewLog: () => void
  onGoToExplore: () => void
}

const DISMISS_KEY_PREFIX = 'matcha:onboardChecklistDismissed:'

export function OnboardingChecklist(props: OnboardingChecklistProps) {
  const dismissKey = `${DISMISS_KEY_PREFIX}${props.currentUserName.toLowerCase()}`
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try { return localStorage.getItem(dismissKey) === '1' } catch { return false }
  })

  const hasFlavors = props.flavorCount > 0
  const hasRating = props.ratingCount > 0
  const hasFollow = props.followingCount > 0
  const completed = hasFlavors && hasRating && hasFollow

  // Hard-hide rules — the checklist is only for genuinely new users
  const shouldRender = useMemo(() => {
    if (props.isDemoAccount) return false
    if (dismissed) return false
    if (completed) return false
    // Suppress until the user's own data has loaded — otherwise on login
    // we flash "log your first rating / follow someone" before the
    // /ratings and /following fetches resolve.
    if (props.isLoading) return false
    // If they've already got several ratings, they're not a new user
    if (props.ratingCount >= 3) return false
    return true
  }, [props.isDemoAccount, dismissed, completed, props.ratingCount, props.isLoading])

  if (!shouldRender) return null

  const doneCount = [hasFlavors, hasRating, hasFollow].filter(Boolean).length

  function handleDismiss() {
    try { localStorage.setItem(dismissKey, '1') } catch { /* ignore */ }
    setDismissed(true)
  }

  const items: Array<{ done: boolean; label: string; cta: string; action: () => void }> = [
    {
      done: hasFlavors,
      label: 'Set your flavor preferences',
      cta: 'Choose flavors',
      action: props.onGoToPrefs,
    },
    {
      done: hasRating,
      label: 'Log your first matcha rating',
      cta: 'Rate a matcha',
      action: props.onGoToNewLog,
    },
    {
      done: hasFollow,
      label: 'Follow at least one sipper',
      cta: 'Find sippers',
      action: props.onGoToExplore,
    },
  ]

  return (
    <div
      className="onboarding-checklist card border-0 shadow-sm mb-4"
      role="region"
      aria-label="Getting started checklist"
      style={{
        background: 'linear-gradient(135deg, #f4faf1 0%, #eaf5ec 100%)',
        border: '1px solid rgba(25, 135, 84, 0.15)',
      }}
    >
      <div className="card-body p-3 p-md-4">
        <div className="d-flex align-items-start justify-content-between mb-2 gap-2">
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: '#2f7a44' }}>
              You're in
            </div>
            <h2 className="h6 fw-bold mb-0 mt-1 text-success">
              3 quick steps for better recs
            </h2>
          </div>
          <button
            type="button"
            onClick={handleDismiss}
            aria-label="Dismiss checklist"
            style={{
              background: 'transparent',
              border: 0,
              color: 'var(--text-muted)',
              fontSize: '1.1rem',
              lineHeight: 1,
              cursor: 'pointer',
              padding: '0.15rem 0.35rem',
              borderRadius: '0.5rem',
            }}
          >
            ✕
          </button>
        </div>
        <div
          aria-hidden="true"
          style={{
            height: 6,
            borderRadius: 999,
            background: 'rgba(25, 135, 84, 0.12)',
            marginBottom: '0.85rem',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${(doneCount / 3) * 100}%`,
              height: '100%',
              background: 'linear-gradient(90deg, #7fd1a1 0%, #2f7a44 100%)',
              transition: 'width 0.3s ease',
            }}
          />
        </div>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {items.map((item) => (
            <li key={item.label} style={{ display: 'flex', alignItems: 'center', gap: '0.7rem' }}>
              <span
                aria-hidden="true"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 22,
                  height: 22,
                  borderRadius: '999px',
                  flexShrink: 0,
                  fontSize: '0.75rem',
                  fontWeight: 700,
                  background: item.done ? '#2f7a44' : 'white',
                  color: item.done ? 'white' : '#94a3b8',
                  border: item.done ? '1px solid #2f7a44' : '1px solid #cbd5e1',
                }}
              >
                {item.done ? '✓' : ''}
              </span>
              <span
                style={{
                  flex: 1,
                  fontSize: '0.9rem',
                  color: item.done ? 'var(--text-muted)' : '#1f2937',
                  textDecoration: item.done ? 'line-through' : 'none',
                }}
              >
                {item.label}
              </span>
              {!item.done && (
                <button
                  type="button"
                  onClick={item.action}
                  className="btn btn-sm"
                  style={{
                    background: 'white',
                    color: '#2f7a44',
                    border: '1px solid #2f7a44',
                    borderRadius: 999,
                    padding: '0.25rem 0.7rem',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    flexShrink: 0,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {item.cta}
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
