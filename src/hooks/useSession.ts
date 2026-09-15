import { useCallback, useState } from 'react'
import { getSessionToken, setSessionToken } from '../lib/api'

// Narrow session slice: owns the three fields every login/logout path in
// App.tsx used to write in the same order (session token, current user
// name, isUserReady) plus the anonymous browserId used for account merges.
//
// Deliberately scoped tight — the Google OAuth flow, multi-account
// confirmation, demo cleanup dispatch, and welcome-toast handling all
// stay in App.tsx and just call signIn/signOut for the shared 3-write
// bookkeeping. That keeps risk low for the 7 login entry points we're
// consolidating without pulling in the full auth surface.

function getSafeRandomUuid(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch { /* ignore */ }
  return `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function readBrowserId(): string {
  const existing = localStorage.getItem('matchaBrowserId')
  if (existing) return existing
  const generated = getSafeRandomUuid()
  localStorage.setItem('matchaBrowserId', generated)
  return generated
}

export type SignInArgs = {
  userName: string
  // Pass a string to update the stored token, '' to clear, undefined to
  // leave whatever's already in localStorage (session-restore path).
  token?: string
  // Default true. Skip when the caller has already written matchaUserName
  // themselves or is restoring an existing localStorage value.
  persistUserName?: boolean
}

export type SessionApi = {
  currentUserName: string
  isUserReady: boolean
  browserId: string
  setCurrentUserName: (name: string) => void
  setIsUserReady: (ready: boolean) => void
  signIn: (args: SignInArgs) => void
  signOut: () => void
  getSessionToken: () => string
  setSessionToken: (token: string) => void
}

export function useSession(): SessionApi {
  const [browserId] = useState(() => readBrowserId())
  const [currentUserName, setCurrentUserName] = useState('')
  const [isUserReady, setIsUserReady] = useState(false)

  const signIn = useCallback(({ userName, token, persistUserName = true }: SignInArgs) => {
    if (token !== undefined) {
      setSessionToken(token || '')
    }
    if (persistUserName && userName) {
      try { localStorage.setItem('matchaUserName', userName) } catch { /* ignore */ }
    }
    setCurrentUserName(userName)
    setIsUserReady(true)
  }, [])

  const signOut = useCallback(() => {
    setSessionToken('')
    try { localStorage.removeItem('matchaUserName') } catch { /* ignore */ }
    setCurrentUserName('')
    setIsUserReady(false)
  }, [])

  return {
    currentUserName,
    isUserReady,
    browserId,
    setCurrentUserName,
    setIsUserReady,
    signIn,
    signOut,
    getSessionToken,
    setSessionToken,
  }
}
