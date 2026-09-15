// Session parsing + ownership middleware. Bearer-token in the
// Authorization header decodes to { userName, browserId } via JWT.
// Any route that mutates a user's data should require ownership so a
// stolen/leaked token can only affect its own account.

import { verifyToken } from './crypto.js'

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7

export function getSessionFromRequest(req) {
  const authorization = String(req.headers.authorization || '')
  const match = authorization.match(/^Bearer\s+(.+)$/i)
  const token = match ? match[1].trim() : ''
  if (!token) return null

  try {
    const payload = verifyToken(token)
    if (!payload || typeof payload !== 'object') return null

    const userName = String(payload.userName || '').trim()
    const browserId = String(payload.browserId || '').trim()
    if (!userName) return null

    return {
      userName,
      browserId,
      expiresAt: Date.now() + SESSION_TTL_MS,
      token
    }
  } catch {
    return null
  }
}

export function requireSession(req, res, next) {
  const session = getSessionFromRequest(req)
  if (!session) {
    return res.status(401).json({ error: 'Authentication required' })
  }

  req.session = session
  return next()
}

export function requireUserOwnership(req, res, next) {
  const sessionUser = String(req.session?.userName || '').trim()
  const candidate = String(req.body?.userName || req.query?.userName || '').trim()

  if (!sessionUser) {
    return res.status(401).json({ error: 'Invalid session' })
  }

  if (!candidate) {
    return res.status(400).json({ error: 'userName is required' })
  }

  if (sessionUser.toLowerCase() !== candidate.toLowerCase()) {
    return res.status(403).json({ error: 'Forbidden: user ownership mismatch' })
  }

  return next()
}
