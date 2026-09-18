// Small library of tea/matcha-flavored one-liners that fire on save
// and on destructive actions. Each pool is deliberately overstocked so
// the same joke doesn't repeat back-to-back within a session — the
// pickQuip() helper hashes the seed (usually the entry id or ratingId)
// so the same entry always shows the same line if you re-see it, but
// two different saves in a row draw from different indexes.
//
// Voice: dry, tea-nerdy, gently teasing. Never mean, never twee.
// Keep every line <= 60 chars so it fits the toast on a phone.

// Deterministic hash → non-negative int, so a stable seed (entry id,
// timestamp) yields the same pick across renders.
function hashSeed(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

function pick<T>(pool: readonly T[], seed: string): T {
  return pool[hashSeed(seed) % pool.length]
}

// ---------- Save toast one-liners, tiered by Sip Score (0–100) ----------

const QUIPS_STUNNER = [
  'Ceremonial-grade behavior.',
  'That one goes in the tea diary.',
  'Whisk drop. Mic drop.',
  'Umami just texted its regards.',
  'Chawan-worthy.',
  'The tea gods are pleased.',
  'That is a sip to steep on.',
  'Big matcha energy.',
  'Peak leaf. Certified.',
] as const

const QUIPS_SOLID = [
  'A respectable pour.',
  'Steady green hands.',
  'The whisk approves.',
  'No notes. Well, a few. Solid though.',
  'Reliable leaf work.',
  'Would sip again.',
  'Solid brew, solid choice.',
  'Nicely steeped.',
] as const

const QUIPS_MID = [
  'Logged. The leaves remember.',
  'A sip is a sip.',
  'Middle of the whisk.',
  'Noted for the archives.',
  'Tea diplomacy in action.',
  'Not every bowl is ceremonial.',
  'Steady as she pours.',
] as const

const QUIPS_MISS = [
  'The leaves have spoken. Reluctantly.',
  'Noted the miss. On to the next whisk.',
  'Even the ceremony has off days.',
  'Not every brew is a ballad.',
  'Filed under: growth opportunity.',
  'The whisk has seen better bowls.',
  'A learning sip.',
  'One for the tea historians.',
] as const

/**
 * Get a save-toast one-liner tuned to the sip score. Seed with the
 * new rating's id (or any stable string) so the same entry always
 * shows the same line but sequential saves feel varied.
 */
export function getSaveQuip(sipScore: number, seed: string): string {
  const pool =
    sipScore >= 85 ? QUIPS_STUNNER :
    sipScore >= 70 ? QUIPS_SOLID :
    sipScore >= 50 ? QUIPS_MID :
    QUIPS_MISS
  return pick(pool, seed)
}

// ---------- Delete confirmation prompts ----------

const QUIPS_DELETE = [
  'Retire this sip from the log? The leaves will forgive you.',
  'Compost this rating? The whisk will not judge.',
  'Pour this rating out? It will not steep again.',
  'Empty the bowl on this one? No refills.',
  'Send this sip to the tea graveyard? No going back.',
  'Cold-brew this rating out of existence?',
  'Skim this off the top? The log moves on.',
] as const

/**
 * Get a delete-confirm prompt. Seed with the entry id so the same
 * rating always asks the same question — feels consistent, not
 * chaotic, if the user cancels and reopens.
 */
export function getDeleteQuip(seed: string): string {
  return pick(QUIPS_DELETE, seed)
}
