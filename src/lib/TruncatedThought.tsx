import { useState } from 'react'

// A single truncated thought/notes block used in both the Feed feed items
// and the "own log" / friend / place entry cards in App.tsx. Same logic —
// only the outer wrapper element and its CSS classname differ per surface.
export function TruncatedThought({
  text,
  as,
  className,
  charLimit = 140,
  quote = false,
  stopPropagation = false,
}: {
  text: string
  as: 'p' | 'div'
  className: string
  charLimit?: number
  // Feed items wrap the text in quotes; entry cards do not.
  quote?: boolean
  // Entry cards live inside clickable rows and must swallow the toggle's
  // click so the parent doesn't open a modal underneath.
  stopPropagation?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const trimmed = (text || '').trim()
  const Wrapper = as as 'p' | 'div'

  const render = (body: string) => (quote ? `"${body}"` : body)

  if (trimmed.length <= charLimit) {
    return <Wrapper className={className}>{render(trimmed)}</Wrapper>
  }

  // Word-boundary truncation: cut at the last space before charLimit so we
  // don't split mid-word. Below 60 chars fall back to a hard cut.
  const slice = trimmed.slice(0, charLimit)
  const lastSpace = slice.lastIndexOf(' ')
  const preview = (lastSpace > 60 ? slice.slice(0, lastSpace) : slice).replace(/[,\s]+$/, '')
  const shown = expanded ? trimmed : `${preview}…`

  return (
    <Wrapper className={className}>
      {render(shown)}
      {' '}
      <button
        type="button"
        className="feed-see-more"
        onClick={(e) => {
          if (stopPropagation) e.stopPropagation()
          setExpanded((v) => !v)
        }}
      >
        {expanded ? 'See less' : 'See more'}
      </button>
    </Wrapper>
  )
}
