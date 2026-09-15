// Per-user localStorage cache keys so critical UI state (ratings list,
// preferences, following list) survives a bad network / offline restart
// and reappears instantly on next launch instead of flashing empty.

function cacheKey(userName: string, kind: string): string {
  const safe = String(userName || '').toLowerCase().trim()
  return `matcha:${safe}:${kind}`
}

export function readCache<T>(userName: string, kind: string): T | null {
  if (!userName) return null
  try {
    const raw = localStorage.getItem(cacheKey(userName, kind))
    if (!raw) return null
    return JSON.parse(raw) as T
  } catch { return null }
}

export function writeCache(userName: string, kind: string, value: unknown): void {
  if (!userName) return
  try {
    localStorage.setItem(cacheKey(userName, kind), JSON.stringify(value))
  } catch { /* quota exceeded / private mode — ignore */ }
}
