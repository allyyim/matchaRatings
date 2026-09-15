// Session parsing + ownership middleware. Bearer-token in the
// Authorization header decodes to { userName, browserId } via JWT.
// Any route that mutates a user's data should require ownership so a
// stolen/leaked token can only affect its own account.

import crypto from 'node:crypto'
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

// Admin-secret gate. Every /admin/* endpoint is an ops tool that can
// delete users, rebind emails, or fire batch Cloudinary uploads (each
// with a $ cost). They live BEFORE the /api session gate so an operator
// can call them from a shell without a session token — which means they
// need their own auth. Set ADMIN_SECRET in your Render env; requests
// must send `Authorization: Bearer $ADMIN_SECRET`. In dev, if
// ADMIN_SECRET is unset, admin routes 503 loud instead of silently
// letting anyone through.
export function requireAdminSecret(req, res, next) {
  const configured = String(process.env.ADMIN_SECRET || '').trim()
  if (!configured) {
    return res.status(503).json({ error: 'Admin endpoints disabled: ADMIN_SECRET not configured' })
  }

  const authorization = String(req.headers.authorization || '')
  const match = authorization.match(/^Bearer\s+(.+)$/i)
  const supplied = match ? match[1].trim() : ''

  if (!supplied) {
    return res.status(401).json({ error: 'Admin authentication required' })
  }

  // Constant-time comparison so the response time doesn't leak the
  // secret's prefix on repeated probing.
  const a = Buffer.from(supplied)
  const b = Buffer.from(configured)
  if (a.length !== b.length) {
    return res.status(403).json({ error: 'Admin authentication failed' })
  }
  if (!crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ error: 'Admin authentication failed' })
  }

  return next()
}
