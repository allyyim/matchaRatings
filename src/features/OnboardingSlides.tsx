import { createPortal } from 'react-dom'

// 6-slide onboarding modal shown on first launch.
// Extracted from App.tsx and lazy-loaded via React.lazy — only downloaded
// when the user actually needs to see onboarding (once, ever, per install).

export type OnboardingSlidesProps = {
  currentSlide: number
  setCurrentSlide: (slide: number) => void
  onClose: () => void
}

export default function OnboardingSlides({ currentSlide, setCurrentSlide, onClose }: OnboardingSlidesProps) {
  return createPortal(
    <div className="onboarding-overlay">
      <div className="onboarding-modal" onClick={(e) => e.stopPropagation()}>
        <div className="onboarding-slides">
          {currentSlide === 0 && (
            <div className="onboarding-slide">
              <div className="onboarding-emoji">🍵</div>
              <h2 className="onboarding-title">Welcome to Sip &amp; Score</h2>
              <p className="onboarding-lead">Rate every matcha you try. Watch your map fill in.</p>
              <ul className="onboarding-list">
                <li><span className="onboarding-bullet">•</span> Log a sip in seconds</li>
                <li><span className="onboarding-bullet">•</span> Follow other sippers</li>
                <li><span className="onboarding-bullet">•</span> Climb your personal leaderboard</li>
              </ul>
            </div>
          )}
          {currentSlide === 1 && (
            <div className="onboarding-slide">
              <div className="onboarding-emoji">📝</div>
              <h2 className="onboarding-title">Logging a sip</h2>
              <p className="onboarding-lead">Tap <strong className="text-success">+</strong> on the My Log tab.</p>
              <ul className="onboarding-list">
                <li><span className="onboarding-bullet">1.</span> Snap or upload a photo — we auto-score the greenness</li>
                <li><span className="onboarding-bullet">2.</span> Give it stars &amp; pick flavor chips</li>
                <li><span className="onboarding-bullet">3.</span> Save — your Sip Score is calculated for you</li>
              </ul>
            </div>
          )}
          {currentSlide === 2 && (
            <div className="onboarding-slide">
              <div className="onboarding-emoji">✨</div>
              <h2 className="onboarding-title">What&apos;s a Sip Score?</h2>
              <p className="onboarding-lead">One number out of 100 — how it <em>tasted</em> plus how <em>green</em> it looked.</p>
              <ul className="onboarding-list">
                <li><span className="onboarding-bullet">🟢</span> <strong>85+</strong> — a stunner</li>
                <li><span className="onboarding-bullet">🟢</span> <strong>70–84</strong> — solid sip</li>
                <li><span className="onboarding-bullet">🟡</span> <strong>Below 70</strong> — noted</li>
              </ul>
            </div>
          )}
          {currentSlide === 3 && (
            <div className="onboarding-slide">
              <div className="onboarding-emoji">📬</div>
              <h2 className="onboarding-title">Your Feed</h2>
              <p className="onboarding-lead">The <strong className="text-success">Feed</strong> tab is your matcha newsfeed.</p>
              <ul className="onboarding-list">
                <li><span className="onboarding-bullet">🏆</span> Milestones you&apos;ve hit — with dates</li>
                <li><span className="onboarding-bullet">👥</span> Fresh sips from people you follow</li>
                <li><span className="onboarding-bullet">🌟</span> New places picked for your palate</li>
              </ul>
            </div>
          )}
          {currentSlide === 4 && (
            <div className="onboarding-slide">
              <div className="onboarding-emoji">🌍</div>
              <h2 className="onboarding-title">Explore &amp; Leaderboard</h2>
              <p className="onboarding-lead">Find your people. Find your places.</p>
              <ul className="onboarding-list">
                <li><span className="onboarding-bullet">🔍</span> <strong>Explore</strong> — search users, browse recs</li>
                <li><span className="onboarding-bullet">🏆</span> <strong>Leaderboard</strong> — top 10 places &amp; every sipper ranked</li>
                <li><span className="onboarding-bullet">👉</span> Tap any card to peek their reviews or Follow</li>
              </ul>
            </div>
          )}
          {currentSlide === 5 && (
            <div className="onboarding-slide">
              <div className="onboarding-emoji">🎉</div>
              <h2 className="onboarding-title">You&apos;re all set</h2>
              <p className="onboarding-lead">Log your favorite spot first — the first sip unlocks a little celebration 🎊</p>
              <ul className="onboarding-list">
                <li><span className="onboarding-bullet">👤</span> Profile icon (top-right) — flavors, ideal shade &amp; FAQ</li>
                <li><span className="onboarding-bullet">🎯</span> Pick a favorite matcha shade to sharpen your recs</li>
                <li><span className="onboarding-bullet">📱</span> Add to home screen for the full app feel</li>
              </ul>
            </div>
          )}
        </div>

        <div className="onboarding-progress" aria-live="polite">
          <span className="onboarding-progress-label">Slide {currentSlide + 1} of 6</span>
          <div className="onboarding-dots" role="tablist" aria-label="Onboarding progress">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <button
                key={i}
                role="tab"
                aria-selected={i === currentSlide}
                className={`onboarding-dot ${i === currentSlide ? 'active' : ''} ${i < currentSlide ? 'complete' : ''}`}
                onClick={() => setCurrentSlide(i)}
                aria-label={`Go to slide ${i + 1} of 6`}
              />
            ))}
          </div>
        </div>

        <div className="onboarding-nav">
          <button
            className="btn btn-outline-secondary"
            onClick={() => setCurrentSlide(currentSlide - 1)}
            disabled={currentSlide === 0}
          >
            ← Back
          </button>
          <button
            className="btn btn-link text-muted p-0"
            onClick={onClose}
          >
            Skip
          </button>
          {currentSlide === 5 ? (
            <button
              className="btn btn-success"
              onClick={onClose}
            >
              Let&apos;s sip 🍵
            </button>
          ) : (
            <button
              className="btn btn-success"
              onClick={() => setCurrentSlide(currentSlide + 1)}
            >
              Next →
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
