import { Component, type ErrorInfo, type ReactNode } from 'react'

// Top-level safety net. Without this, any render-time throw — including
// `React.lazy()` chunk-load rejections from a stale service worker after
// a deploy, or a flaky mobile fetch mid-tab-switch — unmounts the whole
// tree and shows a blank white PWA. That was the "click another tab and
// the app blanks out" symptom.
//
// Recovery strategy:
//   - Chunk-load failures ⇒ clear the SW + caches and hard-reload once,
//     because the old hashed asset URL is guaranteed to keep 404-ing on
//     origin. We use sessionStorage to guarantee we only try this once
//     per session so we can't get stuck in a reload loop.
//   - Everything else ⇒ show a small recovery card with a Reload button
//     AND a "copy error details" button. The details capture message +
//     stack + component stack + URL + timestamp, which is enough for
//     the user to paste into a bug report (or for us to reproduce
//     even if Sentry is misconfigured / rate-limited / offline).

type Props = { children: ReactNode }
type State = { error: Error | null; info: ErrorInfo | null; copied: boolean }

const RELOAD_SENTINEL = 'matcha:chunkReloadedAt'
const LAST_ERROR_KEY = 'matcha:lastError'

function isChunkLoadError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const message = String((err as { message?: unknown }).message || '')
  const name = String((err as { name?: unknown }).name || '')
  return (
    name === 'ChunkLoadError' ||
    /Loading chunk [\w-]+ failed/i.test(message) ||
    /Failed to fetch dynamically imported module/i.test(message) ||
    /Importing a module script failed/i.test(message)
  )
}

async function hardReload(): Promise<void> {
  try {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations()
      await Promise.all(registrations.map((r) => r.unregister().catch(() => undefined)))
    }
  } catch { /* ignore */ }
  try {
    if ('caches' in window) {
      const keys = await caches.keys()
      await Promise.all(keys.map((k) => caches.delete(k).catch(() => undefined)))
    }
  } catch { /* ignore */ }
  window.location.reload()
}

function buildErrorReport(error: Error, info: ErrorInfo | null): string {
  const lines = [
    `Sip & Score error report`,
    `When: ${new Date().toISOString()}`,
    `URL: ${typeof window !== 'undefined' ? window.location.href : '(no window)'}`,
    `UA: ${typeof navigator !== 'undefined' ? navigator.userAgent : '(no navigator)'}`,
    ``,
    `Error: ${error.name}: ${error.message}`,
    ``,
    `Stack:`,
    error.stack || '(no stack)',
  ]
  if (info?.componentStack) {
    lines.push('', 'Component stack:', info.componentStack)
  }
  return lines.join('\n')
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null, copied: false }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('App error boundary caught:', error, info.componentStack)
    this.setState({ info })

    // Persist the last error so support can retrieve it out-of-band
    // (e.g. via DevTools localStorage) even if Sentry never delivered.
    try {
      localStorage.setItem(LAST_ERROR_KEY, buildErrorReport(error, info))
    } catch { /* ignore quota / privacy-mode errors */ }

    if (isChunkLoadError(error)) {
      // Only auto-reload once per browser session so a genuinely broken
      // deploy doesn't infinite-loop the user.
      let alreadyReloaded = false
      try {
        alreadyReloaded = sessionStorage.getItem(RELOAD_SENTINEL) === '1'
      } catch { /* ignore */ }
      if (!alreadyReloaded) {
        try { sessionStorage.setItem(RELOAD_SENTINEL, '1') } catch { /* ignore */ }
        void hardReload()
      }
    }
  }

  handleReload = (): void => {
    try { sessionStorage.removeItem(RELOAD_SENTINEL) } catch { /* ignore */ }
    void hardReload()
  }

  handleCopyDetails = async (): Promise<void> => {
    if (!this.state.error) return
    const report = buildErrorReport(this.state.error, this.state.info)
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(report)
      } else {
        // Fallback for browsers without Clipboard API (older Safari, etc.)
        const ta = document.createElement('textarea')
        ta.value = report
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      this.setState({ copied: true })
      window.setTimeout(() => this.setState({ copied: false }), 2000)
    } catch { /* ignore */ }
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children

    // Chunk errors trigger an auto-reload above, so this UI mostly shows
    // for the split second before the reload fires (or, if the reload
    // already happened once this session, as the manual fallback).
    return (
      <div
        role="alert"
        style={{
          minHeight: '100dvh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem',
          textAlign: 'center',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          color: '#2f4a34',
          background: '#f4faf1',
        }}
      >
        <div style={{ fontSize: '2.5rem', marginBottom: '1rem' }}>🍵</div>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: '0.5rem' }}>
          Something went sideways
        </h1>
        <p style={{ maxWidth: 320, marginBottom: '1.5rem', color: '#4c6b52' }}>
          The app hit an error. Reloading usually fixes it.
        </p>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'center' }}>
          <button
            type="button"
            onClick={this.handleReload}
            style={{
              background: '#2f7a44',
              color: 'white',
              border: 0,
              borderRadius: 999,
              padding: '0.75rem 1.5rem',
              fontWeight: 600,
              fontSize: '1rem',
              cursor: 'pointer',
            }}
          >
            Reload app
          </button>
          <button
            type="button"
            onClick={() => void this.handleCopyDetails()}
            style={{
              background: 'transparent',
              color: '#2f7a44',
              border: '1px solid #2f7a44',
              borderRadius: 999,
              padding: '0.75rem 1.5rem',
              fontWeight: 600,
              fontSize: '1rem',
              cursor: 'pointer',
            }}
          >
            {this.state.copied ? 'Copied ✓' : 'Copy error details'}
          </button>
        </div>
        <p style={{ marginTop: '1.25rem', fontSize: '0.75rem', color: '#7a8e7f', maxWidth: 320 }}>
          Copying the details makes it easy to paste them into a bug report.
        </p>
      </div>
    )
  }
}
