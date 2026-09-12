// Community Leaderboard tab — Places + Users segmented view.
//
// Extracted from App.tsx as a presentational/dumb component so it can be
// React.lazy()'d in the App shell. All state, fetches, and modals stay in
// App.tsx; this file only owns the JSX and immediate event wiring.

export type ExplorePlace = {
  rank: number
  placeName: string
  entryCount: number
  averageScore: number
}

export type ExploreUser = {
  userName: string
  placeCount: number
}

type FollowResponse = unknown

type SavedEntryToast = { headline: string; connector: string; highlight: string } | null

export type ExplorePageProps = {
  exploreActiveTab: 'places' | 'users'
  setExploreActiveTab: (tab: 'places' | 'users') => void
  explorePlaces: ExplorePlace[]
  exploreUsers: ExploreUser[]
  currentUserName: string
  followingSet: Set<string>
  setFollowingSet: (next: Set<string>) => void
  setSavedEntryToast: (toast: SavedEntryToast) => void
  openExplorePlaceRatings: (placeName: string) => void | Promise<void>
  openFriendModal: (userName: string) => void | Promise<void>
  apiFetch: <T = FollowResponse>(path: string, init?: RequestInit) => Promise<T>
}

export default function ExplorePage(props: ExplorePageProps) {
  const {
    exploreActiveTab,
    setExploreActiveTab,
    explorePlaces,
    exploreUsers,
    currentUserName,
    followingSet,
    setFollowingSet,
    setSavedEntryToast,
    openExplorePlaceRatings,
    openFriendModal,
    apiFetch
  } = props

  return (
    <main id="main-content" className="container py-3 py-md-5 px-3 px-md-4" tabIndex={-1}>
      <section className="card border-0 shadow-sm matcha-shell mb-4">
        <div className="card-body p-3 p-md-4">
          <h2 className="h3 fw-bold text-success mb-4">Community Leaderboard</h2>

          <div className="segmented-tabs segmented-tabs-full mb-4" role="tablist" aria-label="Leaderboard sections">
            <button
              type="button"
              role="tab"
              aria-selected={exploreActiveTab === 'places'}
              className={`segmented-tab ${exploreActiveTab === 'places' ? 'is-active' : ''}`}
              onClick={() => setExploreActiveTab('places')}
            >
              Places
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={exploreActiveTab === 'users'}
              className={`segmented-tab ${exploreActiveTab === 'users' ? 'is-active' : ''}`}
              onClick={() => setExploreActiveTab('users')}
            >
              Users
            </button>
          </div>

          {exploreActiveTab === 'places' && (
            <section>
              <div className="explore-places-subtitle-wrapper mb-3">
                <p className="explore-places-subtitle">
                  <span className="explore-places-badge">Top 10</span>
                  <span className="explore-places-tag">community picks</span>
                </p>
              </div>

              {explorePlaces.length === 0 && (
                <div className="alert alert-light border mb-0 text-center">No place data yet. Add ratings to build rankings.</div>
              )}

              {explorePlaces.length > 0 && (
                <div className="d-flex flex-column gap-2">
                  {explorePlaces.map((place) => {
                    const medal = place.rank === 1 ? '🥇' : place.rank === 2 ? '🥈' : place.rank === 3 ? '🥉' : null
                    const scoreOutOf100 = (place.averageScore / 2).toFixed(1)
                    return (
                      <button
                        type="button"
                        key={place.placeName}
                        className="explore-place-card"
                        onClick={() => void openExplorePlaceRatings(place.placeName)}
                      >
                        <div className="explore-place-rank" aria-hidden="true">
                          {medal ? (
                            <span className="explore-place-medal">{medal}</span>
                          ) : (
                            <span className={`explore-place-rank-num${place.rank >= 100 ? ' is-long' : ''}`}>#{place.rank}</span>
                          )}
                        </div>
                        <div className="explore-place-main">
                          <div className="explore-place-name">{place.placeName}</div>
                          <div className="explore-place-meta">
                            {place.entryCount} {place.entryCount === 1 ? 'sip logged' : 'sips logged'}
                          </div>
                        </div>
                        <div className="explore-place-score">
                          <span className="explore-place-score-value">{scoreOutOf100}</span>
                          <span className="explore-place-score-suffix">/100</span>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </section>
          )}

          {exploreActiveTab === 'users' && (
            <section>
              <div className="explore-places-subtitle-wrapper mb-3">
                <p className="explore-places-subtitle">
                  <span className="explore-places-badge">Leaderboard</span>
                  <span className="explore-places-tag">every sipper, ranked</span>
                </p>
              </div>

              {exploreUsers.length === 0 && <div className="alert alert-light border mb-0 text-center">No user place data yet.</div>}

              {exploreUsers.length > 0 && (
                <div className="d-flex flex-column gap-2">
                  {exploreUsers.map((user, index) => {
                    const rank = index + 1
                    const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : null
                    const isSelf = user.userName.toLowerCase() === (currentUserName || '').toLowerCase()
                    const isFollowing = followingSet.has(user.userName)
                    return (
                      <article
                        key={`${user.userName}-${index}`}
                        className="explore-user-card explore-user-card--ranked"
                        role="button"
                        tabIndex={0}
                        onClick={() => void openFriendModal(user.userName)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            void openFriendModal(user.userName)
                          }
                        }}
                      >
                        <div className="explore-place-rank" aria-hidden="true">
                          {medal ? (
                            <span className="explore-place-medal">{medal}</span>
                          ) : (
                            <span className={`explore-place-rank-num${rank >= 100 ? ' is-long' : ''}`}>#{rank}</span>
                          )}
                        </div>
                        <div className="explore-place-main">
                          <div className="explore-place-name">
                            <span className="explore-user-link">{user.userName}</span>
                            {isSelf && <span className="explore-user-you-badge">you</span>}
                          </div>
                          <div className="explore-place-meta">
                            {user.placeCount} {user.placeCount === 1 ? 'place explored' : 'places explored'}
                          </div>
                        </div>
                        <div className="explore-user-actions">
                          {!isSelf && (
                            <button
                              type="button"
                              className={`explore-follow-btn ${isFollowing ? 'is-following' : ''}`}
                              onClick={async (event) => {
                                event.stopPropagation()
                                try {
                                  if (isFollowing) {
                                    await apiFetch(`/follows/${user.userName}`, { method: 'DELETE' })
                                    followingSet.delete(user.userName)
                                    setSavedEntryToast({ headline: 'Unfollowed', connector: ' ', highlight: user.userName })
                                  } else {
                                    await apiFetch(`/follows/${user.userName}`, { method: 'POST' })
                                    followingSet.add(user.userName)
                                    setSavedEntryToast({ headline: 'Now following', connector: ' ', highlight: user.userName })
                                  }
                                  window.setTimeout(() => setSavedEntryToast(null), 3500)
                                  setFollowingSet(new Set(followingSet))
                                } catch (error) {
                                  console.error('Failed to update follow status:', error)
                                  const msg = error instanceof Error ? error.message : ''
                                  if (/your account not found/i.test(msg)) {
                                    alert('Your session is out of date. Please sign out and sign back in to refresh your account, then try again.')
                                  } else {
                                    alert(msg || 'Failed to update follow status')
                                  }
                                }
                              }}
                              title={isFollowing ? 'Unfollow' : 'Follow'}
                            >
                              {isFollowing ? '✓ Following' : '+ Follow'}
                            </button>
                          )}
                        </div>
                      </article>
                    )
                  })}
                </div>
              )}
            </section>
          )}
        </div>
      </section>
    </main>
  )
}
