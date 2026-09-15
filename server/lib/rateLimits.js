// Three-tier rate limiting. See README > Security for the design.
// - Auth (5/min): mutating auth endpoints — brute-force protection
// - Recs (40/min): heavy discovery joins + cache-thrash protection
// - Global (120/min): floor for everything else under /api

import rateLimit from 'express-rate-limit'

export const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' }
})

export const authRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a minute and try again.' }
})

export const recsRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' }
})
