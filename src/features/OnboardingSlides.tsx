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
const TEAPOT_IMG = `${import.meta.env.BASE_URL}onboarding/teapot.png`

// Thin outline glyphs — kept as inline SVGs (no icon library dependency)
// so the onboarding chunk stays small and each icon can be recolored by
// currentColor in one place if the palette ever shifts.
const IconStroke = { strokeWidth: 1.75, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none', stroke: 'currentColor' }

const IconClock = () => (
  <svg className="onboarding-icon" viewBox="0 0 24 24" {...IconStroke} aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
)
const IconUsers = () => (
  <svg className="onboarding-icon" viewBox="0 0 24 24" {...IconStroke} aria-hidden="true"><circle cx="9" cy="8" r="3.2" /><path d="M2.5 20c.8-3.3 3.4-5 6.5-5s5.7 1.7 6.5 5" /><circle cx="17" cy="7.5" r="2.6" /><path d="M15.8 14.4c2.8.2 4.7 1.9 5.7 5.6" /></svg>
)
const IconTrophy = () => (
  <svg className="onboarding-icon" viewBox="0 0 24 24" {...IconStroke} aria-hidden="true"><path d="M8 4h8v5a4 4 0 0 1-8 0V4z" /><path d="M8 6H5v2a3 3 0 0 0 3 3" /><path d="M16 6h3v2a3 3 0 0 1-3 3" /><path d="M10 15h4v3h-4z" /><path d="M8 20h8" /></svg>
)
const IconPlusCircle = () => (
  <svg className="onboarding-icon" viewBox="0 0 24 24" {...IconStroke} aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></svg>
)
const IconSparkles = () => (
  <svg className="onboarding-icon" viewBox="0 0 24 24" {...IconStroke} aria-hidden="true"><path d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6z" /><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" /></svg>
)
const IconPhone = () => (
  <svg className="onboarding-icon" viewBox="0 0 24 24" {...IconStroke} aria-hidden="true"><rect x="7" y="3" width="10" height="18" rx="2.2" /><path d="M11 18h2" /></svg>
)

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
              <img className="onboarding-image" src={TEAPOT_IMG} alt="" aria-hidden="true" />
              <h2 className="onboarding-title">Welcome to Sip &amp; Score</h2>
              <p className="onboarding-lead">Rate every matcha you try. Watch your map fill in.</p>
              <ul className="onboarding-list onboarding-list--icons">
                <li><IconClock /><span>Log a sip in seconds</span></li>
                <li><IconUsers /><span>Follow other sippers</span></li>
                <li><IconTrophy /><span>Climb your personal leaderboard</span></li>
              </ul>
            </div>
          )}
          {safeSlide === 1 && (
            <div className="onboarding-slide">
              <img className="onboarding-image onboarding-image--lg" src={BOWL_IMG} alt="" aria-hidden="true" />
              <h2 className="onboarding-title">How Sip Score works</h2>
              <p className="onboarding-lead">One number out of 100 — how it tasted plus how green it looked.</p>
              <ul className="onboarding-list onboarding-list--scores">
                <li><span className="score-badge score-badge--green">85+</span><span>a stunner</span></li>
                <li><span className="score-badge score-badge--yellow">70&ndash;84</span><span>solid sip</span></li>
                <li><span className="score-badge score-badge--red">&lt;70</span><span>noted</span></li>
              </ul>
            </div>
          )}
          {safeSlide === 2 && (
            <div className="onboarding-slide">
              <img className="onboarding-image" src={CUP_IMG} alt="" aria-hidden="true" />
              <h2 className="onboarding-title">You&apos;re all set</h2>
              <p className="onboarding-lead">Log your favourite spot first &mdash; a small celebration is waiting.</p>
              <ul className="onboarding-list onboarding-list--icons">
                <li><IconPlusCircle /><span>Tap <strong className="text-success">+</strong> on My Log to rate a sip</span></li>
                <li><IconSparkles /><span>Set your flavor prefs to unlock <strong>For You</strong> matches</span></li>
                <li><IconPhone /><span>Add to home screen for the full app feel</span></li>
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
          {safeSlide > 0 ? (
            <button
              className="btn btn-outline-secondary"
              onClick={(e) => {
                e.currentTarget.blur()
                setCurrentSlide(safeSlide - 1)
              }}
            >
              &larr; Back
            </button>
          ) : (
            /* Placeholder keeps Skip centered and Next/Let's sip parked
               right on slide 0 where there's nothing to go back to. */
            <span aria-hidden="true" />
          )}
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
              onClick={(e) => {
                e.currentTarget.blur()
                setCurrentSlide(safeSlide + 1)
              }}
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
