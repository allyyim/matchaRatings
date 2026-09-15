// Central fetch helper for every API call from the client. Handles:
// - Building the API base URL (env override / LAN / GH Pages fallback).
// - Attaching the bearer session token, CSRF token, and request headers.
// - A 45s request timeout with AbortController.
// - Uniform ApiError shape with a user-friendly message.

const rawApiBaseUrl = String(import.meta.env.VITE_API_BASE_URL || '/api')

export const API_BASE_URL = (() => {
  if (typeof window === 'undefined') return rawApiBaseUrl

  const host = window.location.hostname
  const isPhoneOrLanClient = host !== 'localhost' && host !== '127.0.0.1'
  const apiPointsToLocalhost = /https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(rawApiBaseUrl)

  // If on GitHub Pages, use Render backend
  if (host.includes('github.io')) {
    return 'https://matcharatings.onrender.com/api'
  }

  // If opened from a phone/LAN host, never call localhost from env config.
  if (isPhoneOrLanClient && apiPointsToLocalhost) {
    return '/api'
  }

  return rawApiBaseUrl
})()

export const API_REQUEST_TIMEOUT_MS = 45000

const SESSION_TOKEN_KEY = 'matchaAuthToken'

export function getSessionToken(): string {
  if (typeof window === 'undefined') return ''
  return window.localStorage.getItem(SESSION_TOKEN_KEY) || ''
}

export function setSessionToken(token: string): void {
  if (typeof window === 'undefined') return
  if (token) {
    window.localStorage.setItem(SESSION_TOKEN_KEY, token)
    return
  }
  window.localStorage.removeItem(SESSION_TOKEN_KEY)
}

export class ApiError extends Error {
  status: number
  data: Record<string, unknown>

  constructor(status: number, data: Record<string, unknown>, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.data = data
  }
}

export function friendlyErrorMessage(status: number): string {
  if (status === 401 || status === 403) return 'Please sign in again to continue.'
  if (status === 404) return 'We couldn\'t find what you were looking for.'
  if (status === 409) return 'That name is already taken. Please choose another.'
  if (status >= 500) return 'Something went wrong on our end. Please try again.'
  return 'Something went wrong. Please try again.'
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  if (typeof window !== 'undefined' && window.location.protocol === 'http:' && !window.location.hostname.match(/^(localhost|127\.0\.0\.1)$/)) {
    console.warn('Warning: Using HTTP in production. Consider using HTTPS.')
  }

  const headers = new Headers(init?.headers || {})
  headers.set('Content-Type', 'application/json')
  headers.set('X-Requested-With', 'XMLHttpRequest')

  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content')
  if (csrfToken) {
    headers.set('X-CSRF-Token', csrfToken)
  }

  const token = getSessionToken()
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), API_REQUEST_TIMEOUT_MS)

  const requestSignal = init?.signal
  const stopAbortListener = () => controller.abort()
  if (requestSignal) {
    if (requestSignal.aborted) {
      controller.abort()
    } else {
      requestSignal.addEventListener('abort', stopAbortListener, { once: true })
    }
  }

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers,
      credentials: 'same-origin',
      signal: controller.signal
    })

    if (!response.ok) {
      const text = await response.text()
      let data: Record<string, unknown> = {}
      let serverMessage = ''
      try {
        const parsed = JSON.parse(text)
        if (parsed && typeof parsed === 'object') {
          data = parsed as Record<string, unknown>
          if (typeof data.error === 'string') {
            serverMessage = data.error
          }
        }
      } catch {
        // Non-JSON body — ignore it; never surface raw HTML/text to the user.
      }

      const isSafeServerMessage =
        !!serverMessage &&
        serverMessage.length <= 200 &&
        !serverMessage.includes('{') &&
        !serverMessage.includes('<')
      const userMessage = isSafeServerMessage ? serverMessage : friendlyErrorMessage(response.status)
      throw new ApiError(response.status, data, userMessage)
    }

    return response.json() as Promise<T>
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('The request timed out or was cancelled.')
    }

    throw error
  } finally {
    window.clearTimeout(timeoutId)
    if (requestSignal) {
      requestSignal.removeEventListener('abort', stopAbortListener)
    }
  }
}
