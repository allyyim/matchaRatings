// Feed tab — friend activity + milestone recap + place recs.
// Extracted from App.tsx and lazy-loaded via React.lazy in the shell.
// All state (myEntries, friendRatings, recPlaces, loading flags) lives in
// App.tsx and is passed via props — this is a pure presentational surface.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { RatingEntry } from '../lib/types'
import { TruncatedThought } from '../lib/TruncatedThought'
import { EmptyState } from '../lib/EmptyState'

// Thresholds that trigger a milestone card in the Feed's "Milestone recap"
// row. Kept in sync with the identically-shaped map inside saveEntry() so the
// feed replays the exact same celebrations the user saw when they first hit
// each threshold.
const FEED_MILESTONE_THRESHOLDS: Array<{ count: number; headline: string; subtext: (place: string) => string }> = [
  { count: 1,   headline: 'First sip logged 🍵',   subtext: (p) => `${p} kicked off your matcha journey.` },
  { count: 10,  headline: '10 places rated 🎉',    subtext: (p) => `${p} makes it 10 — your log was officially rolling.` },
  { count: 25,  headline: '25 spots scored 🍵',    subtext: (p) => `${p} became #25 on your matcha map.` },
  { count: 50,  headline: '50 places whisked ✨',  subtext: (p) => `Half a hundred — ${p} landed you at 50.` },
  { count: 100, headline: '100 places rated 🎉🍵', subtext: (p) => `Certified sipper status unlocked at ${p}.` },
  { count: 125, headline: '125 places deep 🍃',    subtext: (p) => `${p} rounded you out at 125 spots.` },
  { count: 150, headline: '150 places rated 🍵',   subtext: (p) => `The whisk masters approve — ${p} was #150.` },
  { count: 200, headline: '200 places! 🎊',        subtext: (p) => `Living-legend status. ${p} was your 200th.` }
]

function feedRelativeTime(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const diffMs = Date.now() - t
  const diffMin = Math.round(diffMs / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin} min ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr} hr${diffHr === 1 ? '' : 's'} ago`
  const diffDay = Math.round(diffHr / 24)
  if (diffDay < 30) return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`
  const diffMo = Math.round(diffDay / 30)
  if (diffMo < 12) return `${diffMo} month${diffMo === 1 ? '' : 's'} ago`
  const diffYr = Math.round(diffMo / 12)
  return `${diffYr} year${diffYr === 1 ? '' : 's'} ago`
}

type FeedEvent =
  | { kind: 'milestone'; ts: number; headline: string; subtext: string; count: number }
  | { kind: 'friend'; ts: number; entry: RatingEntry }
  | { kind: 'rec'; ts: number; location: string; matchScore: number; flavors: string[] }

// Sort priority so milestones always surface at the top of the feed
// regardless of when they were achieved. Without this, an old milestone
// (say your 1st sip from 3 months ago) gets buried under fresh friend
// ratings that have brand-new timestamps and never renders in view.
// Higher = surfaces first.
const FEED_KIND_PRIORITY: Record<FeedEvent['kind'], number> = {
  milestone: 2,
  rec: 1,
  friend: 0,
}

function FeedThought({ text }: { text: string }) {
  return <TruncatedThought text={text} as="div" className="feed-item-thought" quote />
}

export default function FeedPage(props: {
  myEntries: RatingEntry[]
  friendRatings: RatingEntry[]
  recPlaces: Array<{ location: string; flavors: string[]; body?: string; matchScore: number }>
  isLoading: boolean
  isDemoAccount: boolean
  onOpenFriend: (userName: string) => void
  onOpenPlace: (placeName: string) => void
  onToggleLike: (ratingId: number, nextLiked: boolean) => Promise<void>
}) {
  const { myEntries, friendRatings, recPlaces, isLoading, isDemoAccount, onOpenFriend, onOpenPlace, onToggleLike } = props

  // Optimistic like state keyed by rating id. Server-truth (likeCount /
  // likedByMe) hydrates this whenever friendRatings changes, but user taps
  // update the local map immediately for a snappy feel.
  const [likeState, setLikeState] = useState<Record<number, { count: number; liked: boolean }>>({})
  useEffect(() => {
    setLikeState((prev) => {
      const next: Record<number, { count: number; liked: boolean }> = {}
      for (const r of friendRatings) {
        const server = { count: r.likeCount ?? 0, liked: !!r.likedByMe }
        const local = prev[r.id]
        // Prefer server truth unless the user has an unresolved optimistic
        // toggle since last poll (i.e., local liked differs from server).
        next[r.id] = local && local.liked !== server.liked ? local : server
      }
      return next
    })
  }, [friendRatings])

  // Track which friend ratings are brand new relative to the previous poll so
  // we can flash a soft "just now" highlight when they arrive.
  const seenIdsRef = useRef<Set<number>>(new Set())
  const [freshIds, setFreshIds] = useState<Set<number>>(new Set())
  useEffect(() => {
    const currentIds = new Set(friendRatings.map((r) => r.id))
    if (seenIdsRef.current.size === 0) {
      // First load — everything is "already known", no highlight.
      seenIdsRef.current = currentIds
      return
    }
    const newlyArrived: number[] = []
    currentIds.forEach((id) => {
      if (!seenIdsRef.current.has(id)) newlyArrived.push(id)
    })
    seenIdsRef.current = currentIds
    if (newlyArrived.length === 0) return
    setFreshIds((prev) => {
      const next = new Set(prev)
      newlyArrived.forEach((id) => next.add(id))
      return next
    })
    const timeout = window.setTimeout(() => {
      setFreshIds((prev) => {
        const next = new Set(prev)
        newlyArrived.forEach((id) => next.delete(id))
        return next
      })
    }, 6000)
    return () => window.clearTimeout(timeout)
  }, [friendRatings])

  const events = useMemo<FeedEvent[]>(() => {
    const out: FeedEvent[] = []

    // 1) Milestone recap — walk the user's log chronologically (earliest first)
    // and record the entry that pushed each unique-place count onto a threshold.
    const sortedForMilestones = [...myEntries].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    const seenPlaces = new Set<string>()
    const normalize = (loc: string) => loc.trim().toLowerCase().replace(/\s+/g, ' ')
    for (const entry of sortedForMilestones) {
      const key = normalize(entry.location || '')
      if (!key || seenPlaces.has(key)) continue
      seenPlaces.add(key)
      const count = seenPlaces.size
      const threshold = FEED_MILESTONE_THRESHOLDS.find((m) => m.count === count)
      if (!threshold) continue
      out.push({
        kind: 'milestone',
        ts: new Date(entry.createdAt).getTime(),
        headline: threshold.headline,
        subtext: threshold.subtext(entry.location || 'that spot'),
        count
      })
    }

    // 2) Friend activity
    for (const entry of friendRatings) {
      const ts = new Date(entry.createdAt).getTime()
      if (!Number.isFinite(ts)) continue
      out.push({ kind: 'friend', ts, entry })
    }

    // 3) Recs — no server timestamp; assume "just refreshed" so they sit at
    // the top of the feed as the freshest signal the user has right now.
    const nowTs = Date.now()
    for (const place of recPlaces.slice(0, 5)) {
      out.push({
        kind: 'rec',
        ts: nowTs,
        location: place.location,
        matchScore: place.matchScore,
        flavors: place.flavors || []
      })
    }

    return out.sort((a, b) => {
      const pa = FEED_KIND_PRIORITY[a.kind]
      const pb = FEED_KIND_PRIORITY[b.kind]
      if (pa !== pb) return pb - pa
      return b.ts - a.ts
    })
  }, [myEntries, friendRatings, recPlaces])

  // Note: demo previously short-circuited here with an upsell; we now let
  // demo see the Feed so the auto-follow of the maintainer account gives
  // reviewers real friend activity to browse.
  void isDemoAccount

  return (
    <section className="card border-0 shadow-sm matcha-shell mb-4">
      <div className="card-body p-3 p-md-4">
        <div className="d-flex align-items-center justify-content-between mb-3">
          <h2 className="h3 fw-bold text-success mb-0">Feed</h2>
          {isLoading && <span className="text-muted small">Refreshing…</span>}
        </div>
        <p className="text-muted small mb-4">Milestones you've hit, friends' newest sips, and fresh recs picked for your palate.</p>

        {events.length === 0 ? (
          <EmptyState
            emoji="🍵"
            headline="Quiet in here. Rate a spot to wake up your feed."
            subtext="Every rating you log, milestone you hit, and sipper you follow shows up right here."
          />
        ) : (
          <>
            {friendRatings.length === 0 && !isLoading && (
              <div className="feed-notice" role="status">
                <span aria-hidden="true">👥</span>
                <span>Nothing new from your circle. Follow more sippers in <strong>Explore</strong> to keep the feed pouring.</span>
              </div>
            )}
          <ul className="feed-list" role="list">
            {events.map((event, index) => {
              if (event.kind === 'milestone') {
                return (
                  <li key={`m-${event.count}-${index}`} className="feed-item feed-item-milestone">
                    <div className="feed-item-icon" aria-hidden="true">🏆</div>
                    <div className="feed-item-body">
                      <div className="feed-item-headline">{event.headline}</div>
                      <div className="feed-item-sub">{event.subtext}</div>
                      <div className="feed-item-meta">{feedRelativeTime(new Date(event.ts).toISOString())}</div>
                    </div>
                  </li>
                )
              }
              if (event.kind === 'friend') {
                const { entry } = event
                const placeLabel = entry.location || 'a matcha'
                const displayScore = entry.comboScore != null ? (entry.comboScore / 2).toFixed(1) : '—'
                const handleCardActivate = () => {
                  if (entry.location) onOpenPlace(entry.location)
                }
                return (
                  <li
                    key={`f-${entry.id}`}
                    className={`feed-item feed-item-friend feed-item-clickable ${freshIds.has(entry.id) ? 'feed-item-fresh' : ''}`.trim()}
                    role={entry.location ? 'button' : undefined}
                    tabIndex={entry.location ? 0 : undefined}
                    onClick={entry.location ? handleCardActivate : undefined}
                    onKeyDown={entry.location ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleCardActivate() }
                    } : undefined}
                    aria-label={entry.location ? `See all ratings for ${entry.location}` : undefined}
                  >
                    {entry.userAvatarUrl ? (
                      <div className="feed-item-icon feed-item-avatar" aria-hidden="true">
                        <img src={entry.userAvatarUrl} alt="" loading="lazy" decoding="async" />
                      </div>
                    ) : (
                      <div className="feed-item-icon" aria-hidden="true">👥</div>
                    )}
                    <div className="feed-item-body">
                      <div className="feed-item-headline">
                        <button
                          type="button"
                          className="feed-user-link"
                          onClick={(e) => { e.stopPropagation(); onOpenFriend(entry.userName) }}
                        >
                          {entry.userName}
                        </button>
                        {' '}just logged{' '}
                        <span className="feed-place">{entry.location || placeLabel}</span>
                      </div>
                      <div className="feed-item-sub">
                        Sip Score <strong>{displayScore}</strong>
                        {typeof entry.greenness === 'number' ? <> · <span className="feed-greenness">{Math.round(entry.greenness)}% matcha greenness</span></> : null}
                      </div>
                      {entry.thoughts ? (
                        <div onClick={(e) => e.stopPropagation()}>
                          <FeedThought text={entry.thoughts} />
                        </div>
                      ) : null}
                      <div className="feed-item-meta feed-item-meta-row">
                        <span>{feedRelativeTime(entry.createdAt)}</span>
                        {(() => {
                          const s = likeState[entry.id] || { count: entry.likeCount ?? 0, liked: !!entry.likedByMe }
                          return (
                            <button
                              type="button"
                              className={`feed-like-btn ${s.liked ? 'is-liked' : ''}`}
                              aria-pressed={s.liked}
                              aria-label={s.liked ? 'Unlike' : 'Like'}
                              onClick={(e) => {
                                e.stopPropagation()
                                const prev = s
                                const nextLiked = !prev.liked
                                setLikeState((cur) => ({
                                  ...cur,
                                  [entry.id]: {
                                    liked: nextLiked,
                                    count: Math.max(0, prev.count + (nextLiked ? 1 : -1))
                                  }
                                }))
                                onToggleLike(entry.id, nextLiked).catch(() => {
                                  setLikeState((cur) => ({ ...cur, [entry.id]: prev }))
                                })
                              }}
                            >
                              {s.count > 0 && <span className="feed-like-count">{s.count} {s.count === 1 ? 'like' : 'likes'}</span>}
                              <span aria-hidden="true" className="feed-like-heart">
                                <svg viewBox="0 0 24 24" width="18" height="18" fill={s.liked ? '#ef4444' : 'none'} stroke="var(--text-muted)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                                </svg>
                              </span>
                            </button>
                          )
                        })()}
                      </div>
                    </div>
                  </li>
                )
              }
              return (
                <li
                  key={`r-${event.location}-${index}`}
                  className="feed-item feed-item-rec feed-item-clickable"
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpenPlace(event.location)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenPlace(event.location) }
                  }}
                  aria-label={`See all ratings for ${event.location}`}
                >
                  <div className="feed-item-icon" aria-hidden="true">🌟</div>
                  <div className="feed-item-body">
                    <div className="feed-item-headline">
                      <span className="feed-place">{event.location}</span>
                      {' '}matches your top-rated profile
                    </div>
                    <div className="feed-item-sub">
                      <strong>{Math.round(event.matchScore * 100)}% match</strong>
                      {event.flavors.length > 0 ? <> · {event.flavors.slice(0, 3).join(', ')}</> : null}
                    </div>
                    <div className="feed-item-meta">Fresh rec</div>
                  </div>
                </li>
              )
            })}
          </ul>
          </>
        )}
      </div>
    </section>
  )
}
