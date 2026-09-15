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
//   - Everything else ⇒ show a small recovery card with a Reload button,
//     which is way better UX than a blank screen and gives the user a
//     way out without needing to know how to force-refresh a PWA.

type Props = { children: ReactNode }
type State = { error: Error | null }

const RELOAD_SENTINEL = 'matcha:chunkReloadedAt'

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

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('App error boundary caught:', error, info.componentStack)

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
      </div>
    )
  }
}
