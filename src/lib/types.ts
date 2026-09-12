// Shared client types. Kept small on purpose — only put types here that
// are consumed by multiple modules (App.tsx, features/*, lib/*).

export type RatingEntry = {
  id: number
  userName: string
  photo: string
  rating: number
  greenness: number
  location: string
  thoughts: string
  date: string
  createdAt: string
  comboScore: number
  flavorPreferences?: Record<string, number>
  userAvatarUrl?: string | null
}
