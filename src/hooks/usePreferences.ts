import { useEffect, useState, useCallback } from 'react'
import { apiFetch } from '../lib/api'
import { readCache, writeCache } from '../lib/cache'

// User-preferences slice. Owns the three "how I like my matcha" fields that
// drive Recs + Explore filtering + the Save Preferences modal. Extracted
// from App.tsx so per-tab components can grab just what they need.
//
// Persistence model:
//   - flavors: plain strings ('umami', 'nutty', etc.) — server-side cache
//     also under readCache/writeCache(currentUserName, 'flavors') so an
//     offline reopen keeps the last-known-good picks.
//   - body: '' | 'full-bodied' | 'medium' | 'milky' — mirrored to
//     localStorage['matchaBodyPref'] for a synchronous cold-start read.
//   - shade: 0 (no pref) or integer 1-9 — mirrored to
//     localStorage['matchaShadePref'] for the same reason.
//
// Server wire format packs body + shade into the same flavors[] array as
// virtual tags ('__body:medium', '__shade:5') so the /preferences endpoint
// stays a single flat list.

export type BodyPref = '' | 'full-bodied' | 'medium' | 'milky'

export type PreferencesApi = {
  userFlavors: string[]
  setUserFlavors: (flavors: string[]) => void
  userBodyPref: BodyPref
  setUserBodyPref: (body: BodyPref) => void
  userShade: number
  setUserShade: (shade: number) => void
  savePreferences: () => Promise<void>
}

type Deps = {
  currentUserName: string
  isUserReady: boolean
  // Bump to force a reload — e.g. when the preferences modal opens so a
  // second device's edits show up immediately.
  reloadKey?: number
  // Called after a successful save so parent can bump their recs cache key.
  onSaved?: () => void
}

function readInitialBody(): BodyPref {
  try {
    const v = localStorage.getItem('matchaBodyPref')
    if (v === 'full-bodied' || v === 'medium' || v === 'milky') return v
  } catch { /* ignore */ }
  return ''
}

function readInitialShade(): number {
  try {
    const v = Number(localStorage.getItem('matchaShadePref'))
    if (Number.isInteger(v) && v >= 1 && v <= 9) return v
  } catch { /* ignore */ }
  return 0
}

export function usePreferences(deps: Deps): PreferencesApi {
  const { currentUserName, isUserReady, reloadKey, onSaved } = deps

  const [userFlavors, setUserFlavors] = useState<string[]>([])
  const [userBodyPref, setUserBodyPref] = useState<BodyPref>(readInitialBody)
  const [userShade, setUserShade] = useState<number>(readInitialShade)

  // Server-truth load on user ready + on explicit reload requests.
  useEffect(() => {
    if (!isUserReady || !currentUserName) return

    // Hydrate from cache first so preferences stick across offline/data
    // switches even if the server fetch fails or returns empty on a
    // brand-new session.
    const cachedFlavors = readCache<string[]>(currentUserName, 'flavors')
    if (cachedFlavors && Array.isArray(cachedFlavors) && cachedFlavors.length > 0) {
      setUserFlavors(cachedFlavors)
    }

    let cancelled = false
    async function loadUserPreferences() {
      try {
        const data = await apiFetch<{ flavors?: string[] }>('/preferences')
        if (cancelled) return
        if (data?.flavors && Array.isArray(data.flavors)) {
          const bodyEntry = data.flavors.find((f) => typeof f === 'string' && f.startsWith('__body:'))
          const shadeEntry = data.flavors.find((f) => typeof f === 'string' && f.startsWith('__shade:'))
          const cleanFlavors = data.flavors.filter((f) => typeof f === 'string' && !f.startsWith('__'))
          setUserFlavors(cleanFlavors)
          writeCache(currentUserName, 'flavors', cleanFlavors)
          if (bodyEntry) {
            const b = bodyEntry.slice('__body:'.length)
            if (b === 'full-bodied' || b === 'medium' || b === 'milky') {
              setUserBodyPref(b)
              try { localStorage.setItem('matchaBodyPref', b) } catch { /* ignore */ }
            }
          }
          if (shadeEntry) {
            const s = Number(shadeEntry.slice('__shade:'.length))
            if (Number.isInteger(s) && s >= 1 && s <= 9) {
              setUserShade(s)
              try { localStorage.setItem('matchaShadePref', String(s)) } catch { /* ignore */ }
            }
          }
        }
      } catch (error) {
        console.error('Failed to load user preferences (keeping cached copy):', error)
      }
    }

    loadUserPreferences()
    return () => { cancelled = true }
  }, [isUserReady, currentUserName, reloadKey])

  const savePreferences = useCallback(async () => {
    try {
      if (userBodyPref) {
        localStorage.setItem('matchaBodyPref', userBodyPref)
      } else {
        localStorage.removeItem('matchaBodyPref')
      }
      if (userShade >= 1 && userShade <= 9) {
        localStorage.setItem('matchaShadePref', String(userShade))
      } else {
        localStorage.removeItem('matchaShadePref')
      }
    } catch { /* ignore */ }

    // Persist locally BEFORE the network call. If the API request fails
    // on a bad connection, we still have the user's picks on-device and
    // can re-sync on next launch.
    writeCache(currentUserName, 'flavors', userFlavors)
    const virtualTags: string[] = []
    if (userBodyPref) virtualTags.push(`__body:${userBodyPref}`)
    if (userShade >= 1 && userShade <= 9) virtualTags.push(`__shade:${userShade}`)
    const flavorsToSave = [...userFlavors, ...virtualTags]

    await apiFetch('/preferences', {
      method: 'POST',
      body: JSON.stringify({ flavors: flavorsToSave })
    })
    onSaved?.()
  }, [currentUserName, userFlavors, userBodyPref, userShade, onSaved])

  return {
    userFlavors,
    setUserFlavors,
    userBodyPref,
    setUserBodyPref,
    userShade,
    setUserShade,
    savePreferences,
  }
}
