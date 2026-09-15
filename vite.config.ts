import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  base: process.env.GITHUB_ACTIONS === 'true' ? '/matchaRatings/' : '/',
  plugins: [react()],
  server: {
    host: true,
    proxy: {
      '/api': 'http://localhost:4000'
    }
  },
  // Force compile-time substitution of our debug-log guard flag. Vite v8's
  // rolldown pipeline replaces `import.meta.env.DEV` with `true` in prod
  // (surprisingly), so we use an explicit `__DEV__` sentinel that we can
  // reliably control. Wrapped debug logs in App.tsx / greenness.ts use
  // `if (__DEV__) console.log(...)` which then dead-code-eliminates in prod.
  define: {
    __DEV__: JSON.stringify(mode !== 'production'),
  },
  build: {
    // Split React + related runtime into their own long-lived chunk so app
    // code changes don't bust the browser cache for the (rarely-changing)
    // framework. Google OAuth is heavy and only needed on the sign-in
    // surface, so it also gets isolated. Everything else stays in the main
    // app chunk so route-level lazy imports (FeedPage / ExplorePage /
    // OnboardingSlides) continue to work as before.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('react-dom') || id.includes('/react/') || id.includes('scheduler')) {
            return 'react-vendor'
          }
          if (id.includes('@react-oauth/google')) {
            return 'google-oauth'
          }
        }
      }
    }
  }
}))
