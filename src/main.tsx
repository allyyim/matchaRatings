import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { GoogleOAuthProvider } from '@react-oauth/google'
import 'bootstrap/dist/css/bootstrap.min.css'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './lib/ErrorBoundary'

const GOOGLE_CLIENT_ID = '867236569193-a6aavvtflvbsa96cc2odjm9rmijr1imc.apps.googleusercontent.com'

// Block pinch-to-zoom on iOS Safari. Apple ignores the viewport meta
// `user-scalable=no` directive as an accessibility policy, so we have
// to actively cancel the gesture events. Without this the visual
// viewport shrinks the page and the fixed bottom nav appears to
// float / jump because it's positioned against the layout viewport,
// not the visual one.
;(() => {
  const cancel = (e: Event) => { e.preventDefault() }
  // iOS Safari specific — fires when a second finger touches down.
  document.addEventListener('gesturestart', cancel, { passive: false })
  document.addEventListener('gesturechange', cancel, { passive: false })
  document.addEventListener('gestureend', cancel, { passive: false })
  // Multi-touch pinch on other engines. touch-action:pan-x pan-y in
  // index.css handles Chrome/Android, this is the belt-and-braces guard.
  document.addEventListener('touchmove', (e: TouchEvent) => {
    if (e.touches.length > 1) e.preventDefault()
  }, { passive: false })
  // Double-tap zoom prevention on iOS — cancel the second tap in a
  // 300ms window. Won't interfere with normal clicks / react handlers.
  let lastTouchEnd = 0
  document.addEventListener('touchend', (e: TouchEvent) => {
    const now = Date.now()
    if (now - lastTouchEnd <= 300) e.preventDefault()
    lastTouchEnd = now
  }, { passive: false })
})()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
        <App />
      </GoogleOAuthProvider>
    </ErrorBoundary>
  </StrictMode>,
)
