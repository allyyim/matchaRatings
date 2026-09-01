import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { useGoogleLogin } from '@react-oauth/google'
import * as Sentry from '@sentry/react'
import * as tf from '@tensorflow/tfjs'
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

const drinkAreaModelConfig = {
  modelUrl: `${import.meta.env.BASE_URL}ml/drink-area/model.json`,
  inputSize: 224,
  maskThreshold: 0.45
}

const LOW_RATING_GREENNESS_WEIGHT = 0.8
const FULL_GREENNESS_WEIGHT = 1
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

let drinkAreaModelPromise: Promise<tf.GraphModel | tf.LayersModel | null> | null = null

async function loadDrinkAreaModel(): Promise<tf.GraphModel | tf.LayersModel | null> {
  if (drinkAreaModelPromise) {
    return drinkAreaModelPromise
  }

  drinkAreaModelPromise = (async () => {
    try {
      try {
        return await tf.loadGraphModel(drinkAreaModelConfig.modelUrl)
      } catch {
        return await tf.loadLayersModel(drinkAreaModelConfig.modelUrl)
      }
    } catch {
      return null
    }
  })()

  return drinkAreaModelPromise
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

function normalizeMaskTensor(rawPrediction: tf.Tensor | tf.Tensor[]): tf.Tensor2D | null {
  const prediction = Array.isArray(rawPrediction) ? rawPrediction[0] : rawPrediction
  const squeezed = prediction.squeeze()
  if (squeezed.rank !== 2) {
    squeezed.dispose()
    return null
  }

  return squeezed as tf.Tensor2D
}

async function detectDrinkAreaRegion(img: HTMLImageElement): Promise<DetectResult> {
  const fallbackRegion = createFallbackRegion(img.width, img.height)
  const model = await loadDrinkAreaModel()

  if (!model) {
    return {
      region: fallbackRegion,
      statusMessage: 'ML model not found. Using heuristic drink area.',
      coveragePercent: null,
      confidencePercent: null
    }
  }

  const inputTensor = tf.tidy(() => {
    const pixels = tf.browser.fromPixels(img)
    const resized = tf.image.resizeBilinear(pixels, [drinkAreaModelConfig.inputSize, drinkAreaModelConfig.inputSize])
    return resized.toFloat().div(255).expandDims(0)
  })

  let maskTensor: tf.Tensor2D | null = null
  try {
    const rawPrediction = model.predict(inputTensor) as tf.Tensor | tf.Tensor[]
    maskTensor = normalizeMaskTensor(rawPrediction)
    if (Array.isArray(rawPrediction)) {
      rawPrediction.forEach((tensor) => tensor.dispose())
    } else {
      rawPrediction.dispose()
    }
  } catch {
    inputTensor.dispose()
    return {
      region: fallbackRegion,
      statusMessage: 'ML detector failed at runtime. Using heuristic drink area.',
      coveragePercent: null,
      confidencePercent: null
    }
  }

  inputTensor.dispose()

  if (!maskTensor) {
    return {
      region: fallbackRegion,
      statusMessage: 'ML output was incompatible. Using heuristic drink area.',
      coveragePercent: null,
      confidencePercent: null
    }
  }

  const resizedMask = tf.tidy(() => {
    const expanded = maskTensor.expandDims(-1) as tf.Tensor3D
    const resized = tf.image.resizeBilinear(expanded, [img.height, img.width])
    return resized.squeeze() as tf.Tensor2D
  })
  const maskValues = await resizedMask.data()
  maskTensor.dispose()
  resizedMask.dispose()

  let activePixels = 0
  let activeConfidenceSum = 0
  for (let index = 0; index < maskValues.length; index++) {
    const value = maskValues[index]
    if (value >= drinkAreaModelConfig.maskThreshold) {
      activePixels++
      activeConfidenceSum += value
    }
  }

  if (!activePixels) {
    return {
      region: fallbackRegion,
      statusMessage: 'ML found no drink region. Using heuristic drink area.',
      coveragePercent: null,
      confidencePercent: null
    }
  }

  const coveragePercent = (activePixels / maskValues.length) * 100
  const confidencePercent = (activeConfidenceSum / activePixels) * 100

  return {
    region: {
      source: 'ml-mask',
      contains(x: number, y: number) {
        return maskValues[y * img.width + x] >= drinkAreaModelConfig.maskThreshold
      }
    },
    statusMessage: 'ML drink-area detector active.',
    coveragePercent,
    confidencePercent
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

function sanitizeInput(input: string, maxLength = 500): string {
  return input
    .trim()
    .slice(0, maxLength)
    .replace(/[<>\"']/g, '')
}

function sanitizeUsername(username: string): string {
  return sanitizeInput(username, 100).replace(/[^a-zA-Z0-9._-]/g, '')
}

function validateEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return emailRegex.test(email) && email.length <= 254
}

function getSessionToken() {
  if (typeof window === 'undefined') return ''
  return window.localStorage.getItem('matchaAuthToken') || window.sessionStorage.getItem('matchaAuthToken') || ''
}

function setSessionToken(token: string) {
  if (typeof window === 'undefined') return
  if (token) {
    window.localStorage.setItem('matchaAuthToken', token)
    return
  }

  window.localStorage.removeItem('matchaAuthToken')
  window.sessionStorage.removeItem('matchaAuthToken')
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
      throw new Error(text || `Request failed with status ${response.status}`)
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
  const [loadingMessage, setLoadingMessage] = useState('Connecting to ratings service...')
  const [authEmail, setAuthEmail] = useState('')
  const [authStage, setAuthStage] = useState<'form' | 'sent' | 'verifying'>('form')
  const [authError, setAuthError] = useState('')
  const [needsEmailLink, setNeedsEmailLink] = useState(false)
  const [linkEmail, setLinkEmail] = useState('')
  const [linkEmailSent, setLinkEmailSent] = useState(false)
  const [linkEmailError, setLinkEmailError] = useState('')
  const [isSubmittingLinkEmail, setIsSubmittingLinkEmail] = useState(false)
  const [emailLinkVerificationUrl, setEmailLinkVerificationUrl] = useState('')

  const [currentRating, setCurrentRating] = useState(0)
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
  const [friendQuery, setFriendQuery] = useState('')
  const [friendSuggestions, setFriendSuggestions] = useState<string[]>([])
  const [selectedFriend, setSelectedFriend] = useState('')
  const [friendEntries, setFriendEntries] = useState<RatingEntry[]>([])
  const [isSavingEntry, setIsSavingEntry] = useState(false)
  const [isLoadingFriendRatings, setIsLoadingFriendRatings] = useState(false)
  const [isLoadingExplorePlaces, setIsLoadingExplorePlaces] = useState(false)
  const [explorePlaces, setExplorePlaces] = useState<ExplorePlace[]>([])
  const [exploreUsers, setExploreUsers] = useState<ExploreUser[]>([])
  const [selectedExplorePlaceName, setSelectedExplorePlaceName] = useState('')
  const [selectedExplorePlaceEntries, setSelectedExplorePlaceEntries] = useState<RatingEntry[]>([])
  const [isExplorePlaceModalOpen, setIsExplorePlaceModalOpen] = useState(false)
  const [isLoadingExplorePlaceEntries, setIsLoadingExplorePlaceEntries] = useState(false)
  const [isExplorePlacesExpanded, setIsExplorePlacesExpanded] = useState(true)
  const [isExploreUsersExpanded, setIsExploreUsersExpanded] = useState(true)
  const [isMyLogsExpanded, setIsMyLogsExpanded] = useState(false)
  const [myLogsSearchTerm, setMyLogsSearchTerm] = useState('')
  const [isFriendLogsExpanded, setIsFriendLogsExpanded] = useState(false)
  const [friendLogsSearchTerm, setFriendLogsSearchTerm] = useState('')
  const [friendSort, setFriendSort] = useState<'highest' | 'lowest' | 'greenest' | 'newest' | 'oldest'>('highest')
  const [isFriendFilterOpen, setIsFriendFilterOpen] = useState(false)
  const [isFriendSearchOpen, setIsFriendSearchOpen] = useState(false)
  const [isRatingDragActive, setIsRatingDragActive] = useState(false)
  const [isEditRatingDragActive, setIsEditRatingDragActive] = useState(false)

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
        const response = await apiFetch<{ userName: string; email: string; token: string; isNewUser?: boolean }>('/auth/google/verify', {
          method: 'POST',
          body: JSON.stringify({ token: codeResponse.access_token, browserId })
        }).catch(async (error) => {
          const errorData = error instanceof Response ? await error.json() : { error: error.message }
          if (errorData.isNewUser) {
            sessionStorage.setItem('googleAccessToken', codeResponse.access_token)
            setRequiresManualName(true)
            setPendingUserName('')
            return null
          }
          throw error
        })

        if (response) {
          setSessionToken(response.token || '')
          localStorage.setItem('matchaUserName', response.userName)
          setCurrentUserName(response.userName)
          setRequiresManualName(false)
          setIsUserReady(true)
          setLoadingMessage('')
          void loadDrinkAreaModel().catch(() => undefined)
        }
      } catch (error) {
        setAuthError(error instanceof Error ? error.message : 'Google sign-in failed')
      } finally {
        setIsSubmittingName(false)
      }
    },
    onError: () => setAuthError('Google sign-in failed'),
    flow: 'implicit'
  })

  useEffect(() => {
    let mounted = true

    async function initUserSession() {
      try {
        const url = new URL(window.location.href)
        const authToken = url.searchParams.get('authToken')

        if (authToken) {
          setAuthStage('verifying')
          url.searchParams.delete('authToken')
          url.searchParams.delete('purpose')
          window.history.replaceState({}, '', url.toString())

          const session = await apiFetch<{ userName: string; email: string; token: string }>('/auth/verify', {
            method: 'POST',
            body: JSON.stringify({ token: authToken, browserId })
          })

          if (!mounted) return

          setSessionToken(session.token || '')
          localStorage.setItem('matchaUserName', session.userName)
          setCurrentUserName(session.userName)
          setRequiresManualName(false)
          setIsUserReady(true)
          setLoadingMessage('')
          void loadDrinkAreaModel().catch(() => undefined)
          return
        }

        const savedName = localStorage.getItem('matchaUserName') || ''
        const savedToken = getSessionToken()

        if (savedName && savedToken) {
          // Returning user with a cached session: skip the login prompt entirely.
          if (mounted) {
            setCurrentUserName(savedName)
            setRequiresManualName(false)
            setIsUserReady(true)
            setLoadingMessage('')
          }
          void loadDrinkAreaModel().catch(() => undefined)
          return
        }

        if (mounted) {
          setRequiresManualName(true)
          setLoadingMessage('')
        }
      } catch {
        if (!mounted) return
        setAuthStage('form')
        setAuthError('That link is invalid or has expired. Please request a new one below.')
        setRequiresManualName(true)
        setLoadingMessage('')
      }
    }

    void initUserSession()
    return () => {
      mounted = false
    }
  }, [browserId])

  function signOut() {
    setSessionToken('')
    localStorage.removeItem('matchaUserName')
    setCurrentUserName('')
    setPendingUserName('')
    setAuthEmail('')
    setAuthStage('form')
    setAuthError('')
    setRequiresManualName(true)
    setIsUserReady(false)
  }

  useEffect(() => {
    if (!isUserReady || !currentUserName) return

    let mounted = true
    apiFetch<{ linked: boolean }>('/auth/link-status')
      .then((status) => {
        if (mounted) setNeedsEmailLink(!status.linked)
      })
      .catch(() => undefined)

    return () => {
      mounted = false
    }
  }, [isUserReady, currentUserName])

  async function submitLinkEmail() {
    const email = linkEmail.trim().toLowerCase()
    if (!validateEmail(email)) {
      setLinkEmailError('Please enter a valid email address.')
      return
    }

    setIsSubmittingLinkEmail(true)
    setLinkEmailError('')
    try {
      const response = await apiFetch<{ ok: boolean; verificationLink?: string }>('/auth/link-email', {
        method: 'POST',
        body: JSON.stringify({ email })
      })
      setEmailLinkVerificationUrl(response.verificationLink || '')
      setLinkEmailSent(true)
    } catch (error) {
      setLinkEmailError(error instanceof Error ? error.message : 'Unable to send link. Please try again.')
    } finally {
      setIsSubmittingLinkEmail(false)
    }
  }


  async function submitAuthEmail() {
    const email = authEmail.trim().toLowerCase()
    if (!validateEmail(email)) {
      setAuthError('Please enter a valid email address.')
      return
    }

    setIsSubmittingName(true)
    setAuthError('')
    try {
      const safeCandidate = sanitizeUsername(pendingUserName.trim())
      const response = await apiFetch<{ ok: boolean; mode: 'login' | 'signup' | 'needs-username' }>('/auth/request-link', {
        method: 'POST',
        body: JSON.stringify({ email, userName: safeCandidate })
      })

      if (response.mode === 'needs-username') {
        setAuthError('This email is new. Please also enter a username to create your account.')
        return
      }

      setAuthStage('sent')
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Unable to send sign-in link. Please try again.')
    } finally {
      setIsSubmittingName(false)
    }
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
      setLoadingMessage('')
      sessionStorage.removeItem('googleAccessToken')
      void loadDrinkAreaModel().catch(() => undefined)
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Failed to create account.')
    } finally {
      setIsSubmittingName(false)
    }
  }

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

      await apiFetch<{ rating: RatingEntry }>('/ratings', {
        method: 'POST',
        body: JSON.stringify({
          userName: currentUserName,
          photo: resolvedPhoto,
          rating: currentRating,
          greenness: resolvedGreenness,
          location: location.trim(),
          thoughts: thoughts.trim()
        })
      })

      const updated = await apiFetch<{ ratings: RatingEntry[] }>(`/ratings?userName=${encodeURIComponent(currentUserName)}`)
      setMyEntries(updated.ratings)

      // Check for milestones
      const count = updated.ratings.length
      if (count === 1) {
        setMilestoneMessage('🎉 Your matcha journey starts here!')
      } else if (count === 10) {
        setMilestoneMessage('🏆 10 ratings! You\'re a true matcha enthusiast!')
      } else if (count === 25) {
        setMilestoneMessage('✨ 25 ratings! You\'re building an incredible collection!')
      } else if (count === 50) {
        setMilestoneMessage('🌟 50 ratings! You\'re a matcha connoisseur!')
      } else if (count === 100) {
        setMilestoneMessage('👑 100 ratings! You\'re a matcha legend!')
      }

      if (milestoneMessage) {
        setTimeout(() => setMilestoneMessage(''), 4000)
      }

      setCurrentRating(0)
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

    const response = await apiFetch<{ friends: string[] }>(`/friends/search?q=${encodeURIComponent(query.trim())}`)
    setFriendSuggestions(response.friends)
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
  }

  async function saveEntryEdit(entryId: number) {
    if (!currentUserName) {
      alert('Unable to save without a user session.')
      return
    }

    setIsSavingEntry(true)
    const overlayShownAt = Date.now()
    try {
      await apiFetch<{ rating: RatingEntry }>(`/ratings/${entryId}`, {
        method: 'PUT',
        body: JSON.stringify({
          userName: currentUserName,
          rating: editRating,
          location: editLocation.trim(),
          thoughts: editThoughts.trim()
        })
      })

      const updated = await apiFetch<{ ratings: RatingEntry[] }>(`/ratings?userName=${encodeURIComponent(currentUserName)}`)
      setMyEntries(updated.ratings)
      setIsEditingEntry(false)
      setSelectedEntryId(null)
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
      <main className="container py-5">
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
              {authError && <div className="alert alert-danger border mt-3 mb-0">{authError}</div>}
            </div>
          </section>
        ) : (
          <section className="card border-0 shadow-sm matcha-shell mx-auto" style={{ maxWidth: '28rem' }}>
            <div className="card-body p-3 p-md-4">
              <h1 className="h4 fw-bold text-success mb-2">Welcome to Sip &amp; Score</h1>
              <p className="text-muted mb-4">
                Sign in with Google to access your matcha ratings from any device.
              </p>
              <button
                type="button"
                className="btn btn-light w-100 d-flex align-items-center justify-content-center gap-2"
                onClick={() => googleLogin()}
                disabled={isSubmittingName}
                style={{ border: '1px solid #e0e0e0', padding: '0.75rem' }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24">
                  <text x="2" y="16" fontSize="14" fill="#1f5f34">G</text>
                </svg>
                {isSubmittingName ? 'Signing in…' : 'Sign in with Google'}
              </button>
              {authError && <div className="alert alert-danger border mt-3 mb-0">{authError}</div>}
            </div>
          </section>
        )}
      </main>
    )
  }
                  {authError && <div className="alert alert-warning border mt-3 mb-0">{authError}</div>}
                </>
              )}
              {loadingMessage && <div className="alert alert-warning border mt-3 mb-0">{loadingMessage}</div>}
            </div>
          </section>
        ) : (
          <div className="alert alert-warning border">{loadingMessage}</div>
        )}
      </main>
    )
  }

  return (
    <>
      <a className="skip-link" href="#main-content">Skip to content</a>
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
              <div className="d-flex justify-content-between align-items-start gap-3 mb-3">
                <div>
                  <h3 className="h5 fw-bold text-success mb-1">{selectedExplorePlaceName}</h3>
                  <div className="small text-muted">All ratings</div>
                </div>
                <button
                  type="button"
                  className="btn btn-outline-secondary btn-sm explore-place-close"
                  onClick={closeExplorePlaceRatings}
                  aria-label="Close place ratings popup"
                >
                  X
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
                            <div className="rating-badge mb-2">Rating: <span className="rating-value">{entry.rating.toFixed(1)}</span> / 5.0</div>
                            <div>Greenness: {entry.greenness.toFixed(1)} / 100.0</div>
                            <div>Total score: {getWeightedScore(entry.rating, entry.greenness).toFixed(1)} / 200.0</div>
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
              <h3 className="h5 fw-bold text-success mb-4">Upload Picture</h3>
              
              <div className="d-flex flex-column gap-2">
                <button
                  type="button"
                  className="btn btn-success w-100 text-start"
                  onClick={() => {
                    setIsUploadMenuOpen(false)
                    setIsCameraModalOpen(true)
                  }}
                >
                  Open Camera
                </button>
                
                <button
                  type="button"
                  className="btn btn-success w-100 text-start"
                  onClick={openPhotoLibrary}
                >
                  Photo Library
                </button>
              </div>
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
                  className="filter-menu-close"
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
                  className="filter-menu-close"
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
                className="btn btn-outline-secondary btn-sm"
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
            <div className="notes-modal-header d-flex justify-content-between align-items-center p-4 border-bottom">
              <h3 className="h5 fw-bold text-success mb-0">Your thoughts...</h3>
              <button
                type="button"
                className="btn btn-link text-muted p-0"
                onClick={() => setIsNotesModalOpen(false)}
                aria-label="Close notes"
              >
                Close
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

      <nav className="navbar navbar-expand-lg navbar-light bg-white border-bottom sticky-top soft-nav" aria-label="Main navigation">
        <div className="container d-flex flex-column flex-lg-row justify-content-between align-items-start align-items-lg-center gap-2">
          <div className="d-flex flex-column">
            <span className="navbar-brand fw-semibold text-success mb-0">Sip &amp; Score</span>
            <small className="text-muted nav-user">
              {currentUserName}
              <button
                type="button"
                className="btn btn-link btn-sm text-muted p-0 ms-2 align-baseline"
                onClick={signOut}
              >
                Sign out
              </button>
            </small>
          </div>

          <div className="d-flex align-items-center gap-2 nav-actions w-100">
            <button
              type="button"
              className={`btn btn-sm ${activePage === 'home' ? 'btn-success' : 'btn-outline-success'}`}
              onClick={() => setActivePage('home')}
            >
              My Log
            </button>
            <button
              type="button"
              className={`btn btn-sm ${activePage === 'friends' ? 'btn-success' : 'btn-outline-success'}`}
              onClick={() => setActivePage('friends')}
            >
              Friends
            </button>
            <button
              type="button"
              className={`btn btn-sm ${activePage === 'explore' ? 'btn-success' : 'btn-outline-success'}`}
              onClick={() => setActivePage('explore')}
            >
              Explore
            </button>
          </div>
        </div>
      </nav>

      {activePage === 'home' && (
        <main id="main-content" className="container py-3 py-md-5 px-3 px-md-4" tabIndex={-1}>
          <div className="card shadow-sm border-0 matcha-shell">
            <div className="card-body p-3 p-md-4">
              <h1 className="display-6 fw-bold mb-3 text-success">Log Rating</h1>

              {needsEmailLink && (
                <div className="alert alert-warning border mb-3">
                  {linkEmailSent ? (
                    <span>Check <strong>{linkEmail.trim()}</strong> for a link to finish securing your account.</span>
                  ) : (
                    <>
                      <p className="mb-2">
                        Add an email to your account so you can sign back in from any device without losing your ratings.
                      </p>
                      <div className="d-flex flex-column flex-sm-row gap-2">
                        <input
                          type="email"
                          className="form-control"
                          value={linkEmail}
                          onChange={(event) => setLinkEmail(event.target.value)}
                          placeholder="you@example.com"
                          autoComplete="email"
                        />
                        <button
                          type="button"
                          className="btn btn-success text-nowrap"
                          onClick={() => void submitLinkEmail()}
                          disabled={!linkEmail.trim() || isSubmittingLinkEmail}
                        >
                          {isSubmittingLinkEmail ? 'Sending…' : 'Add email'}
                        </button>
                      </div>
                      {linkEmailError && <div className="text-danger small mt-2 mb-0">{linkEmailError}</div>}
                    </>
                  )}
                </div>
              )}

              <div className="mb-3">
                <div className="form-label fw-semibold">Enter the cafe or shop name.</div>
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
                    placeholder="Matcha place name (e.g. Cha Cha Matcha)"
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

              <div className="mb-3">
                <label className="form-label fw-semibold">Picture</label>
                <div className="d-flex gap-2 flex-wrap align-items-center justify-content-center justify-content-md-start">
                  <button 
                    type="button" 
                    className="btn btn-success" 
                    onClick={() => setIsUploadMenuOpen(true)}
                  >
                    Upload Picture
                  </button>
                  {photoDataUrl && photoDataUrl !== noPhotoPlaceholderUrl && (
                    <span className="small text-success fw-semibold">Photo ready</span>
                  )}
                  {photoDataUrl === noPhotoPlaceholderUrl && (
                    <span className="small text-muted fw-semibold">No photo selected</span>
                  )}
                  {cameraError && <span className="small text-danger align-self-center">{cameraError}</span>}
                </div>
              </div>

              {photoDataUrl && photoDataUrl !== noPhotoPlaceholderUrl && (
                <div className="preview-wrap mb-3">
                  <img src={photoDataUrl} alt="Matcha preview" className="preview-image" loading="lazy" decoding="async" />
                </div>
              )}

              <div className="mb-3 text-success fw-semibold">
                {matchaGreenness !== null ? `Greenness: ${matchaGreenness.toFixed(1)}/100` : 'Greenness score pending'}
              </div>

              {mlCoveragePercent !== null && mlConfidencePercent !== null && (
                <div className="mb-3 small detector-chip">
                  <div>{mlStatus}</div>
                  <div className="detector-metrics">
                    Coverage: {mlCoveragePercent.toFixed(1)}%
                    {' | '}
                    Confidence: {mlConfidencePercent.toFixed(1)}%
                  </div>
                </div>
              )}

              <div className="mb-3">
                <label className="form-label fw-semibold d-block">Rating</label>
                <div className="small text-muted mb-2">Half-star and 0-star ratings are allowed. Tap on a star to set a value.</div>
                <div id="star-rating" className="d-flex gap-2 rating-star-row">
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
                <button type="button" className="btn btn-outline-secondary btn-sm mt-2" onClick={() => setCurrentRating(0)}>
                  Set 0 stars
                </button>
                <div className="rating-badge mt-2">Selected: <span className="rating-value">{currentRating.toFixed(1)}</span> / 5.0</div>
              </div>

              <div className="mb-3">
                <label className="form-label fw-semibold">Notes</label>
                <button
                  type="button"
                  className="form-control text-start text-muted"
                  onClick={() => setIsNotesModalOpen(true)}
                  style={{ minHeight: '44px', padding: '0.375rem 0.75rem', cursor: 'pointer' }}
                >
                  {thoughts.trim() ? thoughts.substring(0, 50) + (thoughts.length > 50 ? '...' : '') : 'What stood out about this matcha?'}
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
                          <div>Rating: {entry.rating.toFixed(1)} / 5.0</div>
                          <div>Greenness: {entry.greenness.toFixed(1)} / 100.0</div>
                          <div>Total score: {getWeightedScore(entry.rating, entry.greenness).toFixed(1)} / 200.0</div>
                        </div>
                        {entry.thoughts && <p className="mt-2 mb-0">{entry.thoughts}</p>}
                      </div>
                    </div>
                    <div className="entry-hint-icon" aria-hidden="true">✎</div>
                  </div>

                  {selectedEntryId === entry.id && (
                    <div className="entry-overlay" onClick={(event) => event.stopPropagation()}>
                      {!isEditingEntry && (
                        <div className="entry-overlay-actions d-flex flex-column gap-2 align-items-center">
                          <div className="text-white small fw-semibold mb-2">Tap to edit</div>
                          <button type="button" className="btn btn-light btn-sm" onClick={() => startEntryEdit(entry)} aria-label="Edit rating">
                            <span className="action-icon-wrap">
                              <img src={pencilIconUrl} alt="" className="action-icon" />
                            </span>
                            Edit
                          </button>
                          <button
                            type="button"
                            className="btn btn-danger btn-sm"
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
                          <button
                            type="button"
                            className="btn btn-outline-light btn-sm"
                            onClick={() => {
                              setSelectedEntryId(null)
                              setIsEditingEntry(false)
                            }}
                          >
                            Close
                          </button>
                        </div>
                      )}

                      {isEditingEntry && (
                        <div className="entry-edit-panel p-3 bg-white rounded shadow-sm">
                          <label className="form-label fw-semibold mb-1">Edit rating</label>
                          <div className="d-flex gap-2 mb-2 rating-star-row">
                            {Array.from({ length: 5 }, (_, idx) => {
                              const starIndex = idx + 1
                              const fillAmount = Math.max(0, Math.min(1, editRating - idx))
                              return (
                                <button
                                  type="button"
                                  key={`edit-${entry.id}-${starIndex}`}
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
                            className="btn btn-outline-secondary btn-sm mb-2"
                            onClick={(event) => {
                              event.stopPropagation()
                              setEditRating(0)
                            }}
                          >
                            Set 0 stars
                          </button>

                          <input
                            type="text"
                            className="form-control mb-2"
                            value={editLocation}
                            onChange={(event) => setEditLocation(event.target.value)}
                            placeholder="Matcha place name (e.g. Cha Cha Matcha)"
                          />

                          <textarea
                            className="form-control mb-2"
                            rows={2}
                            value={editThoughts}
                            onChange={(event) => setEditThoughts(event.target.value)}
                            placeholder="Your notes"
                          />

                          <div className="d-flex gap-2">
                            <button type="button" className="btn btn-success btn-sm" onClick={() => void saveEntryEdit(entry.id)}>
                              Save
                            </button>
                            <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => setIsEditingEntry(false)}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
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
              <h2 className="h3 fw-bold text-success mb-3">Friends</h2>
              <div className="row g-2 align-items-end">
                <div className="col-12 col-md-8">
                  <label className="form-label fw-semibold">Search</label>
                  <input
                    type="text"
                    className="form-control"
                    value={friendQuery}
                    placeholder="Type a friend's name"
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
                    View Log
                  </button>
                </div>
              </div>

              {friendSuggestions.length > 0 && (
                <div className="mt-3 d-flex flex-wrap gap-2">
                  {friendSuggestions.map((friend) => (
                    <button
                      key={friend}
                      type="button"
                      className="btn btn-outline-success btn-sm"
                      onClick={() => void openFriendRatings(friend)}
                      disabled={isLoadingFriendRatings}
                    >
                      {friend}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section>
            <div className="d-flex justify-content-between align-items-center gap-2 mb-3">
              <h3 className="h4 fw-bold text-success mb-0" style={{ cursor: 'pointer' }} onClick={() => setIsFriendLogsExpanded(!isFriendLogsExpanded)}>
                {selectedFriend ? selectedFriend : 'Choose friend'}
              </h3>
              {selectedFriend && (
                isFriendSearchOpen ? (
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
                )
              )}
            </div>
            <div className="d-flex flex-column gap-3">
              {selectedFriend && filteredFriendEntries.length === 0 && (
                <div className="alert alert-light border">No ratings found for this friend.</div>
              )}

              {(isFriendLogsExpanded || !selectedFriend ? filteredFriendEntries : filteredFriendEntries.slice(0, 3)).map((entry) => (
                <article key={entry.id} className="card border-0 shadow-sm">
                  <div className="card-body d-flex gap-3 align-items-start">
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
                        <div>Rating: {entry.rating.toFixed(1)} / 5.0</div>
                        <div>Greenness: {entry.greenness.toFixed(1)} / 100.0</div>
                        <div>Total score: {getWeightedScore(entry.rating, entry.greenness).toFixed(1)} / 200.0</div>
                      </div>
                      {entry.thoughts && <p className="mt-2 mb-0">{entry.thoughts}</p>}
                    </div>
                  </div>
                </article>
              ))}              {selectedFriend && filteredFriendEntries.length > 3 && !isFriendLogsExpanded && (
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
        </main>
      )}

      {activePage === 'explore' && (
        <main id="main-content" className="container py-3 py-md-5 px-3 px-md-4" tabIndex={-1}>
          <section className="card border-0 shadow-sm matcha-shell mb-4">
            <div className="card-body p-3 p-md-4">
              <h2 className="h3 fw-bold text-success mb-2">Community</h2>
  
              <section className="mb-4">
                <h3 className="h5 fw-bold text-success mb-2" style={{ cursor: 'pointer' }} onClick={() => setIsExplorePlacesExpanded((prev) => !prev)}>
                  Places {isExplorePlacesExpanded ? '▼' : '▶'}
                </h3>
                <p className="text-muted mb-3">
                Ranked by community
                </p>


                {isExplorePlacesExpanded && explorePlaces.length === 0 && (
                  <div className="alert alert-light border mb-0">No place data yet. Add ratings to build rankings.</div>
                )}

                {isExplorePlacesExpanded && explorePlaces.length > 0 && (
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

              <hr className="my-4" />
              <section>
                <h3 className="h5 fw-bold text-success mb-2" style={{ cursor: 'pointer' }} onClick={() => setIsExploreUsersExpanded((prev) => !prev)}>
                  Users {isExploreUsersExpanded ? '▼' : '▶'}
                </h3>
                <p className="text-muted mb-3">Community leaderboard</p>

                {isExploreUsersExpanded && exploreUsers.length === 0 && <div className="alert alert-light border mb-0">No user place data yet.</div>}

                {isExploreUsersExpanded && exploreUsers.length > 0 && (
                  <div className="d-flex flex-column gap-2">
                    {exploreUsers.map((user, index) => (
                      <article key={user.userName} className="card border-0 shadow-sm">
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
                          <div className="text-success fw-bold">{user.placeCount}</div>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            </div>
          </section>
        </main>
      )}
    </>
  )
}

export default App
