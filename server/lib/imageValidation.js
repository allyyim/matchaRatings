// Server-side image validation for user-uploaded photos.
//
// The API accepts photos as base64 data URLs (data:image/<type>;base64,<payload>)
// because clients pre-resize on-device before send. That means EVERY layer of
// trust — Content-Type header, data-URL MIME prefix, filename — is
// client-controlled and MUST be treated as untrusted.
//
// Steps this module enforces:
// 1. Cheap length check on the raw data URL (rejects giant uploads before
//    base64 decode). ~11 MB base64 ≈ 8 MB decoded.
// 2. Parse and whitelist the data-URL MIME (image/png|jpeg|gif|webp only).
// 3. Base64-decode the payload and check its length (again against 8 MB).
// 4. Read the first bytes and compare against magic-byte signatures for
//    the declared MIME. A PNG payload with a `data:image/jpeg` prefix will
//    be rejected.
//
// Callers that pass the returned { buffer, mime } to Cloudinary should ALSO
// pin `resource_type: 'image'` so the storage layer rejects anything that
// somehow got past this validator.

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024 // 8 MB decoded
export const MAX_DATA_URL_LENGTH = 12 * 1024 * 1024 // ~12 MB base64

const ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])

// Magic-byte signatures per MIME. Each entry is [offset, [expected bytes]].
// WebP has RIFF at 0 and WEBP at 8 so we check both.
const MAGIC_BYTES = {
  'image/png':  [[0, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]]],
  'image/jpeg': [[0, [0xFF, 0xD8, 0xFF]]],
  'image/gif':  [[0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]], [0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]]],
  'image/webp': [[0, [0x52, 0x49, 0x46, 0x46]], [8, [0x57, 0x45, 0x42, 0x50]]],
}

function bytesMatch(buffer, offset, expected) {
  if (buffer.length < offset + expected.length) return false
  for (let i = 0; i < expected.length; i++) {
    if (buffer[offset + i] !== expected[i]) return false
  }
  return true
}

/**
 * Validate a data:image/<type>;base64,<payload> string.
 * @returns { ok: true, buffer, mime } on success, or { ok: false, status, error } on failure.
 */
export function validateImageDataUrl(rawInput) {
  if (typeof rawInput !== 'string' || !rawInput) {
    return { ok: false, status: 400, error: 'Image payload is required' }
  }
  if (rawInput.length > MAX_DATA_URL_LENGTH) {
    return { ok: false, status: 413, error: 'Image is too large' }
  }

  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(rawInput)
  if (!match) {
    return { ok: false, status: 400, error: 'Invalid image data URL' }
  }

  const mime = match[1].toLowerCase()
  if (!ALLOWED_MIME_TYPES.has(mime)) {
    return { ok: false, status: 415, error: 'Unsupported image type' }
  }

  let buffer
  try {
    buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64')
  } catch {
    return { ok: false, status: 400, error: 'Malformed base64 payload' }
  }

  if (buffer.length === 0) {
    return { ok: false, status: 400, error: 'Empty image payload' }
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    return { ok: false, status: 413, error: 'Image is too large' }
  }

  const signatures = MAGIC_BYTES[mime] || []
  const bySignature = mime === 'image/webp'
    ? signatures.every(([off, bytes]) => bytesMatch(buffer, off, bytes))
    : signatures.some(([off, bytes]) => bytesMatch(buffer, off, bytes))
  if (!bySignature) {
    return { ok: false, status: 415, error: 'Image bytes do not match declared type' }
  }

  return { ok: true, buffer, mime }
}
