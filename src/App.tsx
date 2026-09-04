import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { useGoogleLogin } from '@react-oauth/google'
import * as Sentry from '@sentry/react'
import confetti from 'canvas-confetti'
import './App.css'

const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN || ''

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: import.meta.env.MODE,
    release: `matcha-ratings@${import.meta.env.VITE_APP_VERSION || 'dev'}`,
    tracesSampleRate: 1.0,
    integrations: [Sentry.browserTracingIntegration()],
    enableLogs: true
  })
}

type RatingEntry = {
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
}

type Page = 'home' | 'friends' | 'explore'
type ExplorePlace = {
  rank: number
  placeName: string
  entryCount: number
  averageScore: number
}

type ExploreUser = {
  userName: string
  placeCount: number
}

type ExplorePlaceRatingsResponse = {
  placeName: string
  ratings: RatingEntry[]
}

type DrinkRegion = {
  source: 'heuristic' | 'ml-mask'
  contains: (x: number, y: number) => boolean
}

type DetectResult = {
  region: DrinkRegion
  statusMessage: string
  coveragePercent: number | null
  confidencePercent: number | null
}

const rawApiBaseUrl = String(import.meta.env.VITE_API_BASE_URL || '/api')
const API_BASE_URL = (() => {
  if (typeof window === 'undefined') return rawApiBaseUrl

  const host = window.location.hostname
  const isPhoneOrLanClient = host !== 'localhost' && host !== '127.0.0.1'
  const apiPointsToLocalhost = /https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(rawApiBaseUrl)

  // If on GitHub Pages, use Render backend
  if (host.includes('github.io')) {
    return 'https://matcharatings.onrender.com/api'
  }

  // If opened from a phone/LAN host, never call localhost from env config.
  if (isPhoneOrLanClient && apiPointsToLocalhost) {
    return '/api'
  }

  return rawApiBaseUrl
})()
const pixelStarUrl = `${import.meta.env.BASE_URL}blank.png`
const pixelStarFilledUrl = `${import.meta.env.BASE_URL}filled.png`
const pencilIconUrl = `${import.meta.env.BASE_URL}pencil.svg`
const trashIconUrl = `${import.meta.env.BASE_URL}trash.svg`
const noPhotoPlaceholderUrl = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640">
    <rect width="640" height="640" rx="36" fill="#edf6ea"/>
    <rect x="52" y="52" width="536" height="536" rx="28" fill="#f9fbf7" stroke="#d0e3c3" stroke-width="8"/>
    <path d="M180 388c26-56 64-90 132-90s106 34 132 90" fill="none" stroke="#a7c79d" stroke-width="18" stroke-linecap="round"/>
    <circle cx="320" cy="242" r="86" fill="#dfeecf"/>
    <path d="M196 422h248" stroke="#b9d2ad" stroke-width="12" stroke-linecap="round"/>
    <text x="320" y="552" text-anchor="middle" fill="#58755e" font-family="Arial, sans-serif" font-size="34" font-weight="600">No photo</text>
  </svg>
`)}`

const FULL_GREENNESS_WEIGHT = 1
const LOW_RATING_GREENNESS_WEIGHT = 0.8
const API_REQUEST_TIMEOUT_MS = 20000
const IMAGE_PROCESS_TIMEOUT_MS = 15000
const LOCATION_LOOKUP_DEBOUNCE_MS = 180
const LOCATION_RESULTS_LIMIT = 5
const INITIAL_GREENSCORE_REFRESH_LIMIT = 4
const MIN_BACKGROUND_GREENSCORE_DIFF = 5
const BACKGROUND_GREENSCORE_TIMEOUT_MS = 5000

function getWeightedScore(rating: number, greenness: number) {
  const greennessWeight = rating >= 4 ? FULL_GREENNESS_WEIGHT : LOW_RATING_GREENNESS_WEIGHT
  return rating * 20 + greenness * greennessWeight
}

function withUpdatedGreenness(entry: RatingEntry, greenness: number): RatingEntry {
  return {
    ...entry,
    greenness,
    comboScore: Number(getWeightedScore(entry.rating, greenness).toFixed(2))
  }
}

function compareEntriesForRank(a: RatingEntry, b: RatingEntry) {
  const aIsZeroStar = a.rating === 0
  const bIsZeroStar = b.rating === 0

  if (aIsZeroStar !== bIsZeroStar) {
    return aIsZeroStar ? 1 : -1
  }

  if (aIsZeroStar && bIsZeroStar) {
    if (b.greenness !== a.greenness) return b.greenness - a.greenness
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  }

  const scoreA = getWeightedScore(a.rating, a.greenness)
  const scoreB = getWeightedScore(b.rating, b.greenness)
  if (scoreB !== scoreA) return scoreB - scoreA
  if (b.rating !== a.rating) return b.rating - a.rating
  return b.greenness - a.greenness
}

let randomForestModel: any = null
let randomForestPromise: Promise<any> | null = null

async function loadRandomForest() {
  if (randomForestModel) return randomForestModel
  if (randomForestPromise) return await randomForestPromise

  randomForestPromise = (async () => {
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}ml/drink-area/forest.json`)
      const model = await response.json()
      console.log('DEBUG: Random Forest loaded!')
      return model
    } catch (e) {
      console.log('DEBUG: Failed to load forest:', e)
      return null
    }
  })()

  randomForestModel = await randomForestPromise
  return randomForestModel
}

function predictTreeNode(node: any, features: number[]): number {
  if (node.type === 'leaf') {
    return node.class
  }
  const feature = features[node.feature]
  if (feature <= node.threshold) {
    return predictTreeNode(node.left, features)
  } else {
    return predictTreeNode(node.right, features)
  }
}

function predictRandomForest(features: number[], forest: any): number {
  const predictions = forest.trees.map((tree: any) => predictTreeNode(tree, features))
  const votes = [0, 0]
  predictions.forEach((p: number) => votes[p]++)
  return votes[1] > votes[0] ? 1 : 0
}

function createFallbackRegion(width: number, height: number): DrinkRegion {
  const centerX = Math.floor(width / 2)
  const centerY = Math.floor(height / 2)
  const radius = Math.floor(Math.min(width, height) / 1.5)
  const radiusSquared = radius * radius

  return {
    source: 'heuristic',
    contains(x: number, y: number) {
      const dx = x - centerX
      const dy = y - centerY
      return dx * dx + dy * dy <= radiusSquared
    }
  }
}

async function detectDrinkAreaRegion(img: HTMLImageElement): Promise<DetectResult> {
  const fallbackRegion = createFallbackRegion(img.width, img.height)

  const forest = await loadRandomForest()
  if (!forest) {
    console.log('DEBUG: Forest not loaded')
    return {
      region: fallbackRegion,
      statusMessage: 'ML model not found. Using heuristic drink area.',
      coveragePercent: null,
      confidencePercent: null
    }
  }

  console.log('DEBUG: Using Random Forest for drink detection')

  // Create canvas to extract pixel data
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return { region: fallbackRegion, statusMessage: 'Canvas error.', coveragePercent: null, confidencePercent: null }

  ctx.drawImage(img, 0, 0)
  const imageData = ctx.getImageData(0, 0, img.width, img.height).data

  // Sample pixels and predict
  let drinkPixels = 0
  let totalPixels = 0

  for (let i = 0; i < imageData.length; i += 4) {
    const r = imageData[i]
    const g = imageData[i + 1]
    const b = imageData[i + 2]

    const maxc = Math.max(r, g, b)
    const minc = Math.min(r, g, b)
    if (maxc === 0) continue

    const sat = (maxc - minc) / maxc
    const val = maxc / 255.0

    const features = [r/255, g/255, b/255, sat, val]
    const isDrink = predictRandomForest(features, forest) === 1

    if (isDrink) drinkPixels++
    totalPixels++
  }

  console.log(`DEBUG: Random Forest detected ${drinkPixels}/${totalPixels} pixels as drink area`)

  if (drinkPixels < totalPixels * 0.01) {
    return {
      region: fallbackRegion,
      statusMessage: 'ML found no drink region. Using heuristic drink area.',
      coveragePercent: null,
      confidencePercent: null
    }
  }

  const coveragePercent = (drinkPixels / totalPixels) * 100

  // Create a mask from forest predictions
  const maskPixels = new Uint8ClampedArray(img.width * img.height)
  for (let i = 0, j = 0; i < imageData.length; i += 4, j++) {
    const r = imageData[i]
    const g = imageData[i + 1]
    const b = imageData[i + 2]

    const maxc = Math.max(r, g, b)
    const minc = Math.min(r, g, b)
    if (maxc === 0) { maskPixels[j] = 0; continue }

    const sat = (maxc - minc) / maxc
    const val = maxc / 255.0
    const features = [r/255, g/255, b/255, sat, val]

    maskPixels[j] = predictRandomForest(features, forest) === 1 ? 255 : 0
  }

  return {
    region: {
      source: 'ml-mask',
      contains(x: number, y: number) {
        const idx = y * img.width + x
        return maskPixels[idx] > 128
      }
    },
    statusMessage: 'Random Forest drink detection active.',
    coveragePercent,
    confidencePercent: 85
  }
}

function analyzeGreennessFromDataUrl(dataUrl: string): Promise<{
  score: number
  statusMessage: string
  coveragePercent: number | null
  confidencePercent: number | null
}> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = async () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve({ score: 0, statusMessage: 'Unable to read image context.', coveragePercent: null, confidencePercent: null })
        return
      }

      ctx.drawImage(img, 0, 0)
      const imageData = ctx.getImageData(0, 0, img.width, img.height).data
      const { region, statusMessage, coveragePercent, confidencePercent } = await detectDrinkAreaRegion(img)
      const visited = new Uint8Array(img.width * img.height)

      function getPixelIndex(x: number, y: number) {
        return y * img.width + x
      }

      function classifyMatchaPixel(r: number, g: number, b: number) {
        const brightness = (r + g + b) / (255 * 3)
        const maxRGB = Math.max(r, g, b)
        const minRGB = Math.min(r, g, b)
        const saturation = maxRGB ? (maxRGB - minRGB) / maxRGB : 0
        const greenDominance = g - Math.max(r, b)
        const darkLighting = brightness < 0.35

        const emeraldThreshold = darkLighting ? 7 : 15
        const paleThreshold = darkLighting ? 0 : 5

        if (
          greenDominance >= emeraldThreshold &&
          g >= r + (darkLighting ? 3 : 7) &&
          g >= b + (darkLighting ? 3 : 7) &&
          saturation >= (darkLighting ? 0.04 : 0.08)
        ) {
          return { bucket: 'emerald' as const, weight: 1 }
        }

        if (
          g + (darkLighting ? 8 : 4) >= r &&
          g + (darkLighting ? 6 : 3) >= b &&
          greenDominance >= paleThreshold &&
          saturation >= (darkLighting ? 0.02 : 0.04)
        ) {
          return { bucket: 'pale' as const, weight: darkLighting ? 0.7 : 0.55 }
        }

        return { bucket: 'none' as const, weight: 0 }
      }

      function isInside(x: number, y: number) {
        return x >= 0 && y >= 0 && x < img.width && y < img.height
      }

      let totalWeightedScore = 0
      let totalBucketPixels = 0
      let emeraldPixelCount = 0
      let palePixelCount = 0
      let matchaLikePixelCount = 0

      for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
          if (!region.contains(x, y)) continue

          const index = getPixelIndex(x, y)
          if (visited[index]) continue

          const i = (y * img.width + x) * 4
          const r = imageData[i]
          const g = imageData[i + 1]
          const b = imageData[i + 2]

          if (r > 230 && g > 230 && b > 230) continue

          const seedClassification = classifyMatchaPixel(r, g, b)
          if (seedClassification.bucket === 'none') continue

          const stack: Array<[number, number]> = [[x, y]]
          let componentPixels = 0
          let componentScore = 0

          visited[index] = 1

          while (stack.length > 0) {
            const current = stack.pop()
            if (!current) continue

            const [currentX, currentY] = current
            if (!isInside(currentX, currentY) || !region.contains(currentX, currentY)) continue

            const currentIndex = getPixelIndex(currentX, currentY)
            if (visited[currentIndex] !== 1) {
              visited[currentIndex] = 1
            }

            const pixelOffset = (currentY * img.width + currentX) * 4
            const pixelR = imageData[pixelOffset]
            const pixelG = imageData[pixelOffset + 1]
            const pixelB = imageData[pixelOffset + 2]

            if (pixelR > 230 && pixelG > 230 && pixelB > 230) continue

            const pixelClassification = classifyMatchaPixel(pixelR, pixelG, pixelB)
            if (pixelClassification.bucket === 'none') continue

            componentPixels++
            matchaLikePixelCount++
            componentScore += pixelClassification.weight
            if (pixelClassification.bucket === 'emerald') {
              emeraldPixelCount++
            } else if (pixelClassification.bucket === 'pale') {
              palePixelCount++
            }

            const neighbors: Array<[number, number]> = [
              [currentX + 1, currentY],
              [currentX - 1, currentY],
              [currentX, currentY + 1],
              [currentX, currentY - 1]
            ]

            for (const [nextX, nextY] of neighbors) {
              if (!isInside(nextX, nextY)) continue
              const nextIndex = getPixelIndex(nextX, nextY)
              if (visited[nextIndex]) continue
              if (!region.contains(nextX, nextY)) continue

              const nextOffset = (nextY * img.width + nextX) * 4
              const nextR = imageData[nextOffset]
              const nextG = imageData[nextOffset + 1]
              const nextB = imageData[nextOffset + 2]
              if (nextR > 230 && nextG > 230 && nextB > 230) continue

              if (classifyMatchaPixel(nextR, nextG, nextB).bucket !== 'none') {
                visited[nextIndex] = 1
                stack.push([nextX, nextY])
              }
            }
          }

          if (componentPixels > 8) {
            totalWeightedScore += componentScore
            totalBucketPixels += componentPixels
          }
        }
      }

      const score = totalBucketPixels
        ? (() => {
            const baseScore = (totalWeightedScore / totalBucketPixels) * 100
            const emeraldRatio = matchaLikePixelCount ? emeraldPixelCount / matchaLikePixelCount : 0
            const paleRatio = matchaLikePixelCount ? palePixelCount / matchaLikePixelCount : 0
            const coverageRatio = Math.min(1, totalBucketPixels / Math.max(1, img.width * img.height * 0.2))

            // Add a small analytical adjustment so similarly green drinks separate more often.
            const analyticalAdjustment = (emeraldRatio * 0.45) + (coverageRatio * 0.35) + (paleRatio * 0.1)

            return Number(Math.min(100, baseScore + analyticalAdjustment).toFixed(1))
          })()
        : 0
      resolve({ score, statusMessage, coveragePercent, confidencePercent })
    }
    img.onerror = () => resolve({ score: 0, statusMessage: 'Failed to load image.', coveragePercent: null, confidencePercent: null })
    img.src = dataUrl
  })
}

function createFallbackBrowserId() {
  return `mb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function getSafeRandomUuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return createFallbackBrowserId()
}

function downscaleDataUrlImage(dataUrl: string, maxDimension = 1280, quality = 0.82): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const width = img.width
      const height = img.height

      if (!width || !height) {
        resolve(dataUrl)
        return
      }

      const largestSide = Math.max(width, height)
      const scale = largestSide > maxDimension ? maxDimension / largestSide : 1
      const targetWidth = Math.max(1, Math.round(width * scale))
      const targetHeight = Math.max(1, Math.round(height * scale))

      const canvas = document.createElement('canvas')
      canvas.width = targetWidth
      canvas.height = targetHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve(dataUrl)
        return
      }

      ctx.drawImage(img, 0, 0, targetWidth, targetHeight)

      try {
        resolve(canvas.toDataURL('image/jpeg', quality))
      } catch {
        resolve(dataUrl)
      }
    }

    img.onerror = () => resolve(dataUrl)
    img.src = dataUrl
  })
}

function getBrowserId() {
  const existing = localStorage.getItem('matchaBrowserId')
  if (existing) return existing
  const generated = getSafeRandomUuid()
  localStorage.setItem('matchaBrowserId', generated)
  return generated
}

function getGreennessRefreshKey(userName: string) {
  return `matchaGreennessRefreshed:${userName.trim().toLowerCase()}`
}

function getSessionToken() {
  if (typeof window === 'undefined') return ''
  // Only check localStorage (persistent storage)
  return window.localStorage.getItem('matchaAuthToken') || ''
}

function setSessionToken(token: string) {
  if (typeof window === 'undefined') return
  if (token) {
    window.localStorage.setItem('matchaAuthToken', token)
    return
  }

  // Clear on logout
  window.localStorage.removeItem('matchaAuthToken')
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  if (typeof window !== 'undefined' && window.location.protocol === 'http:' && !window.location.hostname.match(/^(localhost|127\.0\.0\.1)$/)) {
    console.warn('Warning: Using HTTP in production. Consider using HTTPS.')
  }

  const headers = new Headers(init?.headers || {})
  headers.set('Content-Type', 'application/json')
  headers.set('X-Requested-With', 'XMLHttpRequest')

  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content')
  if (csrfToken) {
    headers.set('X-CSRF-Token', csrfToken)
  }

  const token = getSessionToken()
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), API_REQUEST_TIMEOUT_MS)

  const requestSignal = init?.signal
  const stopAbortListener = () => controller.abort()
  if (requestSignal) {
    if (requestSignal.aborted) {
      controller.abort()
    } else {
      requestSignal.addEventListener('abort', stopAbortListener, { once: true })
    }
  }

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers,
      credentials: 'same-origin',
      signal: controller.signal
    })

    if (!response.ok) {
      const text = await response.text()
      try {
        const errorJson = JSON.parse(text)
        throw new Error(errorJson.error || `Request failed with status ${response.status}`)
      } catch (parseErr) {
        throw new Error(text || `Request failed with status ${response.status}`)
      }
    }

    return response.json() as Promise<T>
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('The request timed out or was cancelled.')
    }

    throw error
  } finally {
    window.clearTimeout(timeoutId)
    if (requestSignal) {
      requestSignal.removeEventListener('abort', stopAbortListener)
    }
  }
}

function App() {
  const [activePage, setActivePage] = useState<Page>('home')
  const [browserId] = useState(() => getBrowserId())
  const [currentUserName, setCurrentUserName] = useState('')
  const [pendingUserName, setPendingUserName] = useState('')
  const [requiresManualName, setRequiresManualName] = useState(false)
  const [isSubmittingName, setIsSubmittingName] = useState(false)
  const [isUserReady, setIsUserReady] = useState(false)
  const [authError, setAuthError] = useState('')
  const [authMode, setAuthMode] = useState<'choice' | 'signin' | 'newuser' | 'confirm-account' | 'magic-link' | 'magic-link-username'>('choice')
  const [welcomeMessage, setWelcomeMessage] = useState('')
  const [potentialAccounts, setPotentialAccounts] = useState<string[]>([])
  const [selectedPotentialAccount, setSelectedPotentialAccount] = useState<string | null>(null)
  const [verifiedAccountName, setVerifiedAccountName] = useState<string | null>(null)

  const [currentRating, setCurrentRating] = useState(0)
  const [ratingFlavorPrefs, setRatingFlavorPrefs] = useState({ sweet: 0, nutty: 0, umami: 0, vegetal: 0, sugary: 0, astringent: 0, creamy: 0, floral: 0, earthy: 0, Chocolatey: 0, mellow: 0 })
  const [location, setLocation] = useState('')
  const [locationSuggestions, setLocationSuggestions] = useState<string[]>([])
  const [isLocationLookupPending, setIsLocationLookupPending] = useState(false)
  const [showLocationSuggestions, setShowLocationSuggestions] = useState(false)
  const locationDebounceRef = useRef<number | null>(null)
  const locationBlurTimeoutRef = useRef<number | null>(null)
  const locationLookupSequenceRef = useRef(0)
  const locationResultsCacheRef = useRef<Map<string, string[]>>(new Map())
  const locationLookupInFlightRef = useRef<Map<string, Promise<string[]>>>(new Map())
  const [thoughts, setThoughts] = useState('')
  const [isNotesModalOpen, setIsNotesModalOpen] = useState(false)
  const [milestoneMessage, setMilestoneMessage] = useState('')
  const [photoDataUrl, setPhotoDataUrl] = useState('')
  const [matchaGreenness, setMatchaGreenness] = useState<number | null>(null)
  const [mlStatus, setMlStatus] = useState('ML drink-area detector will load when you analyze a photo.')
  const [mlCoveragePercent, setMlCoveragePercent] = useState<number | null>(null)
  const [mlConfidencePercent, setMlConfidencePercent] = useState<number | null>(null)
  const [cameraReady, setCameraReady] = useState(false)
  const [cameraError, setCameraError] = useState('')
  const [isCameraModalOpen, setIsCameraModalOpen] = useState(false)
  const [isUploadMenuOpen, setIsUploadMenuOpen] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const photoInputRef = useRef<HTMLInputElement>(null)
  const cameraStreamRef = useRef<MediaStream | null>(null)

  const [myEntries, setMyEntries] = useState<RatingEntry[]>([])
  const [isMyRatingsLoading, setIsMyRatingsLoading] = useState(true)
  const [myRatingsSort, setMyRatingsSort] = useState<'highest' | 'lowest' | 'greenest' | 'newest' | 'oldest'>('highest')
  const [isMyRatingsFilterOpen, setIsMyRatingsFilterOpen] = useState(false)
  const [isMyRatingsSearchOpen, setIsMyRatingsSearchOpen] = useState(false)
  const [selectedEntryId, setSelectedEntryId] = useState<number | null>(null)
  const [isEditingEntry, setIsEditingEntry] = useState(false)
  const [editRating, setEditRating] = useState(0)
  const [editLocation, setEditLocation] = useState('')
  const [editThoughts, setEditThoughts] = useState('')
  const [editEntryPhoto, setEditEntryPhoto] = useState<string>('')
  const [friendQuery, setFriendQuery] = useState('')
  const [friendSuggestions, setFriendSuggestions] = useState<Array<{ userName: string; placeCount: number }>>([])
  const [selectedFriend, setSelectedFriend] = useState('')
  const [friendEntries, setFriendEntries] = useState<RatingEntry[]>([])
  const [isSavingEntry, setIsSavingEntry] = useState(false)
  const [isLoadingFriendRatings, setIsLoadingFriendRatings] = useState(false)
  const [isLoadingExplorePlaces, setIsLoadingExplorePlaces] = useState(false)
  const [explorePlaces, setExplorePlaces] = useState<ExplorePlace[]>([])
  const [exploreUsers, setExploreUsers] = useState<ExploreUser[]>([])
  const [exploreActiveTab, setExploreActiveTab] = useState<'places' | 'users'>('places')
  const [similarActiveTab, setSimilarActiveTab] = useState<'users' | 'places'>('users')
  const [communityActiveTab, setCommunityActiveTab] = useState<'search' | 'following' | 'recommendations'>('search')
  const [similarUsers, setSimilarUsers] = useState<Array<{ userName: string; flavors: string[]; matchScore: number }>>([])
  const [isLoadingSimilarUsers, setIsLoadingSimilarUsers] = useState(false)
  const [similarPlaces, setSimilarPlaces] = useState<Array<{ location: string; flavors: string[]; matchScore: number }>>([])
  const [isLoadingSimilarPlaces, setIsLoadingSimilarPlaces] = useState(false)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [currentOnboardingSlide, setCurrentOnboardingSlide] = useState(0)
  const [selectedExplorePlaceName, setSelectedExplorePlaceName] = useState('')
  const [selectedExplorePlaceEntries, setSelectedExplorePlaceEntries] = useState<RatingEntry[]>([])
  const [isExplorePlaceModalOpen, setIsExplorePlaceModalOpen] = useState(false)
  const [isLoadingExplorePlaceEntries, setIsLoadingExplorePlaceEntries] = useState(false)
  const [isMyLogsExpanded, setIsMyLogsExpanded] = useState(false)
  const [myLogsSearchTerm, setMyLogsSearchTerm] = useState('')
  const [isFriendLogsExpanded, setIsFriendLogsExpanded] = useState(false)
  const [friendLogsSearchTerm, setFriendLogsSearchTerm] = useState('')
  const [friendSort, setFriendSort] = useState<'highest' | 'lowest' | 'greenest' | 'newest' | 'oldest'>('highest')
  const [isFriendFilterOpen, setIsFriendFilterOpen] = useState(false)
  const [isFriendSearchOpen, setIsFriendSearchOpen] = useState(false)
  const [isRatingDragActive, setIsRatingDragActive] = useState(false)
  const [isEditRatingDragActive, setIsEditRatingDragActive] = useState(false)

  // Phase 2 & 3 features
  const [pendingMagicEmail, setPendingMagicEmail] = useState('')
  const [isMagicLinkSent, setIsMagicLinkSent] = useState(false)
  const [isPreferencesModalOpen, setIsPreferencesModalOpen] = useState(false)
  const [isProfileDrawerOpen, setIsProfileDrawerOpen] = useState(false)
  const [isChangeEmailDrawerOpen, setIsChangeEmailDrawerOpen] = useState(false)
  const [isPrivacyPolicyModalOpen, setIsPrivacyPolicyModalOpen] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [userFlavors, setUserFlavors] = useState<string[]>([])
  const [likedRatingsSet, setLikedRatingsSet] = useState<Set<number>>(new Set())
  const [followingSet, setFollowingSet] = useState<Set<string>>(new Set())

  const showLoadingOverlay = isSavingEntry || isLoadingFriendRatings || isLoadingExplorePlaces
  const loadingOverlayText = isSavingEntry
    ? 'Brewing your memory...'
    : isLoadingExplorePlaces
      ? 'Loading explore data...'
      : 'Loading friend ratings...'

  const rankedMine = useMemo(() => {
    return [...myEntries].sort(compareEntriesForRank)
  }, [myEntries])

  const myRankById = useMemo(() => {
    return new Map(rankedMine.map((entry, index) => [entry.id, index + 1]))
  }, [rankedMine])

  const sortedMine = useMemo(() => {
    if (!myLogsSearchTerm.trim()) return rankedMine

    const searchLower = myLogsSearchTerm.toLowerCase()
    return rankedMine.filter((entry) =>
      entry.location.toLowerCase().includes(searchLower) ||
      entry.thoughts.toLowerCase().includes(searchLower)
    )
  }, [rankedMine, myLogsSearchTerm])

  const filteredMine = useMemo(() => {
    const next = [...sortedMine]

    switch (myRatingsSort) {
      case 'lowest':
        next.sort((a, b) => a.comboScore - b.comboScore || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        break
      case 'greenest':
        next.sort((a, b) => b.greenness - a.greenness || b.rating - a.rating || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        break
      case 'newest':
        next.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        break
      case 'oldest':
        next.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
        break
      case 'highest':
      default:
        next.sort((a, b) => b.comboScore - a.comboScore || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        break
    }

    return next
  }, [sortedMine, myRatingsSort])

  const rankedFriendEntries = useMemo(() => {
    return [...friendEntries].sort(compareEntriesForRank)
  }, [friendEntries])

  const friendRankById = useMemo(() => {
    return new Map(rankedFriendEntries.map((entry, index) => [entry.id, index + 1]))
  }, [rankedFriendEntries])

  const filteredFriendEntries = useMemo(() => {
    let filtered = rankedFriendEntries
    
    if (friendLogsSearchTerm.trim()) {
      const searchLower = friendLogsSearchTerm.toLowerCase()
      filtered = rankedFriendEntries.filter((entry) =>
        entry.location.toLowerCase().includes(searchLower) ||
        entry.thoughts.toLowerCase().includes(searchLower)
      )
    }

    const sorted = [...filtered]

    switch (friendSort) {
      case 'lowest':
        sorted.sort((a, b) => a.comboScore - b.comboScore || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        break
      case 'greenest':
        sorted.sort((a, b) => b.greenness - a.greenness || b.rating - a.rating || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        break
      case 'newest':
        sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        break
      case 'oldest':
        sorted.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
        break
      case 'highest':
      default:
        sorted.sort((a, b) => b.comboScore - a.comboScore || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        break
    }

    return sorted
  }, [rankedFriendEntries, friendLogsSearchTerm, friendSort])

  async function fetchWithRetry<T>(work: () => Promise<T>, maxRetries = 2): Promise<T> {
    let lastError: unknown

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        return await work()
      } catch (error) {
        lastError = error
        if (attempt >= maxRetries) {
          throw error
        }

        await new Promise((resolve) => window.setTimeout(resolve, 350 * (attempt + 1)))
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Request failed after retries.')
  }

  async function refreshGreennessForEntries(entries: RatingEntry[], persistUserName?: string, limit = INITIAL_GREENSCORE_REFRESH_LIMIT) {
    const candidates = entries.slice(0, Math.min(limit, entries.length))
    if (!candidates.length) {
      return []
    }

    const refreshedEntries = await Promise.all(
      candidates.map(async (entry) => {
        if (!entry.photo || entry.photo === noPhotoPlaceholderUrl) {
          return entry
        }

        try {
          const { score } = await Promise.race([
            analyzeGreennessFromDataUrl(entry.photo),
            new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('Greenness refresh timed out.')), BACKGROUND_GREENSCORE_TIMEOUT_MS))
          ])

          const adjustedEntry = withUpdatedGreenness(entry, score)
          const difference = Math.abs(adjustedEntry.greenness - entry.greenness)
          if (difference < MIN_BACKGROUND_GREENSCORE_DIFF) {
            return entry
          }

          return adjustedEntry
        } catch {
          return entry
        }
      })
    )

    if (persistUserName) {
      const changedEntries = refreshedEntries.filter((entry, index) => {
        const original = candidates[index]
        if (!original) return false
        return Math.abs(entry.greenness - original.greenness) >= MIN_BACKGROUND_GREENSCORE_DIFF
      })

      await Promise.allSettled(
        changedEntries.map((entry) =>
          apiFetch<{ rating: RatingEntry }>(`/ratings/${entry.id}`, {
            method: 'PUT',
            body: JSON.stringify({
              userName: persistUserName,
              rating: entry.rating,
              greenness: entry.greenness,
              location: entry.location,
              thoughts: entry.thoughts
            })
          }).catch(() => null)
        )
      )
    }

    return refreshedEntries
  }

  const googleLogin = useGoogleLogin({
    onSuccess: async (codeResponse) => {
      try {
        setIsSubmittingName(true)
        setAuthError('')

        console.log('=== Google OAuth Debug ===')
        console.log('Full codeResponse:', JSON.stringify(codeResponse))
        console.log('Has access_token?', !!codeResponse.access_token)
        console.log('All keys:', Object.keys(codeResponse))

        if (!codeResponse.access_token) {
          console.error('❌ No access_token in response!')
          setAuthError('Failed to get access token from Google. Please try again.')
          setIsSubmittingName(false)
          return
        }

        const requestBody = verifiedAccountName
          ? { token: codeResponse.access_token, browserId, confirmedUserName: verifiedAccountName }
          : { token: codeResponse.access_token, browserId }
        console.log('Sending to backend:', JSON.stringify(requestBody))

        try {
          const response = await apiFetch<{ userName: string; email: string; token: string; isNewUser?: boolean; potentialAccounts?: string[] }>('/auth/google/verify', {
            method: 'POST',
            body: JSON.stringify(requestBody)
          })
          setSessionToken(response.token || '')
          localStorage.setItem('matchaUserName', response.userName)
          setCurrentUserName(response.userName)
          setRequiresManualName(false)
          setIsUserReady(true)
          setWelcomeMessage(response.userName)
          setVerifiedAccountName(null)
          setTimeout(() => setWelcomeMessage(''), 1500)
          void loadRandomForest().catch(() => undefined)
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error)
          try {
            const errorData = JSON.parse(errorMsg)
            if (errorData.potentialAccounts && errorData.potentialAccounts.length > 0) {
              // Show account linking confirmation
              sessionStorage.setItem('googleAccessToken', codeResponse.access_token)
              setPotentialAccounts(errorData.potentialAccounts)
              setAuthMode('confirm-account')
              return
            }
            if (errorData.isNewUser) {
              sessionStorage.setItem('googleAccessToken', codeResponse.access_token)
              setRequiresManualName(true)
              setPendingUserName('')
              return
            }
            throw new Error(errorData.error || errorMsg)
          } catch (parseError) {
            if (parseError instanceof Error) throw parseError
            throw error
          }
        }
      } catch (error) {
        setAuthError(error instanceof Error ? error.message : 'Google sign-in failed')
      } finally {
        setIsSubmittingName(false)
      }
    },
    onError: () => setAuthError('Google sign-in failed'),
    flow: 'implicit',
    scope: 'openid profile email'
  })

  useEffect(() => {
    sessionStorage.clear()
    localStorage.removeItem('matchaUserName')
    localStorage.removeItem('matchaAuthToken')
    setRequiresManualName(false)
    setPendingUserName('')
    setCurrentUserName('')
  }, [])

  // Check for app updates from service worker
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      // Check for updates every 5 minutes
      const updateInterval = setInterval(() => {
        navigator.serviceWorker.controller?.postMessage({ type: 'CHECK_FOR_UPDATES' })
      }, 5 * 60 * 1000)

      // Listen for update messages from service worker
      navigator.serviceWorker.onmessage = (event) => {
        if (event.data.type === 'APP_UPDATED') {
          // Don't auto-reload - user can manually refresh when ready
          console.log('App updated - refresh to see latest version')
        }
      }

      return () => clearInterval(updateInterval)
    }
  }, [])

  useEffect(() => {
    let mounted = true

    async function initUserSession() {
      try {
        const savedName = localStorage.getItem('matchaUserName') || ''
        const savedToken = getSessionToken()

        console.log('Session restore attempt:', { savedName: !!savedName, savedToken: !!savedToken })

        if (savedName && savedToken) {
          // Returning user with a cached session: skip the login prompt entirely.
          console.log('Restoring session for:', savedName)
          if (mounted) {
            setCurrentUserName(savedName)
            setRequiresManualName(false)
            setIsUserReady(true)
          }
          void loadRandomForest().catch(() => undefined)
          return
        }

        console.log('No saved session found')
        if (mounted) {
          setRequiresManualName(false)
        }
      } catch (error) {
        console.error('Session init error:', error)
        if (!mounted) return
        setRequiresManualName(true)
      }
    }

    void initUserSession()
    return () => {
      mounted = false
    }
  }, [browserId])

  useEffect(() => {
    // Show onboarding ONLY for brand new accounts (first login, 0 entries)
    // Don't show if returning user or they already dismissed it
    if (isUserReady && myEntries.length === 0 && !localStorage.getItem('onboardingShown')) {
      // Check if this is truly a new account by seeing if they just signed up
      const justSignedUp = sessionStorage.getItem('justSignedUp')
      if (justSignedUp) {
        setShowOnboarding(true)
        sessionStorage.removeItem('justSignedUp')
      }
    }
  }, [isUserReady, myEntries.length])

  useEffect(() => {
    // Handle magic link verification from URL
    const params = new URLSearchParams(window.location.search)
    const authToken = params.get('authToken')
    const purpose = params.get('purpose')

    if (authToken && (purpose === 'login' || purpose === 'signup')) {
      const verifyMagicLink = async () => {
        try {
          setIsSubmittingName(true)
          const response = await apiFetch<{ userName: string; email: string; token: string }>('/auth/verify', {
            method: 'POST',
            body: JSON.stringify({ token: authToken, browserId })
          })
          setSessionToken(response.token || '')
          localStorage.setItem('matchaUserName', response.userName)
          setCurrentUserName(response.userName)
          sessionStorage.setItem('justSignedUp', 'true')
          setIsUserReady(true)
          window.history.replaceState({}, document.title, window.location.pathname)
          void loadRandomForest().catch(() => undefined)
        } catch (error) {
          setAuthError(error instanceof Error ? error.message : 'Magic link verification failed')
          window.history.replaceState({}, document.title, window.location.pathname)
        } finally {
          setIsSubmittingName(false)
        }
      }
      void verifyMagicLink()
    }
  }, [browserId])

  function signOut() {
    setSessionToken('')
    localStorage.removeItem('matchaUserName')
    setCurrentUserName('')
    setPendingUserName('')
    setAuthError('')
    setRequiresManualName(false)
    setIsUserReady(false)
    setAuthMode('choice')
  }

  async function handleNewUserNameSubmit() {
    const userName = pendingUserName.trim()
    if (!userName) {
      setAuthError('Please enter a name.')
      return
    }

    try {
      setIsSubmittingName(true)
      setAuthError('')
      const response = await apiFetch<{ userName: string; email: string; token: string }>('/auth/google/verify', {
        method: 'POST',
        body: JSON.stringify({ token: sessionStorage.getItem('googleAccessToken'), userName, browserId })
      })
      setSessionToken(response.token || '')
      localStorage.setItem('matchaUserName', response.userName)
      setCurrentUserName(response.userName)
      setRequiresManualName(false)
      setIsUserReady(true)
      sessionStorage.removeItem('googleAccessToken')
      void loadRandomForest().catch(() => undefined)
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Failed to create account.')
    } finally {
      setIsSubmittingName(false)
    }
  }

  useEffect(() => {
    if (!isUserReady || !currentUserName || currentUserName === 'Ali') return

    const migrateAli = async () => {
      try {
        const result = await apiFetch<{ success: boolean; message: string; migratedCount: number }>('/migrate/ali', {
          method: 'POST'
        })
        if (result.success) {
          console.log(`✓ Migration successful: ${result.message}`)
        }
      } catch {
        // Silent fail - Ali account might not exist or already migrated
      }
    }

    void migrateAli()
  }, [isUserReady, currentUserName])

  useEffect(() => {
    if (!isUserReady || !currentUserName) return

    void apiFetch('/telemetry', {
      method: 'POST',
      body: JSON.stringify({
        event: 'app_loaded',
        page: activePage,
        properties: { userName: currentUserName }
      })
    }).catch(() => undefined)
  }, [activePage, currentUserName, isUserReady])

  useEffect(() => {
    if (!isUserReady || !currentUserName) return

    let cancelled = false

    async function loadMyRatings() {
      setIsMyRatingsLoading(true)
      try {
        const response = await fetchWithRetry(
          () => apiFetch<{ ratings: RatingEntry[] }>(`/ratings?userName=${encodeURIComponent(currentUserName)}`),
          2
        )
        if (cancelled) return

        setMyEntries(response.ratings)

        const refreshKey = getGreennessRefreshKey(currentUserName)
        const hasRefreshed = localStorage.getItem(refreshKey) === '1'
        if (!hasRefreshed) {
          const refreshedEntries = await refreshGreennessForEntries(response.ratings, currentUserName, INITIAL_GREENSCORE_REFRESH_LIMIT)
          if (!cancelled) {
            setMyEntries((previous) => {
              const byId = new Map(previous.map((entry) => [entry.id, entry]))
              for (const refreshed of refreshedEntries) {
                byId.set(refreshed.id, refreshed)
              }
              return Array.from(byId.values())
            })
            localStorage.setItem(refreshKey, '1')
          }
        }
      } catch {
        if (!cancelled) {
          setMyEntries([])
        }
      } finally {
        if (!cancelled) {
          setIsMyRatingsLoading(false)
        }
      }
    }

    void loadMyRatings()
    return () => {
      cancelled = true
    }
  }, [isUserReady, currentUserName])

  useEffect(() => {
    if (!isUserReady || !currentUserName) return

    let cancelled = false

    async function loadFollowingList() {
      try {
        const response = await apiFetch<{ following: string[] }>('/follows/list')
        if (!cancelled) {
          setFollowingSet(new Set(response.following))
        }
      } catch (error) {
        console.error('Failed to load following list:', error)
      }
    }

    void loadFollowingList()
    return () => {
      cancelled = true
    }
  }, [isUserReady, currentUserName])

  useEffect(() => {
    const query = location.trim()

    if (locationDebounceRef.current !== null) {
      window.clearTimeout(locationDebounceRef.current)
      locationDebounceRef.current = null
    }

    if (query.length < 2) {
      setLocationSuggestions([])
      setIsLocationLookupPending(false)
      return
    }

    const normalizedQuery = query.toLowerCase()
    const cachedSuggestions = locationResultsCacheRef.current.get(normalizedQuery)
    if (cachedSuggestions) {
      setLocationSuggestions(cachedSuggestions)
      setIsLocationLookupPending(false)
      return
    }

    if (locationLookupInFlightRef.current.has(normalizedQuery)) {
      setIsLocationLookupPending(true)
      void locationLookupInFlightRef.current.get(normalizedQuery)?.then((results) => {
        setLocationSuggestions(results)
        setIsLocationLookupPending(false)
      })
      return
    }

    const lookupId = ++locationLookupSequenceRef.current
    const controller = new AbortController()
    setIsLocationLookupPending(true)

    const lookupTask = (async () => {
      try {
        const photonResponse = await fetch(
          `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=${LOCATION_RESULTS_LIMIT}&osm_tag=amenity:cafe&osm_tag=amenity:restaurant&osm_tag=amenity:fast_food&osm_tag=shop:coffee`,
          {
            signal: controller.signal,
            headers: {
              'Accept-Language': 'en'
            }
          }
        )

        let suggestionList: string[] = []

        if (photonResponse.ok) {
          const photonPayload = (await photonResponse.json()) as {
            features?: Array<{
              properties?: {
                name?: string
                city?: string
                state?: string
                country?: string
              }
            }>
          }

          suggestionList = (photonPayload.features || [])
            .map((feature) => {
              const name = String(feature.properties?.name || '').trim()
              const locality = String(feature.properties?.city || feature.properties?.state || feature.properties?.country || '').trim()
              if (name && locality) return `${name}, ${locality}`
              return name
            })
            .filter(Boolean)
        }

        if (suggestionList.length === 0) {
          const venueBiasedQuery = `${query} cafe restaurant coffee shop`
          const nominatimResponse = await fetch(
            `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=${LOCATION_RESULTS_LIMIT + 2}&addressdetails=1&namedetails=1&q=${encodeURIComponent(venueBiasedQuery)}`,
            {
              signal: controller.signal,
              headers: {
                'Accept-Language': 'en'
              }
            }
          )

          if (nominatimResponse.ok) {
            const payload = (await nominatimResponse.json()) as Array<{
              class?: string
              type?: string
              name?: string
              display_name: string
              address?: {
                city?: string
                town?: string
                village?: string
                state?: string
                country?: string
              }
            }>

            const venueTypes = new Set(['cafe', 'restaurant', 'fast_food', 'food_court', 'coffee', 'tea', 'bubble_tea'])

            suggestionList = payload
              .filter((item) => (item.class === 'amenity' || item.class === 'shop') && venueTypes.has(String(item.type || '')))
              .map((item) => {
                const placeName = String(item.name || '').trim()
                const locality = String(item.address?.city || item.address?.town || item.address?.village || item.address?.state || item.address?.country || '').trim()
                if (placeName && locality) return `${placeName}, ${locality}`
                if (placeName) return placeName
                return String(item.display_name || '').trim()
              })
              .filter(Boolean)
          }
        }

        const deduped = Array.from(new Set(suggestionList)).slice(0, LOCATION_RESULTS_LIMIT)
        locationResultsCacheRef.current.set(normalizedQuery, deduped)
        return deduped
      } catch {
        return []
      }
    })()

    locationLookupInFlightRef.current.set(normalizedQuery, lookupTask)

    locationDebounceRef.current = window.setTimeout(() => {
      void lookupTask.then((deduped) => {
        if (lookupId !== locationLookupSequenceRef.current) return
        setLocationSuggestions(deduped)
        setIsLocationLookupPending(false)
      }).finally(() => {
        locationLookupInFlightRef.current.delete(normalizedQuery)
      })
    }, LOCATION_LOOKUP_DEBOUNCE_MS)

    return () => {
      controller.abort()
      if (locationDebounceRef.current !== null) {
        window.clearTimeout(locationDebounceRef.current)
      }
    }
  }, [location])

  useEffect(() => {
    return () => {
      if (locationDebounceRef.current !== null) {
        window.clearTimeout(locationDebounceRef.current)
      }
      if (locationBlurTimeoutRef.current !== null) {
        window.clearTimeout(locationBlurTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (activePage !== 'explore') return

    let cancelled = false

    void fetchExploreData(true).catch(() => {
      // Keep UI stable if explore fetch fails.
    })

    const intervalId = window.setInterval(() => {
      if (cancelled) return
      void fetchExploreData(false).catch(() => {
        // Silent retry on next interval.
      })
    }, 7 * 24 * 60 * 60 * 1000)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [activePage])

  useEffect(() => {
    if (communityActiveTab !== 'recommendations' || !currentUserName || userFlavors.length === 0) {
      return
    }

    setIsLoadingSimilarUsers(true)
    setIsLoadingSimilarPlaces(true)

    Promise.all([
      apiFetch<{ similarUsers: Array<{ userName: string; flavors: string[]; matchScore: number }> }>(`/similar-users?userName=${encodeURIComponent(currentUserName)}`),
      apiFetch<{ similarPlaces: Array<{ location: string; flavors: string[]; matchScore: number }> }>(`/similar-places?flavors=${encodeURIComponent(userFlavors.join(','))}`)
    ])
      .then(([usersData, placesData]) => {
        setSimilarUsers(usersData.similarUsers)
        setSimilarPlaces(placesData.similarPlaces)
      })
      .catch((error) => {
        console.error('Failed to load similar users/places:', error)
        setSimilarUsers([])
        setSimilarPlaces([])
      })
      .finally(() => {
        setIsLoadingSimilarUsers(false)
        setIsLoadingSimilarPlaces(false)
      })
  }, [communityActiveTab, currentUserName, userFlavors])

  useEffect(() => {
    let mounted = true

    async function startCamera() {
      if (!navigator.mediaDevices?.getUserMedia) {
        if (mounted) {
          setCameraError('Camera API unavailable in this browser.')
          setCameraReady(false)
        }
        return
      }

      try {
        const stream = await Promise.race([
          navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' } }
          }),
          new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('Camera access timed out.')), API_REQUEST_TIMEOUT_MS))
        ])
        if (!mounted) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }

        cameraStreamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await Promise.race([
            videoRef.current.play(),
            new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('Camera start timed out.')), API_REQUEST_TIMEOUT_MS))
          ])
        }
        setCameraError('')
        setCameraReady(true)
      } catch {
        if (mounted) {
          setCameraError('Unable to access camera. You can still upload a photo or save without one.')
          setCameraReady(false)
        }
      }
    }

    if (isCameraModalOpen) {
      void startCamera()
    }

    return () => {
      mounted = false
      if (cameraStreamRef.current) {
        cameraStreamRef.current.getTracks().forEach((track) => track.stop())
        cameraStreamRef.current = null
      }
    }
  }, [isCameraModalOpen])

  useEffect(() => {
    function clearDragState() {
      setIsRatingDragActive(false)
      setIsEditRatingDragActive(false)
    }

    window.addEventListener('pointerup', clearDragState)
    window.addEventListener('pointercancel', clearDragState)

    return () => {
      window.removeEventListener('pointerup', clearDragState)
      window.removeEventListener('pointercancel', clearDragState)
    }
  }, [])

  useEffect(() => {
    if (!isPreferencesModalOpen) return

    async function loadPreferences() {
      try {
        const data = await apiFetch<{ flavors?: string[] }>('/preferences')
        if (data?.flavors) {
          setUserFlavors(data.flavors)
        }
      } catch (error) {
        console.error('Failed to load preferences:', error)
      }
    }

    loadPreferences()
  }, [isPreferencesModalOpen])

  useEffect(() => {
    if (!isUserReady || !currentUserName) return

    async function loadUserPreferences() {
      try {
        const data = await apiFetch<{ flavors?: string[] }>('/preferences')
        if (data?.flavors && Array.isArray(data.flavors)) {
          setUserFlavors(data.flavors)
        }
      } catch (error) {
        console.error('Failed to load user preferences on mount:', error)
      }
    }

    loadUserPreferences()
  }, [isUserReady, currentUserName])

  function updateRatingFromClick(starIndex: number, event: MouseEvent<HTMLButtonElement>) {
    const bounds = event.currentTarget.getBoundingClientRect()
    const clickX = event.clientX - bounds.left
    const step = clickX < bounds.width / 2 ? 0.5 : 1
    setCurrentRating((starIndex - 1) + step)
  }

  function getRatingFromPointer(starIndex: number, clientX: number, target: HTMLButtonElement) {
    const bounds = target.getBoundingClientRect()
    const pointerX = clientX - bounds.left
    const step = pointerX < bounds.width / 2 ? 0.5 : 1
    return (starIndex - 1) + step
  }

  function handleCurrentRatingPointer(starIndex: number, event: React.PointerEvent<HTMLButtonElement>) {
    setCurrentRating(getRatingFromPointer(starIndex, event.clientX, event.currentTarget))
  }

  function handleEditRatingPointer(starIndex: number, event: React.PointerEvent<HTMLButtonElement>) {
    setEditRating(getRatingFromPointer(starIndex, event.clientX, event.currentTarget))
  }

  function stopCameraAccess() {
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((track) => track.stop())
      cameraStreamRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
    setCameraReady(false)
  }

  async function processImage(dataUrl: string) {
    setMlStatus('Preparing image...')
    setMlCoveragePercent(null)
    setMlConfidencePercent(null)

    try {
      const optimizedDataUrl = await Promise.race([
        downscaleDataUrlImage(dataUrl),
        new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('Image processing timed out.')), IMAGE_PROCESS_TIMEOUT_MS))
      ])
      setPhotoDataUrl(optimizedDataUrl)
      if (isEditingEntry) {
        setEditEntryPhoto(optimizedDataUrl)
      }

      try {
        setMlStatus('Analyzing drink area...')
        const { score, statusMessage, coveragePercent, confidencePercent } = await Promise.race([
          analyzeGreennessFromDataUrl(optimizedDataUrl),
          new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('Greenness analysis timed out.')), IMAGE_PROCESS_TIMEOUT_MS))
        ])
        setMatchaGreenness(score)
        setMlStatus(statusMessage)
        setMlCoveragePercent(coveragePercent)
        setMlConfidencePercent(confidencePercent)
      } catch {
        setMatchaGreenness(0)
        setMlStatus('Image analysis timed out. You can still save and edit manually.')
        setMlCoveragePercent(null)
        setMlConfidencePercent(null)
      }
    } catch {
      setMatchaGreenness(0)
      setPhotoDataUrl('')
      setMlStatus('Image processing timed out. You can still save without a photo.')
      setMlCoveragePercent(null)
      setMlConfidencePercent(null)
    }
  }

  function captureFromCamera() {
    const video = videoRef.current
    if (!video || !cameraReady || video.videoWidth === 0 || video.videoHeight === 0) {
      return
    }

    const captureCanvas = document.createElement('canvas')
    captureCanvas.width = video.videoWidth
    captureCanvas.height = video.videoHeight
    const captureCtx = captureCanvas.getContext('2d')
    if (!captureCtx) {
      return
    }

    captureCtx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height)
    const dataUrl = captureCanvas.toDataURL('image/jpeg', 0.82)
    void processImage(dataUrl)
  }

  function retakeCameraPhoto() {
    setPhotoDataUrl('')
    setMatchaGreenness(null)
    setMlCoveragePercent(null)
    setMlConfidencePercent(null)
    setMlStatus('ML drink-area detector will load when you analyze a photo.')
  }

  function openPhotoLibrary() {
    const input = photoInputRef.current
    if (!input) {
      alert('Photo library is not ready yet. Please try again.')
      return
    }

    input.value = ''
    input.click()
    setIsUploadMenuOpen(false)
  }

  async function handlePhotoSelection(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

    stopCameraAccess()

    const reader = new FileReader()
    reader.onload = async (loadEvent) => {
      const dataUrl = String(loadEvent.target?.result || '')
      await processImage(dataUrl)
    }
    reader.readAsDataURL(file)
  }

  async function saveEntry() {
    if (!currentUserName) {
      alert('Please set your name before saving a rating.')
      return
    }

    if (currentRating < 0 || currentRating > 5) {
      alert('Rating must be between 0 and 5 stars.')
      return
    }

    setIsSavingEntry(true)
    const overlayShownAt = Date.now()
    try {
      const resolvedPhoto = photoDataUrl || noPhotoPlaceholderUrl
      const resolvedGreenness = matchaGreenness ?? 0

      let photoUrl = resolvedPhoto
      if (resolvedPhoto.startsWith('data:image/')) {
        try {
          const uploadRes = await apiFetch<{ url: string }>('/upload-image', {
            method: 'POST',
            body: JSON.stringify({ image: resolvedPhoto })
          })
          console.log('Image upload successful:', uploadRes.url)
          photoUrl = uploadRes.url
        } catch (error) {
          console.error('Image upload failed:', error)
          alert('Image upload failed. Using placeholder instead.')
          photoUrl = noPhotoPlaceholderUrl
        }
      }

      await apiFetch<{ rating: RatingEntry }>('/ratings', {
        method: 'POST',
        body: JSON.stringify({
          userName: currentUserName,
          photo: photoUrl,
          rating: currentRating,
          greenness: resolvedGreenness,
          location: location.trim(),
          thoughts: thoughts.trim(),
          flavorPreferences: ratingFlavorPrefs
        })
      })

      const updated = await apiFetch<{ ratings: RatingEntry[] }>(`/ratings?userName=${encodeURIComponent(currentUserName)}`)
      setMyEntries(updated.ratings)

      // Check for milestones
      const count = updated.ratings.length
      if (count === 1) {
        setMilestoneMessage('🎉 Your matcha journey starts here!')
        confetti({ duration: 1000, spread: 100 } as any)
      } else if (count === 10) {
        setMilestoneMessage('🏆 10 ratings! You\'re a true matcha enthusiast!')
        confetti({ duration: 1000, spread: 100 } as any)
      } else if (count === 25) {
        setMilestoneMessage('✨ 25 ratings! You\'re building an incredible collection!')
        confetti({ duration: 1000, spread: 100 } as any)
      } else if (count === 50) {
        setMilestoneMessage('🌟 50 ratings! You\'re a matcha connoisseur!')
        confetti({ duration: 1000, spread: 100 } as any)
      } else if (count === 100) {
        setMilestoneMessage('👑 100 ratings! You\'re a matcha legend!')
        confetti({ duration: 1000, spread: 100 } as any)
      }

      if (milestoneMessage) {
        setTimeout(() => setMilestoneMessage(''), 1000)
      }

      setCurrentRating(0)
      setRatingFlavorPrefs({ sweet: 0, nutty: 0, umami: 0, vegetal: 0, sugary: 0, astringent: 0, creamy: 0, floral: 0, earthy: 0, Chocolatey: 0, mellow: 0 })
      setLocation('')
      setThoughts('')
      setPhotoDataUrl('')
      if (photoInputRef.current) {
        photoInputRef.current.value = ''
      }
      setMatchaGreenness(null)
      setMlCoveragePercent(null)
      setMlConfidencePercent(null)
    } finally {
      const elapsed = Date.now() - overlayShownAt
      const minimumOverlayMs = 700
      if (elapsed < minimumOverlayMs) {
        await new Promise((resolve) => window.setTimeout(resolve, minimumOverlayMs - elapsed))
      }
      setIsSavingEntry(false)
    }
  }

  async function searchFriends(query: string) {
    setFriendQuery(query)
    if (!query.trim()) {
      setFriendSuggestions([])
      return
    }

    try {
      const response = await apiFetch<{ friends: Array<{ userName: string; placeCount: number }> }>(`/friends/search?q=${encodeURIComponent(query.trim())}`)
      console.log('Search response:', response)
      setFriendSuggestions(response.friends || [])
    } catch (error) {
      console.error('Search failed:', error)
      setFriendSuggestions([])
    }
  }

  async function fetchExploreData(showOverlay: boolean) {
    if (showOverlay) {
      setIsLoadingExplorePlaces(true)
    }

    try {
      const [placesResponse, usersResponse] = await Promise.all([
        apiFetch<{ places: ExplorePlace[] }>('/explore/places?limit=10'),
        apiFetch<{ users: ExploreUser[] }>('/explore/users?limit=50')
      ])
      setExplorePlaces(placesResponse.places)
      setExploreUsers(usersResponse.users)
    } finally {
      if (showOverlay) {
        setIsLoadingExplorePlaces(false)
      }
    }
  }

  async function openExplorePlaceRatings(placeName: string) {
    const trimmedPlace = placeName.trim()
    if (!trimmedPlace) return

    setSelectedExplorePlaceName(trimmedPlace)
    setSelectedExplorePlaceEntries([])
    setIsExplorePlaceModalOpen(true)
    setIsLoadingExplorePlaceEntries(true)

    try {
      const response = await apiFetch<ExplorePlaceRatingsResponse>(`/explore/places/${encodeURIComponent(trimmedPlace)}/ratings`)
      setSelectedExplorePlaceName(response.placeName || trimmedPlace)
      setSelectedExplorePlaceEntries(response.ratings)
    } catch {
      setSelectedExplorePlaceEntries([])
    } finally {
      setIsLoadingExplorePlaceEntries(false)
    }
  }

  function closeExplorePlaceRatings() {
    setIsExplorePlaceModalOpen(false)
    setSelectedExplorePlaceName('')
    setSelectedExplorePlaceEntries([])
    setIsLoadingExplorePlaceEntries(false)
  }

  async function openFriendRatings(friendName: string) {
    if (!friendName.trim()) return
    setSelectedFriend(friendName)
    setActivePage('friends')
    setIsFriendLogsExpanded(false)
    setFriendLogsSearchTerm('')

    setIsLoadingFriendRatings(true)
    const overlayShownAt = Date.now()
    try {
      const response = await apiFetch<{ friendName: string; ratings: RatingEntry[] }>(`/friends/${encodeURIComponent(friendName)}/ratings`)
      setFriendEntries(response.ratings)
    } finally {
      const elapsed = Date.now() - overlayShownAt
      const minimumOverlayMs = 500
      if (elapsed < minimumOverlayMs) {
        await new Promise((resolve) => window.setTimeout(resolve, minimumOverlayMs - elapsed))
      }
      setIsLoadingFriendRatings(false)
    }
  }

  function applyLocationSuggestion(value: string) {
    setLocation(value)
    setShowLocationSuggestions(false)
    setLocationSuggestions([])
  }

  function openEntryOverlay(entry: RatingEntry) {
    setSelectedEntryId(entry.id)
    setIsEditingEntry(false)
    setEditRating(entry.rating)
    setEditLocation(entry.location)
    setEditThoughts(entry.thoughts)

    setTimeout(() => {
      const element = document.querySelector(`[data-entry-id="${entry.id}"]`)
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    }, 0)
  }

  function startEntryEdit(entry: RatingEntry) {
    setSelectedEntryId(entry.id)
    setIsEditingEntry(true)
    setEditRating(entry.rating)
    setEditLocation(entry.location)
    setEditThoughts(entry.thoughts)
    setEditEntryPhoto(entry.photo)
  }

  async function saveEntryEdit(entryId: number) {
    if (!currentUserName) {
      alert('Unable to save without a user session.')
      return
    }

    setIsSavingEntry(true)
    const overlayShownAt = Date.now()
    try {
      let photoUrl = editEntryPhoto
      if (editEntryPhoto.startsWith('data:image/')) {
        try {
          const uploadRes = await apiFetch<{ url: string }>('/upload-image', {
            method: 'POST',
            body: JSON.stringify({ image: editEntryPhoto })
          })
          console.log('Image upload successful:', uploadRes.url)
          photoUrl = uploadRes.url
        } catch (error) {
          console.error('Image upload failed:', error)
          alert('Image upload failed. Using existing photo.')
        }
      }

      await apiFetch<{ rating: RatingEntry }>(`/ratings/${entryId}`, {
        method: 'PUT',
        body: JSON.stringify({
          userName: currentUserName,
          rating: editRating,
          location: editLocation.trim(),
          thoughts: editThoughts.trim(),
          photo: photoUrl
        })
      })

      const updated = await apiFetch<{ ratings: RatingEntry[] }>(`/ratings?userName=${encodeURIComponent(currentUserName)}`)
      setMyEntries(updated.ratings)
      setIsEditingEntry(false)
      setSelectedEntryId(null)
      setEditEntryPhoto('')
    } finally {
      const elapsed = Date.now() - overlayShownAt
      const minimumOverlayMs = 700
      if (elapsed < minimumOverlayMs) {
        await new Promise((resolve) => window.setTimeout(resolve, minimumOverlayMs - elapsed))
      }
      setIsSavingEntry(false)
    }
  }

  async function deleteEntry(entryId: number) {
    if (!currentUserName) return

    await apiFetch<{ deletedId: number }>(`/ratings/${entryId}?userName=${encodeURIComponent(currentUserName)}`, {
      method: 'DELETE'
    })

    setMyEntries((prev) => prev.filter((entry) => entry.id !== entryId))
    setIsEditingEntry(false)
    setSelectedEntryId(null)
    setMilestoneMessage('Entry removed from your log')
    setTimeout(() => setMilestoneMessage(''), 3000)
  }

  if (!isUserReady) {
    return (
      <main className="container py-5 login-page">
        {requiresManualName ? (
          <section className="card border-0 shadow-sm matcha-shell mx-auto" style={{ maxWidth: '28rem' }}>
            <div className="card-body p-3 p-md-4">
              <h1 className="h4 fw-bold text-success mb-2">Welcome to Sip &amp; Score</h1>
              <p className="text-muted mb-4">
                What's your name?
              </p>
              <input
                type="text"
                className="form-control mb-3"
                value={pendingUserName}
                onChange={(event) => setPendingUserName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && pendingUserName.trim()) {
                    event.preventDefault()
                    void handleNewUserNameSubmit()
                  }
                }}
                placeholder="Enter your name"
                autoFocus
              />
              <button
                type="button"
                className="btn btn-success w-100"
                onClick={() => void handleNewUserNameSubmit()}
                disabled={!pendingUserName.trim() || isSubmittingName}
              >
                {isSubmittingName ? 'Creating account…' : 'Continue'}
              </button>
              <button
                type="button"
                className="btn btn-outline-secondary w-100 mt-2"
                onClick={() => {
                  sessionStorage.removeItem('googleAccessToken')
                  setRequiresManualName(false)
                  setPendingUserName('')
                  setAuthError('')
                }}
              >
                Start Over
              </button>
              {authError && <div className="alert alert-danger border mt-3 mb-0">{authError}</div>}
            </div>
          </section>
        ) : authMode === 'choice' ? (
          <section className="card border-0 shadow-sm matcha-shell mx-auto" style={{ maxWidth: '28rem' }}>
            <div className="card-body p-3 p-md-4">
              <div className="text-center mb-4">
                <div className="matcha-logo" style={{ fontSize: '4rem', marginBottom: '1rem', display: 'inline-block' }}>🍵</div>
                <h1 className="h3 fw-bold text-success mb-2">Sip &amp; Score</h1>
                <p className="text-muted small">Track your matcha journey, one sip at a time</p>
              </div>
              <p className="text-muted mb-4 text-center small">
                Whether you're a matcha enthusiant or just starting, let's rate every tea experience together.
              </p>
              <button
                type="button"
                className="btn btn-success w-100 mb-2 fw-semibold"
                onClick={() => setAuthMode('signin')}
                style={{ padding: '0.875rem 1rem', fontSize: '1.05rem' }}
              >
                I already have an account
              </button>
              <button
                type="button"
                className="btn btn-outline-success w-100 fw-semibold"
                onClick={() => setAuthMode('newuser')}
                style={{ padding: '0.875rem 1rem', fontSize: '1.05rem' }}
              >
                I'm new here
              </button>
            </div>
          </section>
        ) : authMode === 'signin' ? (
          <section className="card border-0 shadow-sm matcha-shell mx-auto" style={{ maxWidth: '28rem' }}>
            <div className="card-body p-3 p-md-4">
              <div className="text-center mb-4">
                <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>🍵</div>
                <h1 className="h4 fw-bold text-success mb-1">Welcome back</h1>
              </div>
              <p className="text-muted mb-4 text-center small">
                Sign in with Google to access your ratings
              </p>
              <button
                type="button"
                className="btn btn-light w-100 d-flex align-items-center justify-content-center gap-2 mb-3"
                onClick={() => googleLogin()}
                disabled={isSubmittingName}
                style={{ border: '1px solid #e0e0e0', padding: '0.875rem' }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24">
                  <text x="2" y="16" fontSize="14" fill="#1f5f34">G</text>
                </svg>
                {isSubmittingName ? 'Signing in…' : 'Sign in with Google'}
              </button>
              <button
                type="button"
                className="btn btn-link text-muted w-100 p-0 small"
                onClick={() => {
                  setAuthMode('choice')
                  setAuthError('')
                }}
              >
                ← Back
              </button>
              {authError && <div className="alert alert-danger border mt-3 mb-0 small">{authError}</div>}
            </div>
          </section>
        ) : authMode === 'newuser' ? (
          <section className="card border-0 shadow-sm matcha-shell mx-auto" style={{ maxWidth: '28rem' }}>
            <div className="card-body p-3 p-md-4">
              <div className="text-center mb-4">
                <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>🍵</div>
                <h1 className="h4 fw-bold text-success mb-1">Let's begin</h1>
              </div>
              <p className="text-muted mb-4 text-center small">
                Sign up with Google to start rating matcha
              </p>
              <button
                type="button"
                className="btn btn-light w-100 d-flex align-items-center justify-content-center gap-2 mb-3"
                onClick={() => googleLogin()}
                disabled={isSubmittingName}
                style={{ border: '1px solid #e0e0e0', padding: '0.875rem' }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24">
                  <text x="2" y="16" fontSize="14" fill="#1f5f34">G</text>
                </svg>
                {isSubmittingName ? 'Signing up…' : 'Sign up with Google'}
              </button>
              <button
                type="button"
                className="btn btn-link text-muted w-100 p-0 small"
                onClick={() => {
                  setAuthMode('choice')
                  setAuthError('')
                }}
              >
                ← Back
              </button>
              {authError && <div className="alert alert-danger border mt-3 mb-0 small">{authError}</div>}
            </div>
          </section>
        ) : authMode === 'confirm-account' ? (
          <section className="card border-0 shadow-sm matcha-shell mx-auto" style={{ maxWidth: '28rem' }}>
            <div className="card-body p-3 p-md-4">
              <div className="text-center mb-4">
                <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>🍵</div>
                <h1 className="h4 fw-bold text-success mb-1">Is this you?</h1>
              </div>
              <p className="text-muted mb-4 text-center small">
                We found existing account(s). Which one is yours?
              </p>
              <div className="d-flex flex-column gap-2">
                {potentialAccounts.map((account) => (
                  <button
                    key={account}
                    type="button"
                    className={`btn w-100 ${selectedPotentialAccount === account ? 'btn-success' : 'btn-outline-success'}`}
                    onClick={() => setSelectedPotentialAccount(account)}
                  >
                    @{account}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="btn btn-success w-100 mt-3"
                onClick={async () => {
                  if (!selectedPotentialAccount) {
                    setAuthError('Please select an account')
                    return
                  }
                  try {
                    setIsSubmittingName(true)
                    setAuthError('')
                    const googleAccessToken = sessionStorage.getItem('googleAccessToken') || ''
                    const response = await apiFetch<{ userName: string; email: string; token: string }>('/auth/google/confirm-account', {
                      method: 'POST',
                      body: JSON.stringify({ token: googleAccessToken, browserId, confirmedUserName: selectedPotentialAccount })
                    })
                    setSessionToken(response.token || '')
                    localStorage.setItem('matchaUserName', response.userName)
                    setCurrentUserName(response.userName)
                    setRequiresManualName(false)
                    setIsUserReady(true)
                    setWelcomeMessage(response.userName)
                    setTimeout(() => setWelcomeMessage(''), 1500)
                    void loadRandomForest().catch(() => undefined)
                  } catch (error) {
                    setAuthError(error instanceof Error ? error.message : 'Account linking failed')
                  } finally {
                    setIsSubmittingName(false)
                  }
                }}
                disabled={!selectedPotentialAccount || isSubmittingName}
              >
                {isSubmittingName ? 'Linking…' : 'Link this account'}
              </button>
              <button
                type="button"
                className="btn btn-link text-muted w-100 p-0 small mt-2"
                onClick={() => {
                  setAuthMode('newuser')
                  setSelectedPotentialAccount(null)
                  setPotentialAccounts([])
                  setAuthError('')
                }}
              >
                This isn't me, create new account
              </button>
              {authError && <div className="alert alert-danger border mt-3 mb-0 small">{authError}</div>}
            </div>
          </section>
        ) : authMode === 'magic-link' ? (
          <section className="card border-0 shadow-sm matcha-shell mx-auto" style={{ maxWidth: '28rem' }}>
            <div className="card-body p-3 p-md-4">
              <div className="text-center mb-4">
                <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>✉️</div>
                <h1 className="h4 fw-bold text-success mb-1">{isMagicLinkSent ? 'Check your email' : 'Email magic link'}</h1>
              </div>
              {!isMagicLinkSent ? (
                <>
                  <p className="text-muted mb-4 text-center small">
                    We'll send you a link to sign in or create an account
                  </p>
                  <form onSubmit={async (e) => {
                    e.preventDefault()
                    if (!pendingMagicEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pendingMagicEmail)) {
                      setAuthError('Please enter a valid email')
                      return
                    }
                    try {
                      setIsSubmittingName(true)
                      setAuthError('')
                      const response = await apiFetch<{ ok: boolean; mode?: string }>('/auth/request-link', {
                        method: 'POST',
                        body: JSON.stringify({ email: pendingMagicEmail, userName: pendingUserName })
                      })

                      if (response.mode === 'needs-username') {
                        setAuthError('')
                        setPendingUserName('')
                        setAuthMode('magic-link-username')
                      } else {
                        setIsMagicLinkSent(true)
                      }
                    } catch (error) {
                      setAuthError(error instanceof Error ? error.message : 'Failed to send magic link')
                    } finally {
                      setIsSubmittingName(false)
                    }
                  }}>
                    <input
                      type="email"
                      className="form-control mb-3"
                      value={pendingMagicEmail}
                      onChange={(e) => setPendingMagicEmail(e.target.value)}
                      placeholder="you@example.com"
                      autoFocus
                    />
                    <button
                      type="submit"
                      className="btn btn-success w-100"
                      disabled={!pendingMagicEmail || isSubmittingName}
                    >
                      {isSubmittingName ? 'Sending…' : 'Send link'}
                    </button>
                  </form>
                  <button
                    type="button"
                    className="btn btn-link text-muted w-100 p-0 small mt-3"
                    onClick={() => {
                      setAuthMode('choice')
                      setAuthError('')
                      setPendingMagicEmail('')
                    }}
                  >
                    ← Back
                  </button>
                </>
              ) : (
                <>
                  <p className="text-muted mb-4 text-center small">
                    We've sent a link to <strong>{pendingMagicEmail}</strong>. Click it to sign up.
                  </p>
                  <button
                    type="button"
                    className="btn btn-outline-success w-100"
                    onClick={() => {
                      setIsMagicLinkSent(false)
                      setPendingMagicEmail('')
                      setAuthError('')
                    }}
                  >
                    Didn't receive it? Try again
                  </button>
                </>
              )}
              <button
                type="button"
                className="btn btn-link text-muted w-100 p-0 small mt-3"
                onClick={() => {
                  setAuthMode('choice')
                  setIsMagicLinkSent(false)
                  setPendingMagicEmail('')
                  setAuthError('')
                }}
              >
                ← Back
              </button>
              {authError && <div className="alert alert-danger border mt-3 mb-0 small">{authError}</div>}
            </div>
          </section>
        ) : authMode === 'magic-link-username' ? (
          <section className="card border-0 shadow-sm matcha-shell mx-auto" style={{ maxWidth: '28rem' }}>
            <div className="card-body p-3 p-md-4">
              <div className="text-center mb-4">
                <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>🍵</div>
                <h1 className="h4 fw-bold text-success mb-1">Create your account</h1>
              </div>
              <p className="text-muted mb-4 text-center small">
                Choose a username for your new account
              </p>
              <form onSubmit={async (e) => {
                e.preventDefault()
                if (!pendingUserName.trim()) {
                  setAuthError('Please enter a username')
                  return
                }
                try {
                  setIsSubmittingName(true)
                  setAuthError('')
                  await apiFetch<{ ok: boolean }>('/auth/request-link', {
                    method: 'POST',
                    body: JSON.stringify({ email: pendingMagicEmail, userName: pendingUserName.trim() })
                  })
                  setIsMagicLinkSent(true)
                  setAuthMode('magic-link')
                } catch (error) {
                  setAuthError(error instanceof Error ? error.message : 'Failed to send magic link')
                } finally {
                  setIsSubmittingName(false)
                }
              }}>
                <input
                  type="text"
                  className="form-control mb-3"
                  value={pendingUserName}
                  onChange={(e) => setPendingUserName(e.target.value)}
                  placeholder="your username"
                  autoFocus
                />
                <button
                  type="submit"
                  className="btn btn-success w-100"
                  disabled={!pendingUserName.trim() || isSubmittingName}
                >
                  {isSubmittingName ? 'Sending…' : 'Send link'}
                </button>
              </form>
              <button
                type="button"
                className="btn btn-link text-muted w-100 p-0 small mt-3"
                onClick={() => {
                  setAuthMode('magic-link')
                  setPendingUserName('')
                  setAuthError('')
                }}
              >
                ← Back
              </button>
              {authError && <div className="alert alert-danger border mt-3 mb-0 small">{authError}</div>}
            </div>
          </section>
        ) : (
          <section className="card border-0 shadow-sm matcha-shell mx-auto" style={{ maxWidth: '28rem' }}>
            <div className="card-body p-3 p-md-4">
              <div className="text-center mb-4">
                <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>🍵</div>
                <h1 className="h4 fw-bold text-success mb-1">Choose your name</h1>
              </div>
              <p className="text-muted mb-4 text-center small">
                What would you like to be called?
              </p>
              <form onSubmit={async (e) => {
                e.preventDefault()
                const name = pendingUserName.trim()
                if (!name) {
                  setAuthError('Please enter a name')
                  return
                }
                try {
                  setIsSubmittingName(true)
                  setAuthError('')
                  const googleAccessToken = sessionStorage.getItem('googleAccessToken') || ''
                  const response = await apiFetch<{ userName: string; email: string; token: string }>('/auth/google/verify', {
                    method: 'POST',
                    body: JSON.stringify({ token: googleAccessToken, browserId, userName: name })
                  })
                  setSessionToken(response.token || '')
                  localStorage.setItem('matchaUserName', response.userName)
                  setCurrentUserName(response.userName)
                  setRequiresManualName(false)
                  setIsUserReady(true)
                  setWelcomeMessage(response.userName)
                  setPendingUserName('')
                  setTimeout(() => setWelcomeMessage(''), 1500)
                  void loadRandomForest().catch(() => undefined)
                } catch (error) {
                  setAuthError(error instanceof Error ? error.message : 'Failed to create account')
                } finally {
                  setIsSubmittingName(false)
                }
              }}>
                <input
                  type="text"
                  className="form-control mb-3"
                  placeholder="Enter your name"
                  value={pendingUserName}
                  onChange={(e) => setPendingUserName(e.target.value)}
                  disabled={isSubmittingName}
                  autoFocus
                />
                <button
                  type="submit"
                  className="btn btn-success w-100 mb-2"
                  disabled={isSubmittingName || !pendingUserName.trim()}
                  style={{ padding: '0.875rem' }}
                >
                  {isSubmittingName ? 'Creating account…' : 'Continue'}
                </button>
              </form>
              <button
                type="button"
                className="btn btn-link text-muted w-100 p-0 small"
                onClick={() => {
                  setAuthMode('choice')
                  setPendingUserName('')
                  setAuthError('')
                }}
              >
                ← Back
              </button>
              {authError && <div className="alert alert-danger border mt-3 mb-0 small">{authError}</div>}
            </div>
          </section>
        )}
      </main>
    )
  }

  return (
    <>
      <a className="skip-link" href="#main-content">Skip to content</a>

      {welcomeMessage && createPortal(
        <div className="welcome-toast">
          <div>☕ Welcome back, {welcomeMessage}!</div>
        </div>,
        document.body
      )}

      {showLoadingOverlay && createPortal(
        <div className="saving-overlay" role="status" aria-live="polite" aria-label={loadingOverlayText}>
          <div className="saving-card">
            <div className="matcha-cup" aria-hidden="true">
              <div className="cup-straw" />
              <div className="cup-dome" />
              <div className="cup-lid" />
              <div className="cup-body">
                <div className="cup-liquid" />
                <div className="cup-liquid-surface" />
                <div className="cup-highlight" />
                <div className="boba-pearls" />
              </div>
            </div>
            <div className="saving-text">{loadingOverlayText}</div>
          </div>
        </div>,
        document.body
      )}

      {milestoneMessage && createPortal(
        <div className="milestone-toast" role="status" aria-live="polite">
          <div className="milestone-toast-content">{milestoneMessage}</div>
        </div>,
        document.body
      )}

      {showOnboarding && createPortal(
        <div className="onboarding-overlay">
          <div className="onboarding-modal" onClick={(e) => e.stopPropagation()}>
            <div className="onboarding-slides">
              {currentOnboardingSlide === 0 && (
                <div className="onboarding-slide">
                  <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>🍵</div>
                  <h2 className="fw-bold text-success mb-3">Welcome to Sip & Score</h2>
                  <p className="text-muted mb-4">Track your matcha journey, one sip at a time. Rate experiences, discover favorites, and connect with the community.</p>
                </div>
              )}
              {currentOnboardingSlide === 1 && (
                <div className="onboarding-slide">
                  <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>📝</div>
                  <h2 className="fw-bold text-success mb-3">Log Your Ratings</h2>
                  <p className="text-muted mb-4">Click "New Log" to rate matcha drinks. Capture photos, note flavors, and track your impressions for each location.</p>
                </div>
              )}
              {currentOnboardingSlide === 2 && (
                <div className="onboarding-slide">
                  <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>📊</div>
                  <h2 className="fw-bold text-success mb-3">Track Your Metrics</h2>
                  <p className="text-muted mb-4">See greenness scores, ratings, and total scores. Watch your personal statistics grow as you explore.</p>
                </div>
              )}
              {currentOnboardingSlide === 3 && (
                <div className="onboarding-slide">
                  <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>🌍</div>
                  <h2 className="fw-bold text-success mb-3">Explore</h2>
                  <p className="text-muted mb-4">Check out top-rated places and leaderboards. See what other matcha enthusiasts have discovered.</p>
                </div>
              )}
              {currentOnboardingSlide === 4 && (
                <div className="onboarding-slide">
                  <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>✨</div>
                  <h2 className="fw-bold text-success mb-3">You're Ready!</h2>
                  <p className="text-muted mb-4">Start exploring and rating matcha. Build your collection and join the community.</p>
                </div>
              )}
            </div>

            <div className="onboarding-dots">
              {[0, 1, 2, 3, 4].map((i) => (
                <button
                  key={i}
                  className={`onboarding-dot ${i === currentOnboardingSlide ? 'active' : ''}`}
                  onClick={() => setCurrentOnboardingSlide(i)}
                  aria-label={`Slide ${i + 1}`}
                />
              ))}
            </div>

            <div className="onboarding-nav">
              <button
                className="btn btn-outline-secondary"
                onClick={() => setShowOnboarding(false)}
                disabled={currentOnboardingSlide === 0}
              >
                ← Back
              </button>
              <button
                className="btn btn-link text-muted p-0"
                onClick={() => {
                  setShowOnboarding(false)
                  localStorage.setItem('onboardingShown', 'true')
                }}
              >
                Skip
              </button>
              {currentOnboardingSlide === 4 ? (
                <button
                  className="btn btn-success"
                  onClick={() => {
                    setShowOnboarding(false)
                    localStorage.setItem('onboardingShown', 'true')
                  }}
                >
                  Get Started
                </button>
              ) : (
                <button
                  className="btn btn-success"
                  onClick={() => setCurrentOnboardingSlide(currentOnboardingSlide + 1)}
                >
                  Next →
                </button>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      <input
        id="photo-library-input"
        ref={photoInputRef}
        type="file"
        className="photo-library-input"
        accept="image/*"
        onChange={handlePhotoSelection}
        tabIndex={-1}
        aria-hidden="true"
      />

      {isExplorePlaceModalOpen && createPortal(
        <div className="explore-place-modal-overlay" role="dialog" aria-modal="true" aria-label={`${selectedExplorePlaceName} ratings`}>
          <div className="explore-place-modal card border-0 shadow-lg">
            <div className="card-body p-3 p-md-4">
              <div className="d-flex align-items-start gap-3 mb-3">
                <div style={{ minWidth: 0 }}>
                  <h3 className="h5 fw-bold text-success mb-1" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{selectedExplorePlaceName}</h3>
                  <div className="small text-muted">All ratings</div>
                </div>
                <button
                  type="button"
                  className="close-btn"
                  onClick={closeExplorePlaceRatings}
                  aria-label="Close place ratings popup"
                  style={{ marginLeft: 'auto', flexShrink: 0 }}
                >
                  ✕
                </button>
              </div>

              {isLoadingExplorePlaceEntries && (
                <div className="alert alert-light border mb-0">Loading place ratings...</div>
              )}

              {!isLoadingExplorePlaceEntries && selectedExplorePlaceEntries.length === 0 && (
                <div className="alert alert-light border mb-0">No ratings found for this place yet.</div>
              )}

              {!isLoadingExplorePlaceEntries && selectedExplorePlaceEntries.length > 0 && (
                <div className="d-flex flex-column gap-2 explore-place-modal-list">
                  {selectedExplorePlaceEntries.map((entry, index) => (
                    <article key={`place-rating-${entry.id}-${index}`} className="card border-0 shadow-sm">
                      <div className="card-body d-flex gap-3 align-items-start py-2">
                        <img src={entry.photo} alt="Matcha" className="entry-thumb" loading="lazy" decoding="async" />
                        <div className="flex-grow-1">
                          <div className="d-flex justify-content-between flex-wrap gap-2">
                            <strong>{entry.userName}</strong>
                            <span className="text-muted small">{entry.date}</span>
                          </div>
                          <div className="small text-muted mb-1">{entry.location || selectedExplorePlaceName}</div>
                          <div className="entry-metrics">
                            <div className="fw-bold mb-2">Taste rating: {entry.rating.toFixed(1)} / 5.0</div>
                            <div className="mb-2">Greenness: {entry.greenness.toFixed(1)} / 100.0</div>
                            <div className="fw-bold mb-2">Total score: {getWeightedScore(entry.rating, entry.greenness).toFixed(1)} / 200.0</div>
                            <div style={{ color: '#6c757d', marginBottom: '0.5rem', fontWeight: 'normal' }}>Matcha greenness: {entry.greenness.toFixed(1)} / 100.0</div>
                            {entry.flavorPreferences && Object.entries(entry.flavorPreferences).some(([_, v]) => v > 0) && (
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginTop: '0.5rem' }}>
                                {Object.entries(entry.flavorPreferences).map(([flavor, intensity]) =>
                                  intensity > 0 ? (
                                    <span
                                      key={flavor}
                                      className="badge"
                                      style={{
                                        fontSize: '0.65rem',
                                        background: 'linear-gradient(135deg, rgba(32, 201, 151, 0.3) 0%, rgba(0, 0, 0, 0.3) 100%)',
                                        backdropFilter: 'blur(10px)',
                                        border: '1px solid rgba(32, 201, 151, 0.5)',
                                        color: '#20c997',
                                        textTransform: 'capitalize',
                                        padding: '0.2rem 0.4rem',
                                        textAlign: 'center',
                                        whiteSpace: 'nowrap'
                                      }}
                                    >
                                      {flavor}
                                    </span>
                                  ) : null
                                )}
                              </div>
                            )}
                          </div>
                          {entry.thoughts && <p className="mt-1 mb-0">{entry.thoughts}</p>}
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      {isUploadMenuOpen && createPortal(
        <div className="upload-menu-overlay" role="dialog" aria-modal="true" aria-label="Upload picture options" onClick={() => setIsUploadMenuOpen(false)}>
          <div className="upload-menu-card card border-0 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <div className="card-body p-3">
              <h3 className="h5 fw-bold text-success mb-4">Choose Photo</h3>

              <button
                type="button"
                className="btn btn-success w-100 text-start"
                onClick={openPhotoLibrary}
              >
                Photo Album
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {isMyRatingsFilterOpen && createPortal(
        <div className="filter-menu-overlay" role="dialog" aria-modal="true" aria-label="Filter ratings" onClick={() => setIsMyRatingsFilterOpen(false)}>
          <div className="filter-menu-card card border-0 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <div className="card-body p-3">
              <div className="filter-menu-header">
                <p className="text-secondary small fw-normal">Sort list by</p>
                <button
                  type="button"
                  className="close-btn"
                  onClick={() => setIsMyRatingsFilterOpen(false)}
                  aria-label="Close filter menu"
                >
                  ✕
                </button>
              </div>
              
              <div className="d-flex flex-column gap-2">
                <button
                  type="button"
                  className="btn btn-success btn-sm w-100 text-start"
                  onClick={() => {
                    setMyRatingsSort('highest')
                    setIsMyRatingsFilterOpen(false)
                  }}
                >
                  Total Score
                </button>
                <button
                  type="button"
                  className="btn btn-success btn-sm w-100 text-start"
                  onClick={() => {
                    setMyRatingsSort('greenest')
                    setIsMyRatingsFilterOpen(false)
                  }}
                >
                  Greenness score
                </button>
                <button
                  type="button"
                  className="btn btn-success btn-sm w-100 text-start"
                  onClick={() => {
                    setMyRatingsSort('newest')
                    setIsMyRatingsFilterOpen(false)
                  }}
                >
                  Date added
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {isFriendFilterOpen && createPortal(
        <div className="filter-menu-overlay" role="dialog" aria-modal="true" aria-label="Filter friend ratings" onClick={() => setIsFriendFilterOpen(false)}>
          <div className="filter-menu-card card border-0 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <div className="card-body p-3">
              <div className="filter-menu-header">
                <p className="text-secondary small fw-normal">Sort list by</p>
                <button
                  type="button"
                  className="close-btn"
                  onClick={() => setIsFriendFilterOpen(false)}
                  aria-label="Close filter menu"
                >
                  ✕
                </button>
              </div>
              
              <div className="d-flex flex-column gap-2">
                <button
                  type="button"
                  className="btn btn-success btn-sm w-100 text-start"
                  onClick={() => {
                    setFriendSort('highest')
                    setIsFriendFilterOpen(false)
                  }}
                >
                  Total Score
                </button>
                <button
                  type="button"
                  className="btn btn-success btn-sm w-100 text-start"
                  onClick={() => {
                    setFriendSort('greenest')
                    setIsFriendFilterOpen(false)
                  }}
                >
                  Greenness score
                </button>
                <button
                  type="button"
                  className="btn btn-success btn-sm w-100 text-start"
                  onClick={() => {
                    setFriendSort('newest')
                    setIsFriendFilterOpen(false)
                  }}
                >
                  Date added
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {isCameraModalOpen && createPortal(
        <div className="camera-modal-overlay" role="dialog" aria-modal="true" aria-label="Camera capture">
          <div className="camera-modal-container card border-0 shadow-lg">
            <div className="camera-modal-header d-flex justify-content-between align-items-center mb-2">
              <h3 className="h5 fw-bold text-success mb-0">Take Photo</h3>
              <button
                type="button"
                className="close-btn"
                onClick={() => {
                  setIsCameraModalOpen(false)
                  stopCameraAccess()
                }}
                aria-label="Close camera"
              >
                ✕
              </button>
            </div>

            {cameraError && (
              <div className="alert alert-danger border mb-2">{cameraError}</div>
            )}

            <div className="camera-modal-content">
              {!photoDataUrl && (
                <>
                  <div className="camera-wrap">
                    <video ref={videoRef} className="camera-video" autoPlay playsInline muted />
                  </div>

                  <div className="d-flex gap-2 justify-content-center flex-wrap">
                    <button
                      type="button"
                      className="btn btn-success"
                      onClick={captureFromCamera}
                      disabled={!cameraReady}
                    >
                      Capture Photo
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline-secondary"
                      onClick={() => {
                        setIsCameraModalOpen(false)
                        stopCameraAccess()
                      }}
                    >
                      Close
                    </button>
                  </div>
                </>
              )}

              {photoDataUrl && (
                <div className="camera-modal-preview">
                  <h4 className="small fw-semibold text-success mb-2">Photo Preview</h4>
                  <img src={photoDataUrl} alt="Captured preview" className="preview-image mb-2" />
                  <div className="d-flex gap-2">
                    <button
                      type="button"
                      className="btn btn-success flex-grow-1"
                      onClick={() => setIsCameraModalOpen(false)}
                    >
                      Use Photo
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline-success"
                      onClick={retakeCameraPhoto}
                    >
                      Retake
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      {isNotesModalOpen && createPortal(
        <div className="notes-modal-overlay" role="dialog" aria-modal="true" aria-label="Edit notes">
          <div className="notes-modal card border-0 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <div className="notes-modal-header d-flex align-items-center p-4 border-bottom" style={{ flexWrap: 'nowrap' }}>
              <h3 className="h5 fw-bold text-success mb-0" style={{ flexShrink: 0 }}>Your thoughts...</h3>
              <button
                type="button"
                className="close-btn"
                onClick={() => setIsNotesModalOpen(false)}
                aria-label="Close notes"
              >
                ✕
              </button>
            </div>
            <div className="notes-modal-body p-4">
              <p className="small text-muted mb-3">What stood out about this matcha? Flavor, texture, experience...</p>
              <textarea
                className="form-control"
                rows={10}
                placeholder="Share your thoughts..."
                value={thoughts}
                onChange={(event) => setThoughts(event.target.value)}
                autoFocus
              />
            </div>
            <div className="notes-modal-footer p-4 border-top d-flex gap-2">
              <button
                type="button"
                className="btn btn-success flex-grow-1"
                onClick={() => setIsNotesModalOpen(false)}
              >
                Done
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {isChangeEmailDrawerOpen && createPortal(
        <>
          <div
            className="modal-overlay"
            onClick={() => setIsChangeEmailDrawerOpen(false)}
            style={{ zIndex: 1040 }}
          />
          <div
            className="profile-drawer"
            style={{
              position: 'fixed',
              right: 0,
              top: 0,
              height: '100vh',
              width: '280px',
              maxWidth: '100vw',
              backgroundColor: 'white',
              boxShadow: '-2px 0 8px rgba(0,0,0,0.1)',
              zIndex: 1050,
              display: 'flex',
              flexDirection: 'column'
            }}
          >
            <div style={{ padding: '0.75rem', borderBottom: '1px solid #e9ecef' }}>
              <button
                type="button"
                className="close-btn"
                onClick={() => setIsChangeEmailDrawerOpen(false)}
                style={{ float: 'right' }}
              >
                ✕
              </button>
              <h6 className="fw-bold text-success mb-0">Change Email</h6>
            </div>

            <div style={{ padding: '1rem' }}>
              <div className="mb-3">
                <label className="form-label fw-semibold">Email Address</label>
                <input
                  type="email"
                  className="form-control"
                  placeholder="Enter new email"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                />
              </div>

              <button
                type="button"
                className="btn btn-success w-100"
                onClick={async () => {
                  if (!newEmail.trim()) {
                    alert('Please enter an email')
                    return
                  }
                  try {
                    await apiFetch('/account/email', {
                      method: 'POST',
                      body: JSON.stringify({ newEmail })
                    })
                    setNewEmail('')
                    setIsChangeEmailDrawerOpen(false)
                    alert('Email updated!')
                  } catch (error) {
                    alert(error instanceof Error ? error.message : 'Failed to update email')
                  }
                }}
              >
                Save
              </button>
            </div>
          </div>
        </>,
        document.body
      )}

      {isProfileDrawerOpen && createPortal(
        <>
          <div
            className="modal-overlay"
            onClick={() => setIsProfileDrawerOpen(false)}
            style={{ zIndex: 1040 }}
          />
          <div
            className="profile-drawer"
            style={{
              position: 'fixed',
              right: 0,
              top: 0,
              height: '100vh',
              width: '280px',
              maxWidth: '100vw',
              backgroundColor: 'white',
              boxShadow: '-2px 0 8px rgba(0,0,0,0.1)',
              zIndex: 1050,
              display: 'flex',
              flexDirection: 'column'
            }}
          >
            <div style={{ padding: '0.75rem', borderBottom: '1px solid #e9ecef', flexShrink: 0 }}>
              <button
                type="button"
                className="close-btn"
                onClick={() => setIsProfileDrawerOpen(false)}
                style={{ float: 'right' }}
              >
                ✕
              </button>
              <h6 className="fw-bold text-success mb-0">{currentUserName}</h6>
            </div>

            <div style={{ padding: '0.75rem', borderBottom: '1px solid #e9ecef', flexShrink: 0 }}>
              <button
                type="button"
                className="btn btn-link btn-sm text-start p-0 w-100"
                onClick={() => setIsChangeEmailDrawerOpen(true)}
                style={{ textDecoration: 'none', color: '#198754' }}
              >
                Change Email
              </button>
            </div>

            <div style={{ padding: '0.75rem', borderBottom: '1px solid #e9ecef', flexShrink: 0 }}>
              <button
                type="button"
                className="btn btn-link btn-sm text-start p-0 w-100"
                onClick={() => setIsPreferencesModalOpen(true)}
                style={{ textDecoration: 'none', color: '#198754' }}
              >
                My Matcha Preferences
              </button>
            </div>

            <div style={{ padding: '0.75rem', borderBottom: '1px solid #e9ecef', flexShrink: 0 }}>
              <button
                type="button"
                className="btn btn-link btn-sm text-start p-0 w-100"
                onClick={async () => {
                  const shareLink = 'https://allyyim.github.io/matchaRatings/'
                  const shareData = {
                    title: 'Sip & Score',
                    text: 'Check out Sip & Score - an app for rating matcha and exploring matcha places!',
                    url: shareLink
                  }

                  if (navigator.share) {
                    try {
                      await navigator.share(shareData)
                    } catch (err) {
                      if (err instanceof Error && err.name !== 'AbortError') {
                        console.error('Share failed:', err)
                      }
                    }
                  } else {
                    await navigator.clipboard.writeText(shareData.url)
                    alert('App link copied to clipboard!')
                  }
                }}
                style={{ textDecoration: 'none', color: '#198754' }}
              >
                Share App
              </button>
            </div>

            <div style={{ padding: '0.75rem', borderBottom: '1px solid #e9ecef', flexShrink: 0 }}>
              <button
                type="button"
                className="btn btn-link btn-sm text-start p-0 w-100"
                onClick={() => setIsPrivacyPolicyModalOpen(true)}
                style={{ textDecoration: 'none', color: '#198754' }}
              >
                Privacy Policy
              </button>
            </div>

            <div style={{ padding: '0.75rem', flexShrink: 0 }}>
              <button
                type="button"
                className="btn btn-link btn-sm text-start p-0 w-100"
                onClick={() => {
                  signOut()
                  setIsProfileDrawerOpen(false)
                }}
                style={{ textDecoration: 'none', color: '#dc3545' }}
              >
                Log Out
              </button>
            </div>

            <div style={{ flex: 1, minHeight: 0 }} />

          </div>
        </>,
        document.body
      )}

      {isPreferencesModalOpen && createPortal(
        <>
          <div
            className="modal-overlay"
            onClick={() => setIsPreferencesModalOpen(false)}
            style={{ zIndex: 1040 }}
          />
          <div
            className="profile-drawer"
            style={{
              position: 'fixed',
              right: 0,
              top: 0,
              height: '100vh',
              width: '280px',
              maxWidth: '100vw',
              backgroundColor: 'white',
              boxShadow: '-2px 0 8px rgba(0,0,0,0.1)',
              zIndex: 1050,
              display: 'flex',
              flexDirection: 'column'
            }}
          >
            <div style={{ padding: '0.75rem', borderBottom: '1px solid #e9ecef' }}>
              <button
                type="button"
                className="close-btn"
                onClick={() => setIsPreferencesModalOpen(false)}
                style={{ float: 'right' }}
              >
                ✕
              </button>
              <h6 className="fw-bold text-success mb-0">My Matcha Preferences</h6>
            </div>

            <div style={{ padding: '1rem', overflowY: 'auto', flex: 1 }}>
              <label className="form-label fw-semibold mb-2 text-success">Flavor Preferences</label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.5rem', marginBottom: '1rem' }}>
                {['sweet', 'nutty', 'umami', 'vegetal', 'sugary', 'astringent', 'creamy', 'floral', 'earthy', 'Chocolatey', 'mellow'].map((flavor) => (
                  <button
                    key={flavor}
                    type="button"
                    style={{
                      textTransform: 'capitalize',
                      fontSize: '0.8rem',
                      padding: '0.375rem 0.75rem',
                      borderRadius: '0.5rem',
                      border: '1px solid ' + (userFlavors.includes(flavor) ? 'rgba(0, 150, 136, 0.5)' : 'rgba(176, 222, 214, 0.3)'),
                      background: userFlavors.includes(flavor)
                        ? '#0d4f4a'
                        : 'linear-gradient(135deg, #d4ede9 0%, #e0f3f0 100%)',
                      color: userFlavors.includes(flavor) ? '#4dd0c1' : '#6b9e95',
                      fontWeight: userFlavors.includes(flavor) ? '600' : '500',
                      cursor: 'pointer'
                    }}
                    onClick={() => setUserFlavors(userFlavors.includes(flavor)
                      ? userFlavors.filter(f => f !== flavor)
                      : [...userFlavors, flavor]
                    )}
                  >
                    {flavor}
                  </button>
                ))}
              </div>

              <button
                type="button"
                className="btn w-100"
                onClick={async () => {
                  try {
                    setIsPreferencesModalOpen(false)
                    setIsProfileDrawerOpen(false)
                    const response = await apiFetch('/preferences', {
                      method: 'POST',
                      body: JSON.stringify({
                        flavors: userFlavors
                      })
                    })
                    console.log('Preferences saved:', response)
                    alert('Preferences saved!')
                  } catch (error) {
                    console.error('Failed to save preferences:', error)
                    setIsPreferencesModalOpen(true)
                    alert(error instanceof Error ? error.message : 'Failed to save preferences')
                  }
                }}
                style={{
                  background: '#0d4f4a',
                  color: '#4dd0c1',
                  border: '1px solid rgba(0, 150, 136, 0.5)',
                  fontWeight: '600'
                }}
              >
                Save
              </button>
            </div>
          </div>
        </>,
        document.body
      )}

      {isPrivacyPolicyModalOpen && createPortal(
        <>
          <div
            className="modal-overlay"
            onClick={() => setIsPrivacyPolicyModalOpen(false)}
            style={{ zIndex: 1040 }}
          />
          <div
            className="profile-drawer"
            style={{
              position: 'fixed',
              right: 0,
              top: 0,
              height: '100vh',
              width: '280px',
              maxWidth: '100vw',
              backgroundColor: 'white',
              boxShadow: '-2px 0 8px rgba(0,0,0,0.1)',
              zIndex: 1050,
              display: 'flex',
              flexDirection: 'column'
            }}
          >
            <div style={{ padding: '0.75rem', borderBottom: '1px solid #e9ecef' }}>
              <button
                type="button"
                className="close-btn"
                onClick={() => setIsPrivacyPolicyModalOpen(false)}
                style={{ float: 'right' }}
              >
                ✕
              </button>
              <h6 className="fw-bold text-success mb-0">Privacy Policy</h6>
            </div>

            <div style={{ padding: '1rem', overflowY: 'auto', flex: 1, fontSize: '0.875rem', lineHeight: '1.6' }}>
              <p className="text-muted mb-3">
                <strong>Last Updated: September 2024</strong>
              </p>

              <h6 className="fw-semibold text-success mb-2">1. Introduction</h6>
              <p className="text-muted mb-3">
                Sip & Score ("we", "our", or "us") operates the Sip & Score application. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use our application.
              </p>

              <h6 className="fw-semibold text-success mb-2">2. Information We Collect</h6>
              <p className="text-muted mb-2">
                <strong>Account Information:</strong> Email address, username, and password (encrypted).
              </p>
              <p className="text-muted mb-2">
                <strong>Rating Data:</strong> Matcha ratings, taste scores (1-5), greenness ratings (1-100), photos, location data, and tasting notes.
              </p>
              <p className="text-muted mb-3">
                <strong>Preferences:</strong> Flavor preferences and matcha profile selections.
              </p>

              <h6 className="fw-semibold text-success mb-2">3. How We Use Your Information</h6>
              <p className="text-muted mb-2">
                • Personalize your experience and provide ratings history
              </p>
              <p className="text-muted mb-2">
                • Generate community leaderboards and rankings
              </p>
              <p className="text-muted mb-2">
                • Improve app functionality and user experience
              </p>
              <p className="text-muted mb-3">
                • Communicate updates and service announcements
              </p>

              <h6 className="fw-semibold text-success mb-2">4. Data Security</h6>
              <p className="text-muted mb-3">
                We use industry-standard security measures including encryption and secure authentication to protect your data. However, no transmission over the internet is completely secure.
              </p>

              <h6 className="fw-semibold text-success mb-2">5. Third Parties</h6>
              <p className="text-muted mb-3">
                We do not sell, trade, or rent your personal information to third parties. Your data is shared only with necessary service providers.
              </p>

              <h6 className="fw-semibold text-success mb-2">6. Your Rights</h6>
              <p className="text-muted mb-2">
                • Access your personal data
              </p>
              <p className="text-muted mb-2">
                • Correct or update your information
              </p>
              <p className="text-muted mb-3">
                • Request deletion of your account and data
              </p>

              <h6 className="fw-semibold text-success mb-2">7. Contact Us</h6>
              <p className="text-muted">
                For privacy concerns or requests, contact: support@sipandscore.com
              </p>
            </div>
          </div>
        </>,
        document.body
      )}

      {isEditingEntry && createPortal(
        <div className="modal-overlay" role="dialog" aria-modal="true" onClick={() => {
          setIsEditingEntry(false)
          setEditEntryPhoto('')
        }}>
          <div className="modal-card card border-0 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <div className="card-header bg-white border-bottom d-flex align-items-center p-4">
              <h3 className="h5 fw-bold text-success mb-0" style={{ flexShrink: 0 }}>Edit Rating</h3>
              <button
                type="button"
                className="close-btn"
                onClick={() => {
                  setIsEditingEntry(false)
                  setEditEntryPhoto('')
                }}
              >
                ✕
              </button>
            </div>
            <div className="card-body p-4">
              <div style={{ marginBottom: '1.5rem' }}>
                <label className="form-label fw-semibold mb-2 text-success">Rating</label>
                <div className="d-flex gap-2 mb-2 rating-star-row">
                  {Array.from({ length: 5 }, (_, idx) => {
                    const starIndex = idx + 1
                    const fillAmount = Math.max(0, Math.min(1, editRating - idx))
                    return (
                      <button
                        type="button"
                        key={`edit-${starIndex}`}
                        className="star"
                        onClick={(event) => {
                          event.stopPropagation()
                          const bounds = event.currentTarget.getBoundingClientRect()
                          const clickX = event.clientX - bounds.left
                          const step = clickX < bounds.width / 2 ? 0.5 : 1
                          setEditRating((starIndex - 1) + step)
                        }}
                        onPointerDown={(event) => {
                          event.stopPropagation()
                          setIsEditRatingDragActive(true)
                          handleEditRatingPointer(starIndex, event)
                        }}
                        onPointerMove={(event) => {
                          if (!isEditRatingDragActive) return
                          event.stopPropagation()
                          handleEditRatingPointer(starIndex, event)
                        }}
                        onPointerUp={(event) => {
                          event.stopPropagation()
                          setIsEditRatingDragActive(false)
                        }}
                        aria-label={`Edit to ${starIndex} stars`}
                      >
                        <img className="star-base" src={pixelStarUrl} alt="" />
                        <span className="star-fill-clip" style={{ width: `${fillAmount * 100}%` }}>
                          <img className="star-fill" src={pixelStarFilledUrl} alt="" />
                        </span>
                      </button>
                    )
                  })}
                </div>
                <button
                  type="button"
                  className="btn btn-outline-secondary btn-sm"
                  onClick={(event) => {
                    event.stopPropagation()
                    setEditRating(0)
                  }}
                >
                  Clear rating
                </button>
              </div>

              <div style={{ marginBottom: '1.5rem' }}>
                <label className="form-label fw-semibold mb-2 text-success">Location</label>
                <input
                  type="text"
                  className="form-control"
                  value={editLocation}
                  onChange={(event) => setEditLocation(event.target.value)}
                  placeholder="Matcha place name"
                />
              </div>

              <div style={{ marginBottom: '1.5rem' }}>
                <label className="form-label fw-semibold mb-2 text-success">Photo</label>
                <button
                  type="button"
                  className="btn btn-outline-success btn-sm w-100"
                  onClick={() => setIsCameraModalOpen(true)}
                >
                  Change Photo
                </button>
              </div>

              <div style={{ marginBottom: '1.5rem' }}>
                <label className="form-label fw-semibold mb-2 text-success">Notes</label>
                <textarea
                  className="form-control"
                  rows={5}
                  value={editThoughts}
                  onChange={(event) => setEditThoughts(event.target.value)}
                  placeholder="Your thoughts..."
                />
              </div>
            </div>
            <div className="card-footer bg-white border-top p-4 d-flex gap-2">
              <button type="button" className="btn btn-success flex-grow-1" onClick={() => void saveEntryEdit(selectedEntryId!)}>
                Save
              </button>
              <button type="button" className="btn btn-outline-secondary flex-grow-1" onClick={() => {
                setIsEditingEntry(false)
                setEditEntryPhoto('')
              }}>
                Cancel
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      <nav className="navbar navbar-expand-lg navbar-light sticky-top soft-nav minimal-nav" aria-label="Main navigation" style={{ paddingLeft: 0, paddingRight: 0, marginRight: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', paddingLeft: '1rem', paddingRight: 0, marginRight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <span style={{ fontSize: '1.1rem', fontWeight: '700', color: '#1f5f34' }}>SIP</span>
            <span style={{ fontSize: '1rem', fontWeight: '700', color: '#6c757d' }}>&</span>
            <span style={{ fontSize: '1.1rem', fontWeight: '700', color: '#20c997' }}>SCORE</span>
          </div>
          <button
            type="button"
            className="btn btn-link text-dark p-0 d-flex align-items-center gap-2"
            onClick={() => setIsProfileDrawerOpen(true)}
            title="My Profile"
            style={{ textDecoration: 'none', marginRight: '-0.5rem', paddingRight: 0 }}
          >
            <span style={{ fontSize: '0.875rem', color: '#495057' }}>{currentUserName}</span>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
              <circle cx="12" cy="7" r="4"></circle>
            </svg>
          </button>
        </div>
      </nav>

      {activePage === 'home' && (
        <main id="main-content" className="container py-5 py-md-5 px-3 px-md-4" tabIndex={-1}>
          <div className="card shadow-sm border-0 matcha-shell">
            <div className="card-body p-3 p-md-4">
              <h1 className="display-6 fw-bold mb-3 text-success">New Log</h1>

              <div className="mb-3">
                <div className="form-label fw-semibold">Enter cafe or shop name</div>
                <div className="location-autocomplete">
                  <input
                    id="location-input"
                    type="text"
                    className="form-control"
                    value={location}
                    onChange={(event) => {
                      setLocation(event.target.value)
                      setShowLocationSuggestions(true)
                    }}
                    onFocus={() => {
                      if (locationSuggestions.length > 0 || isLocationLookupPending) {
                        setShowLocationSuggestions(true)
                      }
                    }}
                    onBlur={() => {
                      if (locationBlurTimeoutRef.current !== null) {
                        window.clearTimeout(locationBlurTimeoutRef.current)
                      }
                      locationBlurTimeoutRef.current = window.setTimeout(() => {
                        setShowLocationSuggestions(false)
                      }, 120)
                    }}
                    placeholder="Search for a matcha place name"
                    autoComplete="off"
                  />

                  {showLocationSuggestions && location.trim().length >= 2 && (
                    <div className="location-dropdown border rounded shadow-sm bg-white">
                      {isLocationLookupPending && <div className="location-item muted">Searching locations...</div>}

                      {!isLocationLookupPending && locationSuggestions.length === 0 && (
                        <div className="location-item muted">No matching places found.</div>
                      )}

                      {!isLocationLookupPending &&
                        locationSuggestions.map((suggestion) => (
                          <button
                            type="button"
                            key={suggestion}
                            className="location-item"
                            onMouseDown={(event) => {
                              event.preventDefault()
                              applyLocationSuggestion(suggestion)
                            }}
                          >
                            {suggestion}
                          </button>
                        ))}
                    </div>
                  )}
                </div>
              </div>

              <hr className="my-3" style={{ borderColor: '#e9ecef', opacity: 0.5 }} />

              <div className="mb-3">
                <button
                  type="button"
                  className="btn btn-link text-start text-muted p-0 d-flex align-items-center gap-2"
                  onClick={openPhotoLibrary}
                  style={{ textDecoration: 'none', whiteSpace: 'nowrap' }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
                    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
                    <circle cx="12" cy="13" r="4"></circle>
                  </svg>
                  <span>Add photo</span>
                  <span className="text-muted">›</span>
                </button>
              </div>

              {photoDataUrl && photoDataUrl !== noPhotoPlaceholderUrl && (
                <div className="mb-3">
                  <div className="preview-wrap mb-2">
                    <img src={photoDataUrl} alt="Matcha preview" className="preview-image" loading="lazy" decoding="async" />
                  </div>
                  <div className="d-flex gap-2">
                    <button
                      type="button"
                      className="btn btn-sm btn-outline-secondary flex-grow-1"
                      onClick={() => setIsUploadMenuOpen(true)}
                    >
                      Change photo
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-outline-danger"
                      onClick={() => setPhotoDataUrl(noPhotoPlaceholderUrl)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              )}
              
              <center> 
              <div className="mb-3 text-success fw-semibold">
                {matchaGreenness !== null ? `Matcha Greenness: ${matchaGreenness.toFixed(1)}/100` : 'Matcha Greenness score pending'}
              </div>
              </center>

              <hr className="my-3" style={{ borderColor: '#e9ecef', opacity: 0.5 }} />

              <div className="mb-3">
                <label className="form-label fw-semibold d-block">Flavor Profile</label>
                <div className="small text-muted mb-3">Click bubbles to toggle flavors</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.5rem', placeItems: 'center' }}>
                  {(['sweet', 'nutty', 'umami', 'vegetal', 'sugary', 'astringent', 'creamy', 'floral', 'earthy', 'Chocolatey', 'mellow'] as const).map((flavor) => {
                    const intensity = ratingFlavorPrefs[flavor]
                    const isActive = intensity > 0

                    return (
                      <button
                        key={flavor}
                        type="button"
                        className="btn"
                        style={{
                          backgroundColor: isActive ? '#20c997' : '#e9ecef',
                          color: isActive ? 'white' : '#666',
                          border: 'none',
                          borderRadius: '20px',
                          padding: '0.3rem 0.7rem',
                          transition: 'all 0.2s ease',
                          textTransform: 'capitalize',
                          fontSize: '0.75rem',
                          cursor: 'pointer'
                        }}
                        onClick={() => {
                          setRatingFlavorPrefs({
                            ...ratingFlavorPrefs,
                            [flavor]: isActive ? 0 : 75
                          })
                        }}
                      >
                        {flavor}
                      </button>
                    )
                  })}
                </div>
              </div>

              <hr className="my-3" style={{ borderColor: '#e9ecef', opacity: 0.5 }} />
              {matchaGreenness !== null && (
                <div className="mb-3 small detector-chip">
                  <div>{mlStatus}</div>
                  {mlCoveragePercent !== null && mlConfidencePercent !== null && (
                    <div className="detector-metrics">
                      Coverage: {mlCoveragePercent.toFixed(1)}%
                      {' | '}
                      Confidence: {mlConfidencePercent.toFixed(1)}%
                    </div>
                  )}
                </div>
              )}

              <div className="mb-3">
                <label className="form-label fw-semibold d-block">How do you rate this matcha?</label>
                <div className="small text-muted mb-2 text-center">Half-star and 0-star ratings are allowed. Tap on a star to set a value.</div>
                <div id="star-rating" className="d-flex gap-2 rating-star-row justify-content-center">
                  {Array.from({ length: 5 }, (_, idx) => {
                    const starIndex = idx + 1
                    const fillAmount = Math.max(0, Math.min(1, currentRating - idx))
                    return (
                      <button
                        type="button"
                        key={starIndex}
                        className="star"
                        onClick={(event) => updateRatingFromClick(starIndex, event)}
                        onPointerDown={(event) => {
                          setIsRatingDragActive(true)
                          handleCurrentRatingPointer(starIndex, event)
                        }}
                        onPointerMove={(event) => {
                          if (!isRatingDragActive) return
                          handleCurrentRatingPointer(starIndex, event)
                        }}
                        onPointerUp={() => setIsRatingDragActive(false)}
                        aria-label={`Rate ${starIndex} stars`}
                      >
                        <img className="star-base" src={pixelStarUrl} alt="" />
                        <span className="star-fill-clip" style={{ width: `${fillAmount * 100}%` }}>
                          <img className="star-fill" src={pixelStarFilledUrl} alt="" />
                        </span>
                      </button>
                    )
                  })}
                </div>
                <div className="text-center">
                  <button type="button" className="btn btn-outline-secondary btn-sm mt-2" onClick={() => setCurrentRating(0)}>
                    Set 0 stars
                  </button>
                  <div className="rating-badge mt-2 text-center">Selected: <span className="rating-value">{currentRating.toFixed(1)}</span> / 5.0</div>
                </div>
              </div>

              <hr className="my-3" style={{ borderColor: '#e9ecef', opacity: 0.5 }} />

              <div className="mb-3">
                <button
                  type="button"
                  className="btn btn-link text-start text-muted p-0 d-flex align-items-center gap-2"
                  onClick={() => setIsNotesModalOpen(true)}
                  style={{ textDecoration: 'none', whiteSpace: 'nowrap' }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                  </svg>
                  <span>Add notes</span>
                  <span className="text-muted">›</span>
                </button>
              </div>

              <button type="button" className="btn btn-success w-100" onClick={() => void saveEntry()} disabled={isSavingEntry}>
                {isSavingEntry ? 'Saving...' : 'Save Rating'}
              </button>
            </div>
          </div>

          <section className="mt-4 mb-5">
            <div className="d-flex flex-column gap-2 mb-3">
              <div className="d-flex align-items-center gap-2">
                <div>
                  <h2 className="h4 fw-bold text-success mb-0">
                    My Ratings
                  </h2>
                  <small className="text-muted">Tap to edit</small>
                </div>
              </div>

              <div className="my-ratings-controls">
                {isMyRatingsSearchOpen ? (
                  <div className="my-ratings-search-bar">
                    <div className="search-bar-wrapper">
                      <span className="search-bar-icon">⌕</span>
                      <input
                        id="my-ratings-search-input"
                        type="text"
                        className="form-control search-bar-input"
                        placeholder="Search your list"
                        value={myLogsSearchTerm}
                        onChange={(event) => setMyLogsSearchTerm(event.target.value)}
                        autoFocus
                      />
                    </div>
                    <button
                      type="button"
                      className="search-bar-close"
                      onClick={() => {
                        setIsMyRatingsSearchOpen(false)
                        setMyLogsSearchTerm('')
                      }}
                      aria-label="Close search"
                    >
                      Close
                    </button>
                  </div>
                ) : (
                  <div className="my-ratings-action-row">
                    <div className="score-sort-bubble">
                      <button
                        type="button"
                        className="filter-bubble-button"
                        onClick={() => setIsMyRatingsFilterOpen(true)}
                        aria-label="Open filter menu"
                        title="Filter and sort"
                      >
                        <span className="filter-icon">☰</span>
                        <span className="score-sort-label">Filter by</span>
                      </button>
                    </div>

                    <div className="ratings-search-shell">
                      <button
                        type="button"
                        className="search-icon-button"
                        aria-label="Search ratings"
                        onClick={() => setIsMyRatingsSearchOpen(true)}
                      >
                        <span aria-hidden="true">⌕</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="d-flex flex-column gap-3">
              {isMyRatingsLoading && (
                <div className="rating-loading-shell" aria-live="polite">
                  <div className="text-muted small">Loading your log…</div>
                </div>
              )}

              {!isMyRatingsLoading && filteredMine.length === 0 && <div className="alert alert-light border">Your matcha journey starts here ☕</div>}

              {!isMyRatingsLoading && (isMyLogsExpanded ? filteredMine : filteredMine.slice(0, 3)).map((entry) => (
                <article key={entry.id} data-entry-id={entry.id} className="card border-0 shadow-sm entry-card cursor-pointer" onClick={() => openEntryOverlay(entry)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openEntryOverlay(entry) }}>
                  <div className="card-body d-flex gap-3 align-items-start justify-content-between">
                    <div className="d-flex gap-3 flex-grow-1 align-items-start">
                      <div className="entry-media-col">
                        <img src={entry.photo} alt="Matcha" className="entry-thumb" loading="lazy" decoding="async" />
                        <div className="entry-rank-circle">#{myRankById.get(entry.id) || 0}</div>
                      </div>
                      <div className="flex-grow-1">
                        <div className="d-flex justify-content-between flex-wrap gap-2">
                          <strong>{entry.location || 'Unknown location'}</strong>
                          <span className="text-muted small">{entry.date}</span>
                        </div>
                        <div className="entry-metrics">
                          <div className="fw-bold mb-2">Total score: {getWeightedScore(entry.rating, entry.greenness).toFixed(1)} / 200.0</div>
                          <div style={{ color: '#6c757d', marginBottom: '0.5rem', fontWeight: 'normal' }}>Matcha greenness: {entry.greenness.toFixed(1)} / 100.0</div>
                          {entry.flavorPreferences && Object.entries(entry.flavorPreferences).some(([_, v]) => v > 0) && (
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem', maxWidth: '280px', marginTop: '0.5rem' }}>
                              {Object.entries(entry.flavorPreferences).map(([flavor, intensity]) =>
                                intensity > 0 ? (
                                  <span
                                    key={flavor}
                                    className="badge"
                                    style={{
                                      fontSize: '0.7rem',
                                      background: 'linear-gradient(135deg, rgba(32, 201, 151, 0.3) 0%, rgba(0, 0, 0, 0.3) 100%)',
                                      backdropFilter: 'blur(10px)',
                                      border: '1px solid rgba(32, 201, 151, 0.5)',
                                      color: '#20c997',
                                      textTransform: 'capitalize',
                                      padding: '0.25rem 0.5rem',
                                      textAlign: 'center'
                                    }}
                                  >
                                    {flavor}
                                  </span>
                                ) : null
                              )}
                            </div>
                          )}
                        </div>
                        {entry.thoughts && <p className="mt-2 mb-0">{entry.thoughts}</p>}
                        {entry.flavorPreferences && Object.entries(entry.flavorPreferences).some(([_, v]) => v > 0) && (
                          <div className="d-flex flex-wrap gap-1 mt-2">
                            {Object.entries(entry.flavorPreferences).map(([flavor, intensity]) =>
                              intensity > 0 ? (
                                <span
                                  key={flavor}
                                  className="badge bg-success"
                                  style={{ fontSize: '0.75rem', opacity: Math.min(1, intensity / 100 + 0.5), textTransform: 'capitalize' }}
                                >
                                  {flavor}
                                </span>
                              ) : null
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="entry-hint-icon" aria-hidden="true">✎</div>
                  </div>

                  {selectedEntryId === entry.id && !isEditingEntry && (
                    <div className="entry-overlay" onClick={(event) => event.stopPropagation()}>
                      <div className="entry-overlay-actions d-flex flex-column gap-2 align-items-center">
                        <div className="d-flex gap-2 w-100">
                          <button type="button" className="btn btn-light btn-sm flex-grow-1" onClick={() => startEntryEdit(entry)} aria-label="Edit rating">
                            <span className="action-icon-wrap">
                              <img src={pencilIconUrl} alt="" className="action-icon" />
                            </span>
                            Edit
                          </button>
                          <button
                            type="button"
                            className="btn btn-danger btn-sm flex-grow-1"
                            onClick={() => {
                              if (window.confirm('Delete this rating entry?')) {
                                void deleteEntry(entry.id)
                              }
                            }}
                            aria-label="Delete rating"
                          >
                            <span className="action-icon-wrap">
                              <img src={trashIconUrl} alt="" className="action-icon" />
                            </span>
                            Delete
                          </button>
                        </div>
                        <button
                          type="button"
                          className="btn btn-outline-light btn-sm w-100"
                          onClick={() => {
                            setSelectedEntryId(null)
                            setIsEditingEntry(false)
                          }}
                        >
                          Close
                        </button>
                      </div>
                    </div>
                  )}
                </article>
              ))}
              {filteredMine.length > 3 && (
                <button
                  type="button"
                  className="btn btn-outline-success w-100 mt-2"
                  onClick={() => setIsMyLogsExpanded(!isMyLogsExpanded)}
                >
                  {isMyLogsExpanded ? 'See Less' : 'See More'}
                </button>
              )}
            </div>
          </section>
        </main>
      )}

      {activePage === 'friends' && (
        <main id="main-content" className="container py-3 py-md-5 px-3 px-md-4" tabIndex={-1}>
          <section className="card border-0 shadow-sm matcha-shell mb-4">
            <div className="card-body p-3 p-md-4">
              <h2 className="h3 fw-bold text-success mb-4">Explore</h2>

              {/* Navigation Tabs */}
              <div className="d-flex gap-3 mb-4" style={{ borderBottom: '1px solid #e9ecef' }}>
                <button
                  type="button"
                  className={`btn btn-link p-0 fw-semibold ${communityActiveTab === 'search' ? 'text-success' : 'text-muted'}`}
                  onClick={() => {
                    setCommunityActiveTab('search')
                    setSelectedFriend('')
                  }}
                  style={{ textDecoration: 'none', borderBottom: communityActiveTab === 'search' ? '2px solid var(--primary-green)' : 'none', paddingBottom: '0.5rem' }}
                >
                  Search Users
                </button>
                <button
                  type="button"
                  className={`btn btn-link p-0 fw-semibold ${communityActiveTab === 'following' ? 'text-success' : 'text-muted'}`}
                  onClick={() => {
                    setCommunityActiveTab('following')
                    setSelectedFriend('')
                    setFriendSuggestions([])
                    setFriendQuery('')
                  }}
                  style={{ textDecoration: 'none', borderBottom: communityActiveTab === 'following' ? '2px solid var(--primary-green)' : 'none', paddingBottom: '0.5rem' }}
                >
                  Following ({followingSet.size})
                </button>
                <button
                  type="button"
                  className={`btn btn-link p-0 fw-semibold ${communityActiveTab === 'recommendations' ? 'text-success' : 'text-muted'}`}
                  onClick={() => {
                    setCommunityActiveTab('recommendations')
                    setSelectedFriend('')
                    setFriendSuggestions([])
                    setFriendQuery('')
                  }}
                  style={{ textDecoration: 'none', borderBottom: communityActiveTab === 'recommendations' ? '2px solid var(--primary-green)' : 'none', paddingBottom: '0.5rem' }}
                >
                  Recs
                </button>
              </div>

              {/* Search Users Tab */}
              {communityActiveTab === 'search' && (
                <div className="mb-4">
                  <p className="text-muted small mb-3">Discover and connect with other matcha enthusiasts</p>
                  <div className="row g-2 align-items-end">
                    <div className="col-12 col-md-8">
                      <label className="form-label fw-semibold">Search Users</label>
                      <input
                        type="text"
                        className="form-control"
                        value={friendQuery}
                        placeholder="Enter username"
                        onChange={(event) => void searchFriends(event.target.value)}
                      />
                    </div>
                    <div className="col-12 col-md-4">
                      <button
                        type="button"
                        className="btn btn-success w-100"
                        onClick={() => void openFriendRatings(friendQuery.trim())}
                        disabled={!friendQuery.trim() || isLoadingFriendRatings}
                      >
                        View Ratings
                      </button>
                    </div>
                  </div>

                  {friendSuggestions.length > 0 && (
                    <div className="mt-4">
                      <h5 className="fw-semibold text-success mb-3">Search Results</h5>
                      <div className="row g-3">
                        {friendSuggestions.map((friend) => (
                          <div key={friend.userName} className="col-12 col-sm-6 col-md-4">
                            <div className="card border-0 shadow-sm h-100">
                              <div className="card-body">
                                <h6 className="card-title fw-semibold text-success mb-2" style={{ cursor: 'pointer' }} onClick={() => void openFriendRatings(friend.userName)}>
                                  {friend.userName}
                                </h6>
                                <p className="text-muted small mb-3">{friend.placeCount} places</p>
                                <button
                                  type="button"
                                  className="btn btn-link btn-sm text-success p-0"
                                  style={{ textDecoration: 'none' }}
                                  onClick={async () => {
                                    const isFollowing = followingSet.has(friend.userName)
                                    try {
                                      if (isFollowing) {
                                        await apiFetch(`/follows/${friend.userName}`, { method: 'DELETE' })
                                        followingSet.delete(friend.userName)
                                      } else {
                                        await apiFetch(`/follows/${friend.userName}`, { method: 'POST' })
                                        followingSet.add(friend.userName)
                                      }
                                      setFollowingSet(new Set(followingSet))
                                    } catch (error) {
                                      console.error('Failed to update follow status:', error)
                                      alert(error instanceof Error ? error.message : 'Failed to update follow status')
                                    }
                                  }}
                                  title={followingSet.has(friend.userName) ? 'Unfollow' : 'Follow'}
                                >
                                  {followingSet.has(friend.userName) ? '✓ Following' : '+ Follow'}
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Following Tab */}
              {communityActiveTab === 'following' && followingSet.size > 0 && (
                <div>
                  <p className="text-muted small mb-3">Users you're following</p>
                  <div className="row g-3">
                    {Array.from(followingSet).map((friend) => (
                      <div key={friend} className="col-12 col-md-6 col-lg-4">
                        <div className="card border-0 shadow-sm h-100">
                          <div className="card-body">
                            <h6 className="card-title fw-semibold text-success mb-3">{friend}</h6>
                            <button
                              type="button"
                              className="btn btn-sm btn-outline-success w-100 mb-2"
                              onClick={() => void openFriendRatings(friend)}
                              disabled={isLoadingFriendRatings}
                            >
                              View Ratings
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm btn-outline-danger w-100"
                              onClick={async () => {
                                try {
                                  await apiFetch(`/follows/${friend}`, { method: 'DELETE' })
                                  followingSet.delete(friend)
                                  setFollowingSet(new Set(followingSet))
                                } catch (error) {
                                  console.error('Failed to unfollow:', error)
                                  alert(error instanceof Error ? error.message : 'Failed to unfollow')
                                }
                              }}
                            >
                              Unfollow
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Recommendations Tab */}
              {communityActiveTab === 'recommendations' && (
                <div>
                  <p className="text-muted small mb-3">Find matcha places and users with similar flavor preferences</p>
                  {userFlavors.length === 0 ? (
                    <div className="alert alert-info border">
                      <p className="mb-0">Set your flavor preferences in your profile to discover similar users and places.</p>
                      <button
                        type="button"
                        className="btn btn-link btn-sm text-success p-0 mt-2"
                        onClick={() => setIsProfileDrawerOpen(true)}
                      >
                        Go to Profile →
                      </button>
                    </div>
                  ) : (
                    <div>
                      <div className="mb-4">
                        <h5 className="fw-semibold text-success mb-3">Your Flavor Preferences</h5>
                        <div className="d-flex flex-wrap gap-2 mb-4">
                          {userFlavors.map((flavor) => (
                            <span
                              key={flavor}
                              className="badge bg-success"
                              style={{ fontSize: '0.85rem', textTransform: 'capitalize' }}
                            >
                              {flavor}
                            </span>
                          ))}
                        </div>
                      </div>

                      <div className="mb-5">
                        <div className="d-flex gap-2 mb-4" style={{ borderBottom: '1px solid #e9ecef' }}>
                          <button
                            type="button"
                            className={`btn btn-link p-0 fw-semibold ${similarActiveTab === 'users' ? 'text-success' : 'text-muted'}`}
                            onClick={() => setSimilarActiveTab('users')}
                            style={{ textDecoration: 'none', borderBottom: similarActiveTab === 'users' ? '2px solid var(--primary-green)' : 'none', paddingBottom: '0.5rem' }}
                          >
                            Users with Similar Taste
                          </button>
                          <button
                            type="button"
                            className={`btn btn-link p-0 fw-semibold ${similarActiveTab === 'places' ? 'text-success' : 'text-muted'}`}
                            onClick={() => setSimilarActiveTab('places')}
                            style={{ textDecoration: 'none', borderBottom: similarActiveTab === 'places' ? '2px solid var(--primary-green)' : 'none', paddingBottom: '0.5rem' }}
                          >
                            Places with Your Profile
                          </button>
                        </div>

                        {similarActiveTab === 'users' && (
                          <>
                            {isLoadingSimilarUsers ? (
                              <div className="alert alert-light border">
                                <p className="mb-0 text-muted small">Loading similar users...</p>
                              </div>
                            ) : similarUsers.length === 0 ? (
                              <div className="alert alert-light border">
                                <p className="mb-0 text-muted small">No users found with similar preferences yet.</p>
                              </div>
                            ) : (
                              <div className="row g-3">
                                {similarUsers.map((user) => (
                                  <div key={user.userName} className="col-12 col-sm-6 col-md-4">
                                    <div className="card border-0 shadow-sm h-100">
                                      <div className="card-body">
                                        <div className="d-flex justify-content-between align-items-start mb-2">
                                          <h6 className="card-title fw-semibold text-success mb-0" style={{ cursor: 'pointer' }} onClick={() => void openFriendRatings(user.userName)}>
                                            {user.userName}
                                          </h6>
                                          <span className="badge" style={{
                                            fontSize: '0.75rem',
                                            background: 'linear-gradient(90deg, #E8A085 0%, #F0C389 25%, #E8D689 50%, #B8D9B3 75%, #7FD1C1 100%)',
                                            color: '#4a5c5a',
                                            fontWeight: 'bold',
                                            padding: '0.35rem 0.65rem',
                                            borderRadius: '0.375rem',
                                            boxShadow: '0 2px 8px rgba(200, 150, 130, 0.15)'
                                          }}>
                                            {(user.matchScore * 100).toFixed(0)}% match
                                          </span>
                                        </div>
                                        {user.flavors.length > 0 && (
                                          <div className="small mt-2">
                                            <p className="text-muted mb-2">Shared flavors:</p>
                                            <div className="d-flex flex-wrap gap-1">
                                              {user.flavors.map((flavor) => (
                                                <span key={flavor} className="badge bg-light text-dark" style={{ fontSize: '0.7rem', textTransform: 'capitalize' }}>
                                                  {flavor}
                                                </span>
                                              ))}
                                            </div>
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </>
                        )}

                        {similarActiveTab === 'places' && (
                          <>
                            {isLoadingSimilarPlaces ? (
                              <div className="alert alert-light border">
                                <p className="mb-0 text-muted small">Loading similar places...</p>
                              </div>
                            ) : similarPlaces.length === 0 ? (
                              <div className="alert alert-light border">
                                <p className="mb-0 text-muted small">No places found with similar profiles yet.</p>
                              </div>
                            ) : (
                              <div className="row g-3">
                                {similarPlaces.map((place) => (
                                  <div key={place.location} className="col-12 col-sm-6 col-md-4">
                                    <div className="card border-0 shadow-sm h-100">
                                      <div className="card-body">
                                        <div className="d-flex justify-content-between align-items-start mb-2">
                                          <h6 className="card-title fw-semibold text-success mb-0" style={{ cursor: 'pointer' }} onClick={() => setSelectedExplorePlaceName(place.location)}>
                                            {place.location}
                                          </h6>
                                          <span className="badge" style={{
                                            fontSize: '0.75rem',
                                            background: 'linear-gradient(90deg, #FF6B35 0%, #FFA500 25%, #FFD700 50%, #90EE90 75%, #20B2AA 100%)',
                                            color: 'white',
                                            fontWeight: 'bold',
                                            padding: '0.35rem 0.65rem',
                                            borderRadius: '0.375rem',
                                            boxShadow: '0 2px 8px rgba(255, 107, 53, 0.2)'
                                          }}>
                                            {(place.matchScore * 100).toFixed(0)}% match
                                          </span>
                                        </div>
                                        {place.flavors.length > 0 && (
                                          <div className="small mt-2">
                                            <p className="text-muted mb-2">Featured flavors:</p>
                                            <div className="d-flex flex-wrap gap-1">
                                              {place.flavors.map((flavor) => (
                                                <span key={flavor} className="badge bg-light text-dark" style={{ fontSize: '0.7rem', textTransform: 'capitalize' }}>
                                                  {flavor}
                                                </span>
                                              ))}
                                            </div>
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {communityActiveTab === 'following' && followingSet.size === 0 && (
                <div className="text-center py-5">
                  <p className="text-muted">No one following yet. Search for users to get started!</p>
                </div>
              )}
            </div>
          </section>

          {selectedFriend && (
            <section>
              <div className="d-flex justify-content-between align-items-center gap-2 mb-3">
                <h3 className="h4 fw-bold text-success mb-0" style={{ cursor: 'pointer' }} onClick={() => setIsFriendLogsExpanded(!isFriendLogsExpanded)}>
                  {selectedFriend}
                </h3>
                {isFriendSearchOpen ? (
                  <div className="search-bar-wrapper">
                    <input
                      id="friend-logs-search-input"
                      type="text"
                      className="form-control search-bar-input"
                      placeholder="Search ratings"
                      value={friendLogsSearchTerm}
                      onChange={(event) => setFriendLogsSearchTerm(event.target.value)}
                      autoFocus
                    />
                    <button
                      type="button"
                      className="search-bar-close"
                      onClick={() => {
                        setIsFriendSearchOpen(false)
                        setFriendLogsSearchTerm('')
                      }}
                      aria-label="Close search"
                    >
                      Close
                    </button>
                  </div>
                ) : (
                  <div className="my-ratings-action-row">
                    <div className="score-sort-bubble">
                      <button
                        type="button"
                        className="filter-bubble-button"
                        onClick={() => setIsFriendFilterOpen(true)}
                        aria-label="Open filter menu"
                        title="Filter and sort"
                      >
                        <span className="filter-icon">☰</span>
                        <span className="score-sort-label">Filter by</span>
                      </button>
                    </div>

                    <div className="ratings-search-shell">
                      <button
                        type="button"
                        className="search-icon-button"
                        aria-label="Search ratings"
                        onClick={() => setIsFriendSearchOpen(true)}
                      >
                        <span aria-hidden="true">⌕</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            <div className="d-flex flex-column gap-3">
              {selectedFriend && filteredFriendEntries.length === 0 && (
                <div className="alert alert-light border">No ratings found for this friend.</div>
              )}

              {(isFriendLogsExpanded || !selectedFriend ? filteredFriendEntries : filteredFriendEntries.slice(0, 3)).map((entry) => (
                <article key={entry.id} className="card border-0 shadow-sm">
                  <div className="card-body d-flex gap-3 align-items-start justify-content-between">
                    <div className="d-flex gap-3 flex-grow-1 align-items-start">
                      <div className="entry-media-col">
                        <img src={entry.photo} alt="Friend's matcha" className="entry-thumb" loading="lazy" decoding="async" />
                        <div className="entry-rank-circle">#{friendRankById.get(entry.id) || 0}</div>
                      </div>
                      <div className="flex-grow-1">
                        <div className="d-flex justify-content-between flex-wrap gap-2">
                          <strong>{entry.location || 'Unknown location'}</strong>
                          <span className="text-muted small">{entry.date}</span>
                        </div>
                        <div className="entry-metrics">
                          <div className="fw-bold mb-2">Total score: {getWeightedScore(entry.rating, entry.greenness).toFixed(1)} / 200.0</div>
                          <div style={{ color: '#6c757d', marginBottom: '0.5rem', fontWeight: 'normal' }}>Matcha greenness: {entry.greenness.toFixed(1)} / 100.0</div>
                          {entry.flavorPreferences && Object.entries(entry.flavorPreferences).some(([_, v]) => v > 0) && (
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem', maxWidth: '280px', marginTop: '0.5rem' }}>
                              {Object.entries(entry.flavorPreferences).map(([flavor, intensity]) =>
                                intensity > 0 ? (
                                  <span
                                    key={flavor}
                                    className="badge"
                                    style={{
                                      fontSize: '0.7rem',
                                      background: 'linear-gradient(135deg, rgba(32, 201, 151, 0.3) 0%, rgba(0, 0, 0, 0.3) 100%)',
                                      backdropFilter: 'blur(10px)',
                                      border: '1px solid rgba(32, 201, 151, 0.5)',
                                      color: '#20c997',
                                      textTransform: 'capitalize',
                                      padding: '0.25rem 0.5rem',
                                      textAlign: 'center'
                                    }}
                                  >
                                    {flavor}
                                  </span>
                                ) : null
                              )}
                            </div>
                          )}
                        </div>
                        {entry.thoughts && <p className="mt-2 mb-0">{entry.thoughts}</p>}
                        {entry.flavorPreferences && Object.entries(entry.flavorPreferences).some(([_, v]) => v > 0) && (
                          <div className="d-flex flex-wrap gap-1 mt-2">
                            {Object.entries(entry.flavorPreferences).map(([flavor, intensity]) =>
                              intensity > 0 ? (
                                <span
                                  key={flavor}
                                  className="badge bg-success"
                                  style={{ fontSize: '0.75rem', opacity: Math.min(1, intensity / 100 + 0.5), textTransform: 'capitalize' }}
                                >
                                  {flavor}
                                </span>
                              ) : null
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-link p-0 text-muted"
                      style={{ textDecoration: 'none' }}
                      onClick={(e) => {
                        e.stopPropagation()
                        const isLiked = likedRatingsSet.has(entry.id)
                        if (isLiked) {
                          void apiFetch(`/ratings/${entry.id}/like`, { method: 'DELETE' })
                          likedRatingsSet.delete(entry.id)
                        } else {
                          void apiFetch(`/ratings/${entry.id}/like`, { method: 'POST' })
                          likedRatingsSet.add(entry.id)
                        }
                        setLikedRatingsSet(new Set(likedRatingsSet))
                      }}
                      title={likedRatingsSet.has(entry.id) ? 'Unlike' : 'Like'}
                    >
                      {likedRatingsSet.has(entry.id) ? '★' : '☆'}
                    </button>
                  </div>
                </article>
              ))}
              {selectedFriend && filteredFriendEntries.length > 3 && !isFriendLogsExpanded && (
                <button
                  type="button"
                  className="btn btn-outline-success w-100 mt-2"
                  onClick={() => setIsFriendLogsExpanded(true)}
                >
                  See More
                </button>
              )}
            </div>
          </section>
          )}
        </main>
      )}

      {activePage === 'explore' && (
        <main id="main-content" className="container py-3 py-md-5 px-3 px-md-4" tabIndex={-1}>
          <section className="card border-0 shadow-sm matcha-shell mb-4">
            <div className="card-body p-3 p-md-4">
              <h2 className="h3 fw-bold text-success mb-4">Community Leaderboard</h2>

              <div className="d-flex gap-2 mb-4" style={{ borderBottom: '1px solid #e9ecef' }}>
                <button
                  type="button"
                  className={`btn btn-link p-0 fw-semibold ${exploreActiveTab === 'places' ? 'text-success' : 'text-muted'}`}
                  onClick={() => setExploreActiveTab('places')}
                  style={{ textDecoration: 'none', borderBottom: exploreActiveTab === 'places' ? '2px solid var(--primary-green)' : 'none', paddingBottom: '0.5rem' }}
                >
                  Places
                </button>
                <button
                  type="button"
                  className={`btn btn-link p-0 fw-semibold ${exploreActiveTab === 'users' ? 'text-success' : 'text-muted'}`}
                  onClick={() => setExploreActiveTab('users')}
                  style={{ textDecoration: 'none', borderBottom: exploreActiveTab === 'users' ? '2px solid var(--primary-green)' : 'none', paddingBottom: '0.5rem' }}
                >
                  Users
                </button>
              </div>

              {exploreActiveTab === 'places' && (
                <section>
                  <p className="text-muted mb-3">Top ranked matchas</p>

                  {explorePlaces.length === 0 && (
                    <div className="alert alert-light border mb-0">No place data yet. Add ratings to build rankings.</div>
                  )}

                  {explorePlaces.length > 0 && (
                    <div className="d-flex flex-column gap-2">
                      {explorePlaces.map((place) => (
                        <button
                          type="button"
                          key={place.placeName}
                          className="card border-0 shadow-sm explore-place-card"
                          onClick={() => void openExplorePlaceRatings(place.placeName)}
                        >
                          <div className="card-body d-flex justify-content-between align-items-center flex-wrap gap-2 text-start">
                            <div>
                              <div className="fw-semibold text-success">#{place.rank} {place.placeName}</div>
                              <div className="small text-muted">{place.entryCount} entries</div>
                            </div>
                            <div className="fw-bold">Average score: {place.averageScore.toFixed(1)} / 200</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              )}

              {exploreActiveTab === 'users' && (
                <section>
                  <p className="text-muted mb-3">Leaderboard</p>

                  {exploreUsers.length === 0 && <div className="alert alert-light border mb-0">No user place data yet.</div>}

                  {exploreUsers.length > 0 && (
                    <div className="d-flex flex-column gap-2">
                      {exploreUsers.map((user, index) => (
                        <article key={`${user.userName}-${index}`} className="card border-0 shadow-sm">
                          <div className="card-body d-flex justify-content-between align-items-center flex-wrap gap-2 py-2">
                            <div className="fw-semibold">
                              #{index + 1}{' '}
                              <button
                                type="button"
                                className="explore-user-link"
                                onClick={() => {
                                  void openFriendRatings(user.userName)
                                }}
                              >
                                {user.userName}
                              </button>
                            </div>
                            <div className="d-flex gap-3 align-items-center">
                              <div className="text-success fw-bold">{user.placeCount}</div>
                              <button
                                type="button"
                                className="btn btn-link btn-sm text-muted p-0"
                                style={{ textDecoration: 'none' }}
                                onClick={async () => {
                                  const isFollowing = followingSet.has(user.userName)
                                  try {
                                    if (isFollowing) {
                                      await apiFetch(`/follows/${user.userName}`, { method: 'DELETE' })
                                      followingSet.delete(user.userName)
                                    } else {
                                      await apiFetch(`/follows/${user.userName}`, { method: 'POST' })
                                      followingSet.add(user.userName)
                                    }
                                    setFollowingSet(new Set(followingSet))
                                  } catch (error) {
                                    console.error('Failed to update follow status:', error)
                                    alert(error instanceof Error ? error.message : 'Failed to update follow status')
                                  }
                                }}
                                title={followingSet.has(user.userName) ? 'Unfollow' : 'Follow'}
                              >
                                {followingSet.has(user.userName) ? '✓ Following' : '+ Follow'}
                              </button>
                            </div>
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              )}
            </div>
          </section>
        </main>
      )}

      <nav className="bottom-nav d-lg-none">
        <button
          type="button"
          className={`bottom-nav-btn ${activePage === 'home' ? 'active' : ''}`}
          onClick={() => setActivePage('home')}
          title="My Log"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
          </svg>
          <span className="label">My Log</span>
        </button>
        <button
          type="button"
          className={`bottom-nav-btn ${activePage === 'friends' ? 'active' : ''}`}
          onClick={() => setActivePage('friends')}
          title="Explore"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="12" cy="12" r="10"></circle>
            <path d="M2 12h20"></path>
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
          </svg>
          <span className="label">Explore</span>
        </button>
        <button
          type="button"
          className={`bottom-nav-btn ${activePage === 'explore' ? 'active' : ''}`}
          onClick={() => setActivePage('explore')}
          title="Leaderboard"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            {/* Trophy cup */}
            <path d="M6 3h12v3h0a3 3 0 0 1 3 3v2h0a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-2a3 3 0 0 1 3-3h0V3z"></path>
            <path d="M9 11v3a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-3"></path>
            <path d="M9 15h6"></path>
            <path d="M8 18h8a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1v-1a1 1 0 0 1 1-1z"></path>
            {/* Star inside trophy */}
            <path d="M12 6l0.5 2h2l-1.5 1 0.5 2-2-1.5-2 1.5 0.5-2-1.5-1h2Z" fill="currentColor"></path>
          </svg>
          <span className="label">Leaderboard</span>
        </button>
      </nav>
</>
  )
}

export default App
