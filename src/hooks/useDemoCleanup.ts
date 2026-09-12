import { useEffect } from 'react'

// Fires the demo-account cleanup endpoint when the recruiter closes the tab,
// switches apps on mobile, or otherwise leaves without hitting Log Out.
//
// Plain fetch() is unreliable during unload (especially iOS Safari), so we
// use sendBeacon which the browser guarantees to deliver even after the
// document is gone. We listen ONLY to pagehide (not visibilitychange) so a
// quick tab switch on mobile doesn't nuke a recruiter's in-flight ratings —
// pagehide fires on actual tab close / navigation away on all modern
// browsers including iOS Safari.
//
// No-op when isDemoAccount is false, so it's safe to always mount.
export function useDemoCleanup(isDemoAccount: boolean, apiBaseUrl: string): void {
  useEffect(() => {
    if (!isDemoAccount) return

    const fireCleanup = () => {
      try {
        const url = `${apiBaseUrl}/auth/demo/cleanup`
        const blob = new Blob([JSON.stringify({})], { type: 'application/json' })
        if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
          navigator.sendBeacon(url, blob)
        } else {
          fetch(url, { method: 'POST', body: blob, keepalive: true }).catch(() => {})
        }
      } catch { /* swallow — cleanup is best-effort */ }
    }

    window.addEventListener('pagehide', fireCleanup)
    return () => {
      window.removeEventListener('pagehide', fireCleanup)
    }
  }, [isDemoAccount, apiBaseUrl])
}
