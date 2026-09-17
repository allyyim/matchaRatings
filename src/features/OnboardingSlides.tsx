import { createPortal } from 'react-dom'

// 3-slide onboarding modal shown on first launch.
// Reduced from 6 slides — most drop-off in short onboardings happens
// after slide 3 (Amplitude / Mixpanel benchmarks). Feed / Explore /
// Leaderboard don't need pre-teaching; the tab bar and the on-home
// OnboardingChecklist card cover discovery post-signup.

export type OnboardingSlidesProps = {
  currentSlide: number
  setCurrentSlide: (slide: number) => void
  onClose: () => void
}

const TOTAL_SLIDES = 3

// Illustrated slide art — pre-flattened to a pure-white background so the
// PNGs seamlessly blend into the modal without a visible seam.
const CUP_IMG = `${import.meta.env.BASE_URL}onboarding/cup.png`
const BOWL_IMG = `${import.meta.env.BASE_URL}onboarding/bowl.png`

export default function OnboardingSlides({ currentSlide, setCurrentSlide, onClose }: OnboardingSlidesProps) {
  // Clamp so a stale index from the reduced-slide-count migration can
  // never leave the user on a blank slide.
  const safeSlide = Math.min(Math.max(currentSlide, 0), TOTAL_SLIDES - 1)

  return createPortal(
    <div className="onboarding-overlay">
      <div className="onboarding-modal" onClick={(e) => e.stopPropagation()}>
        <div className="onboarding-slides">
          {safeSlide === 0 && (
            <div className="onboarding-slide">
              <img className="onboarding-image" src={CUP_IMG} alt="" aria-hidden="true" />
              <h2 className="onboarding-title">Welcome to Sip &amp; Score</h2>
              <p className="onboarding-lead">Rate every matcha you try. Watch your map fill in.</p>
              <ul className="onboarding-list">
                <li>Log a sip in seconds</li>
                <li>Follow other sippers</li>
                <li>Climb your personal leaderboard</li>
              </ul>
            </div>
          )}
          {safeSlide === 1 && (
            <div className="onboarding-slide">
              <img className="onboarding-image" src={BOWL_IMG} alt="" aria-hidden="true" />
              <h2 className="onboarding-title">How Sip Score works</h2>
              <p className="onboarding-lead">One number out of 100 — how it tasted plus how green it looked.</p>
              <ul className="onboarding-list">
                <li><strong>85+</strong> a stunner</li>
                <li><strong>70&ndash;84</strong> solid sip</li>
                <li><strong>Below 70</strong> noted</li>
              </ul>
            </div>
          )}
          {safeSlide === 2 && (
            <div className="onboarding-slide">
              <img className="onboarding-image" src={CUP_IMG} alt="" aria-hidden="true" />
              <h2 className="onboarding-title">You&apos;re all set</h2>
              <p className="onboarding-lead">Log your favourite spot first &mdash; a small celebration is waiting.</p>
              <ul className="onboarding-list">
                <li>Tap <strong className="text-success">+</strong> on My Log to rate a sip</li>
                <li>Set your flavor prefs to unlock a palate archetype</li>
                <li>Add to home screen for the full app feel</li>
              </ul>
            </div>
          )}
        </div>

        <div className="onboarding-progress" aria-live="polite">
          <span className="onboarding-progress-label visually-hidden">Slide {safeSlide + 1} of {TOTAL_SLIDES}</span>
          <div className="onboarding-dots" role="tablist" aria-label="Onboarding progress">
            {Array.from({ length: TOTAL_SLIDES }, (_, i) => (
              <button
                key={i}
                role="tab"
                aria-selected={i === safeSlide}
                className={`onboarding-dot ${i === safeSlide ? 'active' : ''} ${i < safeSlide ? 'complete' : ''}`}
                onClick={() => setCurrentSlide(i)}
                aria-label={`Go to slide ${i + 1} of ${TOTAL_SLIDES}`}
              />
            ))}
          </div>
        </div>

        <div className="onboarding-nav">
          <button
            className="btn btn-outline-secondary"
            onClick={() => setCurrentSlide(safeSlide - 1)}
            disabled={safeSlide === 0}
          >
            &larr; Back
          </button>
          <button
            className="btn btn-link text-muted p-0"
            onClick={onClose}
          >
            Skip
          </button>
          {safeSlide === TOTAL_SLIDES - 1 ? (
            <button
              className="btn btn-success"
              onClick={onClose}
            >
              Let&apos;s sip
            </button>
          ) : (
            <button
              className="btn btn-success"
              onClick={() => setCurrentSlide(safeSlide + 1)}
            >
              Next &rarr;
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
