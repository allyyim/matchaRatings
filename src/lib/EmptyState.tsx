// Consistent empty-state UI across the app. Every "nothing to show yet"
// surface routes through this so the copy voice + spacing + emoji size
// all match — instead of a mix of Bootstrap `alert` boxes and one-off
// `<p className="text-muted">` blurbs.
//
// Deliberately opinionated: emoji is 2.25rem, headline is bold + colored
// like our success-green primary, subtext is muted small. Compact variant
// (for inside modals + card bodies) trims the vertical padding.

type EmptyStateProps = {
  emoji?: string
  headline: string
  subtext?: string
  compact?: boolean
}

export function EmptyState({ emoji, headline, subtext, compact = false }: EmptyStateProps) {
  return (
    <div
      className={`text-center ${compact ? 'py-3' : 'py-5'}`}
      style={{
        color: '#5d685e',
      }}
    >
      {emoji && (
        <div
          aria-hidden="true"
          style={{
            fontSize: compact ? '1.75rem' : '2.25rem',
            marginBottom: '0.35rem',
            lineHeight: 1,
          }}
        >
          {emoji}
        </div>
      )}
      <div
        style={{
          fontWeight: 600,
          fontSize: compact ? '0.92rem' : '1rem',
          color: '#1f5f34',
          marginBottom: subtext ? '0.35rem' : 0,
          lineHeight: 1.3,
        }}
      >
        {headline}
      </div>
      {subtext && (
        <div className="small" style={{ maxWidth: '32ch', margin: '0 auto', lineHeight: 1.45 }}>
          {subtext}
        </div>
      )}
    </div>
  )
}
