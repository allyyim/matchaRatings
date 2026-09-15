// Pure text-sanitization helpers used across every route.
// Extracted from server/index.js so validation logic can be unit-tested
// and reused without dragging in db, jwt, or the express app.

export function sanitizeText(value, maxLength = 500) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

export function sanitizeUserName(value) {
  return sanitizeText(value, 80).replace(/[^a-zA-Z0-9._-]/g, '')
}

export function normalizeLocationText(value) {
  return sanitizeText(value, 200)
}

export function safeJsonParse(value) {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase().slice(0, 254)
}

export function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254
}
