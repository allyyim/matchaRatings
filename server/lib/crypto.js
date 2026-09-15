// Field-level AES-256-GCM encryption for sensitive text (email, etc.)
// stored in Postgres, plus JWT session-token issuance and one-time
// magic-link hashing.
//
// APP_SECRET drives the encryption key (SHA-256 stretched); JWT_SECRET
// drives session-token signing. Both fall back to APP_SECRET so a
// single env var is enough to spin up dev, but prod deploys should set
// both to distinct high-entropy values.

import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import { safeJsonParse } from './sanitize.js'

const APP_SECRET = process.env.APP_SECRET || 'matcha-development-secret-change-me'
const JWT_SECRET = process.env.JWT_SECRET || APP_SECRET

export function encryptField(value) {
  if (!value) return ''

  const key = crypto.createHash('sha256').update(APP_SECRET).digest()
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([
    cipher.update(String(value), 'utf8'),
    cipher.final()
  ])
  const tag = cipher.getAuthTag()

  return JSON.stringify({
    iv: iv.toString('hex'),
    content: encrypted.toString('base64'),
    tag: tag.toString('hex')
  })
}

export function decryptField(value) {
  if (!value) return ''

  const parsed = safeJsonParse(value)
  if (!parsed || !parsed.iv || !parsed.content || !parsed.tag) {
    return String(value)
  }

  try {
    const key = crypto.createHash('sha256').update(APP_SECRET).digest()
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.iv, 'hex'))
    decipher.setAuthTag(Buffer.from(parsed.tag, 'hex'))
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(parsed.content, 'base64')),
      decipher.final()
    ])

    return decrypted.toString('utf8')
  } catch {
    return String(value)
  }
}

export function generateToken(userName, browserId) {
  return jwt.sign({ userName, browserId: browserId || '' }, JWT_SECRET, { expiresIn: '365d' })
}

export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET)
}

export function hashLoginToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex')
}
