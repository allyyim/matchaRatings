// Magic-link email helpers. Uses Resend when RESEND_API_KEY is set; otherwise
// logs the link so local dev can just click it from the console.

import crypto from 'node:crypto'
import { Resend } from 'resend'
import { pool } from '../db.js'
import { hashLoginToken } from './crypto.js'

const LOGIN_TOKEN_TTL_MS = 1000 * 60 * 15
export const APP_ORIGIN = String(process.env.APP_ORIGIN || 'https://allyyim.github.io/matchaRatings').replace(/\/$/, '')
export const EMAIL_FROM = process.env.EMAIL_FROM || 'Sip & Score <onboarding@resend.dev>'
export const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null

export async function createLoginToken(email, purpose, userName = null) {
  const rawToken = crypto.randomBytes(32).toString('base64url')
  const tokenHash = hashLoginToken(rawToken)
  const expiresAt = new Date(Date.now() + LOGIN_TOKEN_TTL_MS)

  await pool.query(
    `INSERT INTO login_tokens (token_hash, email, user_name, purpose, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [tokenHash, email, userName, purpose, expiresAt]
  )

  return rawToken
}

export async function sendMagicLinkEmail(email, rawToken, purpose) {
  const link = `${APP_ORIGIN}/?authToken=${encodeURIComponent(rawToken)}&purpose=${encodeURIComponent(purpose)}`

  if (!resend) {
    console.log(`[dev] Magic sign-in link for ${email}: ${link}`)
    return link
  }

  const subject = purpose === 'link' ? 'Link your Sip & Score account' : 'Your Sip & Score sign-in link'
  await resend.emails.send({
    from: EMAIL_FROM,
    to: email,
    subject,
    html: `
      <p>Click the link below to sign in to Sip &amp; Score. This link expires in 15 minutes and can only be used once.</p>
      <p><a href="${link}">${link}</a></p>
      <p>If you didn't request this, you can safely ignore this email.</p>
    `
  })

  return null
}
