import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { useGoogleLogin } from '@react-oauth/google'
import * as Sentry from '@sentry/react'
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

const FLAVOR_LIST = ['Chocolatey', 'nutty', 'sweet', 'sugary', 'creamy', 'umami', 'earthy', 'vegetal', 'floral', 'astringent', 'bitter', 'mellow'] as const
const BODY_PROFILE_OPTIONS: Array<{ value: 'full-bodied' | 'medium' | 'milky'; label: string; desc: string }> = [
  { value: 'full-bodied', label: 'Full-bodied', desc: 'Rich, thick, and coats the tongue — a bold matcha-forward mouthfeel.' },
  { value: 'medium', label: 'Medium', desc: 'Balanced weight and creaminess — not too heavy, not too light.' },
  { value: 'milky', label: 'Milky', desc: 'Lighter and creamier — milk or foam takes the lead over the matcha.' }
]

// Ordering by color group so tags of the same palette sit next to each other.
const FLAVOR_COLOR_ORDER: Record<string, number> = {
  chocolatey: 0, nutty: 1,
  sweet: 2, sugary: 3, creamy: 4,
  umami: 5, earthy: 6, vegetal: 7, floral: 8,
  astringent: 9, bitter: 10,
  mellow: 11,
}
function sortFlavorsByColor(flavors: string[]): string[] {
  return [...flavors].sort((a, b) => {
    const ra = FLAVOR_COLOR_ORDER[String(a).toLowerCase()] ?? 99
    const rb = FLAVOR_COLOR_ORDER[String(b).toLowerCase()] ?? 99
    return ra - rb
  })
}

function isKnownFlavor(key: string) {
  return FLAVOR_LIST.some((f) => f === key)
}

function getBodyProfile(prefs?: Record<string, number>): '' | 'full-bodied' | 'medium' | 'milky' {
  if (!prefs) return ''
  for (const opt of BODY_PROFILE_OPTIONS) {
    if (Number(prefs[`__body:${opt.value}`]) > 0) return opt.value
  }
  return ''
}

function setBodyProfile(prefs: Record<string, number>, body: '' | 'full-bodied' | 'medium' | 'milky'): Record<string, number> {
  const next = { ...prefs }
  for (const opt of BODY_PROFILE_OPTIONS) {
    delete next[`__body:${opt.value}`]
  }
  if (body) next[`__body:${body}`] = 100
  return next
}

function bodyProfileLabel(body: string) {
  const opt = BODY_PROFILE_OPTIONS.find((o) => o.value === body)
  return opt ? opt.label : ''
}

// Per-flavor palette. Returns background + text + border color for a tag/bubble.
function flavorColor(flavor: string): { bg: string; fg: string; border: string } {
  const key = String(flavor || '').toLowerCase()
  if (key === 'chocolatey' || key === 'nutty') return { bg: '#815355', fg: '#ffffff', border: '#5c3839' }
  if (key === 'sugary' || key === 'sweet' || key === 'creamy') return { bg: '#E0BAD7', fg: '#5a2a4b', border: '#c290b3' }
  if (['earthy', 'vegetal', 'floral', 'umami'].includes(key)) return { bg: '#63a375', fg: '#ffffff', border: '#4a7d5a' }
  if (key === 'astringent' || key === 'bitter') return { bg: '#F8FA90', fg: '#5c5d1c', border: '#c9cb6d' }
  if (key === 'mellow') return { bg: '#A9DEF9', fg: '#1e4a5f', border: '#7fbbdc' }
  return { bg: '#82D99E', fg: '#0b6e4f', border: '#0b6e4f' }
}

// Body palette: varying shades of #3AAFB9.
function bodyColor(body: string): { bg: string; fg: string; border: string } {
  if (body === 'full-bodied') return { bg: '#26808a', fg: '#ffffff', border: '#1a5f66' }
  if (body === 'medium') return { bg: '#3AAFB9', fg: '#ffffff', border: '#26808a' }
  if (body === 'milky') return { bg: '#8ed5db', fg: '#0e3d43', border: '#5aa9b1' }
  return { bg: '#3AAFB9', fg: '#ffffff', border: '#26808a' }
}

function BodyInfoIcon() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: Event) => {
      const target = e.target as HTMLElement | null
      if (target && target.closest('[data-body-info-root]')) return
      setOpen(false)
    }
    document.addEventListener('click', onDoc)
    return () => document.removeEventListener('click', onDoc)
  }, [open])
  return (
    <span data-body-info-root style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}
        aria-label="What is matcha body?"
        aria-expanded={open}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '1.15rem',
          height: '1.15rem',
          borderRadius: '50%',
          background: '#e9ecef',
          color: '#495057',
          fontSize: '0.75rem',
          fontWeight: 700,
          border: '1px solid #ced4da',
          padding: 0,
          lineHeight: 1,
          cursor: 'pointer',
          fontStyle: 'italic',
          fontFamily: 'Georgia, serif'
        }}
      >
        i
      </button>
      {open && (
        <span
          role="tooltip"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: '50%',
            transform: 'translateX(-50%)',
            background: '#212529',
            color: '#fff',
            padding: '0.5rem 0.65rem',
            borderRadius: '0.4rem',
            fontSize: '0.75rem',
            fontWeight: 400,
            lineHeight: 1.35,
            width: 'max-content',
            maxWidth: 'min(240px, 80vw)',
            whiteSpace: 'normal',
            textAlign: 'left',
            boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
            zIndex: 2000,
            pointerEvents: 'none'
          }}
        >
          The “body” of matcha refers to the perceived weight, fullness, and texture of the tea in your mouth.
        </span>
      )}
    </span>
  )
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

// Per-user localStorage cache keys so critical UI state (ratings list,
// preferences, following list) survives a bad network / offline restart
// and reappears instantly on next launch instead of flashing empty.
function cacheKey(userName: string, kind: string): string {
  const safe = String(userName || '').toLowerCase().trim()
  return `matcha:${safe}:${kind}`
}
function readCache<T>(userName: string, kind: string): T | null {
  if (!userName) return null
  try {
    const raw = localStorage.getItem(cacheKey(userName, kind))
    if (!raw) return null
    return JSON.parse(raw) as T
  } catch { return null }
}
function writeCache(userName: string, kind: string, value: unknown): void {
  if (!userName) return
  try {
    localStorage.setItem(cacheKey(userName, kind), JSON.stringify(value))
  } catch { /* quota exceeded / private mode — ignore */ }
}

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

class ApiError extends Error {
  status: number
  data: Record<string, unknown>

  constructor(status: number, data: Record<string, unknown>, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.data = data
  }
}

function friendlyErrorMessage(status: number): string {
  if (status === 401 || status === 403) return 'Please sign in again to continue.'
  if (status === 404) return 'We couldn\'t find what you were looking for.'
  if (status === 409) return 'That name is already taken. Please choose another.'
  if (status >= 500) return 'Something went wrong on our end. Please try again.'
  return 'Something went wrong. Please try again.'
}

function isPlausibleLocationName(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length < 2 || trimmed.length > 120) return false
  if (!/[a-zA-Z\u00C0-\u024F]/.test(trimmed)) return false
  if (/^[^a-zA-Z0-9]+$/.test(trimmed)) return false
  if (/(.)\1{4,}/.test(trimmed)) return false
  const letters = trimmed.replace(/[^a-zA-Z\u00C0-\u024F]/g, '')
  if (letters.length >= 6) {
    const uniqueLetters = new Set(letters.toLowerCase()).size
    if (uniqueLetters < 3) return false
    if (!/[aeiouAEIOU\u00C0-\u024F]/.test(letters)) return false
  }
  return true
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
      let data: Record<string, unknown> = {}
      let serverMessage = ''
      try {
        const parsed = JSON.parse(text)
        if (parsed && typeof parsed === 'object') {
          data = parsed as Record<string, unknown>
          if (typeof data.error === 'string') {
            serverMessage = data.error
          }
        }
      } catch {
        // Non-JSON body — ignore it; never surface raw HTML/text to the user.
      }

      const isSafeServerMessage =
        !!serverMessage &&
        serverMessage.length <= 200 &&
        !serverMessage.includes('{') &&
        !serverMessage.includes('<')
      const userMessage = isSafeServerMessage ? serverMessage : friendlyErrorMessage(response.status)
      throw new ApiError(response.status, data, userMessage)
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
  const [ratingFlavorPrefs, setRatingFlavorPrefs] = useState<Record<string, number>>({ sweet: 0, nutty: 0, umami: 0, vegetal: 0, sugary: 0, astringent: 0, creamy: 0, floral: 0, earthy: 0, Chocolatey: 0, mellow: 0, bitter: 0 })
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
  const [isEditNotesModalOpen, setIsEditNotesModalOpen] = useState(false)
  const [isNewLogOpen, setIsNewLogOpen] = useState(false)
  const [milestoneMessage, setMilestoneMessage] = useState('')
  const [photoDataUrl, setPhotoDataUrl] = useState('')
  const [matchaGreenness, setMatchaGreenness] = useState<number | null>(null)
  const [isAnalyzingGreenness, setIsAnalyzingGreenness] = useState(false)
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
  const [selectedEntryId, setSelectedEntryId] = useState<number | null>(null)
  const [isEditingEntry, setIsEditingEntry] = useState(false)
  const [editRating, setEditRating] = useState(0)
  const [editLocation, setEditLocation] = useState('')
  const [editThoughts, setEditThoughts] = useState('')
  const [editEntryPhoto, setEditEntryPhoto] = useState<string>('')
  const [editFlavorPrefs, setEditFlavorPrefs] = useState<Record<string, number>>({})
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
  const [communityActiveTab, setCommunityActiveTab] = useState<'search' | 'following' | 'recommendations'>('recommendations')
  const [similarUsers, setSimilarUsers] = useState<Array<{ userName: string; flavors: string[]; body?: string; matchScore: number }>>([])
  const [isLoadingSimilarUsers, setIsLoadingSimilarUsers] = useState(false)
  const [similarPlaces, setSimilarPlaces] = useState<Array<{ location: string; flavors: string[]; body?: string; matchScore: number }>>([])
  const [isLoadingSimilarPlaces, setIsLoadingSimilarPlaces] = useState(false)
  const [recsRefreshKey, setRecsRefreshKey] = useState(0)
  const [similarUsersVisible, setSimilarUsersVisible] = useState(10)
  const [friendModalUser, setFriendModalUser] = useState('')
  const [friendModalEntries, setFriendModalEntries] = useState<RatingEntry[]>([])
  const [isFriendModalOpen, setIsFriendModalOpen] = useState(false)
  const [isLoadingFriendModal, setIsLoadingFriendModal] = useState(false)
  const [friendModalUserPrefs, setFriendModalUserPrefs] = useState<{ flavors: string[]; body: string }>({ flavors: [], body: '' })

  const friendModalRank = useMemo(() => {
    if (!friendModalUser) return null
    const idx = exploreUsers.findIndex((u) => u.userName.toLowerCase() === friendModalUser.toLowerCase())
    return idx >= 0 ? idx + 1 : null
  }, [friendModalUser, exploreUsers])

  const friendModalPlaceCount = useMemo(() => {
    const set = new Set<string>()
    friendModalEntries.forEach((e) => {
      const l = (e.location || '').trim().toLowerCase()
      if (l) set.add(l)
    })
    return set.size
  }, [friendModalEntries])

  const friendModalPrefs = useMemo(() => {
    return {
      flavors: sortFlavorsByColor(friendModalUserPrefs.flavors.filter(isKnownFlavor)),
      body: friendModalUserPrefs.body,
    }
  }, [friendModalUserPrefs])
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [currentOnboardingSlide, setCurrentOnboardingSlide] = useState(0)
  const [selectedExplorePlaceName, setSelectedExplorePlaceName] = useState('')
  const [selectedExplorePlaceEntries, setSelectedExplorePlaceEntries] = useState<RatingEntry[]>([])
  const [isExplorePlaceModalOpen, setIsExplorePlaceModalOpen] = useState(false)
  const [isLoadingExplorePlaceEntries, setIsLoadingExplorePlaceEntries] = useState(false)
  const [myLogsVisibleCount, setMyLogsVisibleCount] = useState(10)
  const [myLogsSearchTerm, setMyLogsSearchTerm] = useState('')
  const [isFriendLogsExpanded, setIsFriendLogsExpanded] = useState(false)
  const [friendLogsSearchTerm, setFriendLogsSearchTerm] = useState('')
  const [friendSort, setFriendSort] = useState<'highest' | 'lowest' | 'greenest' | 'newest' | 'oldest'>('highest')
  const [isFriendFilterOpen, setIsFriendFilterOpen] = useState(false)
  const [isFriendSearchOpen, setIsFriendSearchOpen] = useState(false)

  // Phase 2 & 3 features
  const [pendingMagicEmail, setPendingMagicEmail] = useState('')
  const [isMagicLinkSent, setIsMagicLinkSent] = useState(false)
  const [isPreferencesModalOpen, setIsPreferencesModalOpen] = useState(false)
  const [isProfileDrawerOpen, setIsProfileDrawerOpen] = useState(false)

  const [isPrivacyPolicyModalOpen, setIsPrivacyPolicyModalOpen] = useState(false)

  const [userFlavors, setUserFlavors] = useState<string[]>([])
  const [userBodyPref, setUserBodyPref] = useState<'' | 'full-bodied' | 'medium' | 'milky'>(() => {
    try {
      const v = localStorage.getItem('matchaBodyPref')
      if (v === 'full-bodied' || v === 'medium' || v === 'milky') return v
    } catch { /* ignore */ }
    return ''
  })
  const [likedRatingsSet, setLikedRatingsSet] = useState<Set<number>>(new Set())
  const [followingSet, setFollowingSet] = useState<Set<string>>(new Set())

  const showLoadingOverlay = isSavingEntry || isLoadingFriendRatings || isLoadingExplorePlaces
  const loadingOverlayText = isSavingEntry
    ? 'Brewing your memory...'
    : isLoadingExplorePlaces
      ? 'Whisking up the leaderboard...'
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
          if (error instanceof ApiError) {
            const potentialAccounts = Array.isArray(error.data.potentialAccounts)
              ? (error.data.potentialAccounts as string[])
              : []
            if (potentialAccounts.length > 0) {
              sessionStorage.setItem('googleAccessToken', codeResponse.access_token)
              setPotentialAccounts(potentialAccounts)
              setAuthMode('confirm-account')
              return
            }
            if (error.data.isNewUser === true) {
              sessionStorage.setItem('googleAccessToken', codeResponse.access_token)
              setRequiresManualName(true)
              setPendingUserName('')
              return
            }
          }
          throw error
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
    setRequiresManualName(false)
    setPendingUserName('')
  }, [])

  // Filter state resets naturally on a fresh cold start (module re-executes,
  // useState('highest') runs again). We intentionally do NOT reset on
  // visibilitychange/pageshow so briefly backgrounding the app preserves the
  // user's current sort choice.
  useEffect(() => {
    setIsMyRatingsFilterOpen(false)
  }, [])

  // Reset My Log sort when the user navigates away from the home tab so that
  // returning to it always shows the canonical default ranking. Also clear any
  // in-progress New Log draft so reopening it starts fresh.
  useEffect(() => {
    if (activePage !== 'home') {
      setMyRatingsSort('highest')
      setIsMyRatingsFilterOpen(false)
      setIsNewLogOpen(false)
      setCurrentRating(0)
      setRatingFlavorPrefs({ sweet: 0, nutty: 0, umami: 0, vegetal: 0, sugary: 0, astringent: 0, creamy: 0, floral: 0, earthy: 0, Chocolatey: 0, mellow: 0, bitter: 0 })
      setLocation('')
      setThoughts('')
      setPhotoDataUrl('')
      setMatchaGreenness(null)
      if (photoInputRef.current) {
        photoInputRef.current.value = ''
      }
      // Also clear inline friend-ratings page so it doesn't stick around when
      // returning to Following after previously viewing a friend's full page.
      setSelectedFriend('')
      setFriendEntries([])
    }
  }, [activePage])

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

    // Hydrate immediately from cache so slow / offline networks don't leave
    // the user staring at an empty list. The server fetch below will then
    // reconcile if it succeeds; if it fails, we keep the cached copy.
    const cachedRatings = readCache<RatingEntry[]>(currentUserName, 'ratings')
    if (cachedRatings && Array.isArray(cachedRatings) && cachedRatings.length > 0) {
      setMyEntries(cachedRatings)
      setIsMyRatingsLoading(false)
    }

    async function loadMyRatings() {
      setIsMyRatingsLoading(true)
      try {
        const response = await fetchWithRetry(
          () => apiFetch<{ ratings: RatingEntry[] }>(`/ratings?userName=${encodeURIComponent(currentUserName)}`),
          2
        )
        if (cancelled) return

        setMyEntries(response.ratings)
        writeCache(currentUserName, 'ratings', response.ratings)

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
              const merged = Array.from(byId.values())
              writeCache(currentUserName, 'ratings', merged)
              return merged
            })
            localStorage.setItem(refreshKey, '1')
          }
        }
      } catch {
        // Network failed — DO NOT wipe existing entries. Leave whatever we
        // hydrated from cache (or the previous session's state) alone so
        // the user doesn't lose their list on a bad connection.
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

    // Hydrate from cache first so the Following pill count is right
    // immediately, even on a bad connection or fresh cold-start offline.
    const cachedFollowing = readCache<string[]>(currentUserName, 'following')
    if (cachedFollowing && Array.isArray(cachedFollowing)) {
      setFollowingSet(new Set(cachedFollowing))
    }

    async function loadFollowingList() {
      try {
        const response = await apiFetch<{ following: string[] }>('/follows/list')
        if (!cancelled) {
          setFollowingSet(new Set(response.following))
          writeCache(currentUserName, 'following', response.following)
        }
      } catch (error) {
        console.error('Failed to load following list (keeping cached copy):', error)
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
    if (communityActiveTab !== 'recommendations' || !currentUserName) {
      return
    }
    if (userFlavors.length === 0 && !userBodyPref) {
      return
    }

    setIsLoadingSimilarUsers(true)
    setIsLoadingSimilarPlaces(true)

    Promise.all([
      apiFetch<{ similarUsers: Array<{ userName: string; flavors: string[]; body?: string; matchScore: number }> }>(`/similar-users?userName=${encodeURIComponent(currentUserName)}&_r=${recsRefreshKey}`),
      apiFetch<{ similarPlaces: Array<{ location: string; flavors: string[]; body?: string; matchScore: number }> }>(`/similar-places?userName=${encodeURIComponent(currentUserName)}&flavors=${encodeURIComponent(userFlavors.join(','))}&body=${encodeURIComponent(userBodyPref)}&_r=${recsRefreshKey}`)
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
  }, [communityActiveTab, currentUserName, userFlavors, userBodyPref, recsRefreshKey])

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
    function clearDragState() {}

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
        if (data?.flavors && Array.isArray(data.flavors)) {
          const bodyEntry = data.flavors.find((f) => typeof f === 'string' && f.startsWith('__body:'))
          const cleanFlavors = data.flavors.filter((f) => typeof f === 'string' && !f.startsWith('__body:'))
          setUserFlavors(cleanFlavors)
          if (bodyEntry) {
            const b = bodyEntry.slice('__body:'.length)
            if (b === 'full-bodied' || b === 'medium' || b === 'milky') setUserBodyPref(b)
          }
        }
      } catch (error) {
        console.error('Failed to load preferences:', error)
      }
    }

    loadPreferences()
  }, [isPreferencesModalOpen])

  useEffect(() => {
    if (!isUserReady || !currentUserName) return

    // Hydrate from cache first so preferences stick across offline/data
    // switches even if the server fetch fails or returns empty on a
    // brand-new session.
    const cachedFlavors = readCache<string[]>(currentUserName, 'flavors')
    if (cachedFlavors && Array.isArray(cachedFlavors) && cachedFlavors.length > 0) {
      setUserFlavors(cachedFlavors)
    }

    async function loadUserPreferences() {
      try {
        const data = await apiFetch<{ flavors?: string[] }>('/preferences')
        if (data?.flavors && Array.isArray(data.flavors)) {
          const bodyEntry = data.flavors.find((f) => typeof f === 'string' && f.startsWith('__body:'))
          const cleanFlavors = data.flavors.filter((f) => typeof f === 'string' && !f.startsWith('__body:'))
          setUserFlavors(cleanFlavors)
          writeCache(currentUserName, 'flavors', cleanFlavors)
          if (bodyEntry) {
            const b = bodyEntry.slice('__body:'.length)
            if (b === 'full-bodied' || b === 'medium' || b === 'milky') {
              setUserBodyPref(b)
              localStorage.setItem('matchaBodyPref', b)
            }
          }
        }
      } catch (error) {
        console.error('Failed to load user preferences (keeping cached copy):', error)
      }
    }

    loadUserPreferences()
  }, [isUserReady, currentUserName])

  // Mirror followingSet + myEntries to localStorage whenever they change,
  // so the very next launch (esp. offline) starts with the last-known-good
  // list instead of empty.
  useEffect(() => {
    if (!currentUserName) return
    writeCache(currentUserName, 'following', Array.from(followingSet))
  }, [currentUserName, followingSet])

  useEffect(() => {
    if (!currentUserName || myEntries.length === 0) return
    writeCache(currentUserName, 'ratings', myEntries)
  }, [currentUserName, myEntries])

  // If the user opens the Recs tab without any flavor prefs set, auto-open
  // the preferences modal so they can set them right away (Recs is useless
  // without prefs). Fires at most once per session so we don't fight the
  // user if they close it deliberately.
  const hasAutoPromptedPrefsRef = useRef(false)
  useEffect(() => {
    if (
      activePage === 'friends' &&
      communityActiveTab === 'recommendations' &&
      isUserReady &&
      userFlavors.length === 0 &&
      !hasAutoPromptedPrefsRef.current
    ) {
      hasAutoPromptedPrefsRef.current = true
      setIsProfileDrawerOpen(true)
      setIsPreferencesModalOpen(true)
    }
  }, [activePage, communityActiveTab, isUserReady, userFlavors.length])

  // Whenever the user navigates AWAY from the Recs tab, close any stale
  // prefs drawer/modal so it doesn't linger behind the next page (e.g.
  // showing up in the background of the Leaderboard loading overlay).
  useEffect(() => {
    if (activePage !== 'friends') {
      setIsProfileDrawerOpen(false)
      setIsPreferencesModalOpen(false)
    }
  }, [activePage])

  function updateRatingFromClick(starIndex: number, event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault()
    const target = event.currentTarget as HTMLElement
    const rect = target.getBoundingClientRect()
    const isLeftHalf = (event.clientX - rect.left) < rect.width / 2
    const value = isLeftHalf ? starIndex - 0.5 : starIndex
    setCurrentRating((prev) => (prev === value ? 0 : value))
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
        setIsAnalyzingGreenness(true)
        const { score } = await Promise.race([
          analyzeGreennessFromDataUrl(optimizedDataUrl),
          new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('Greenness analysis timed out.')), IMAGE_PROCESS_TIMEOUT_MS))
        ])
        setMatchaGreenness(score)
      } catch {
        setMatchaGreenness(0)
      } finally {
        setIsAnalyzingGreenness(false)
      }
    } catch {
      setMatchaGreenness(0)
      setPhotoDataUrl('')
      setIsAnalyzingGreenness(false)
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

    const trimmedLocation = location.trim()
    if (!isPlausibleLocationName(trimmedLocation)) {
      alert('Please enter a valid cafe or shop name (at least 2 letters, no gibberish).')
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

      // Milestone popups intentionally disabled — saved for a future feature.
      // See git history for the previous count-based confetti/toast logic.

      setCurrentRating(0)
      setRatingFlavorPrefs({ sweet: 0, nutty: 0, umami: 0, vegetal: 0, sugary: 0, astringent: 0, creamy: 0, floral: 0, earthy: 0, Chocolatey: 0, mellow: 0, bitter: 0 })
      setLocation('')
      setThoughts('')
      setPhotoDataUrl('')
      if (photoInputRef.current) {
        photoInputRef.current.value = ''
      }
      setMatchaGreenness(null)
      setIsNewLogOpen(false)
      setRecsRefreshKey((k) => k + 1)
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

  // Kept for potential future "View full profile" page (currently unused).
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
  void openFriendRatings

  async function openFriendModal(friendName: string) {
    if (!friendName.trim()) return
    // Clear any lingering inline friend-ratings page so switching between
    // friends via the modal doesn't leave a stale page behind.
    setSelectedFriend('')
    setFriendEntries([])
    setFriendModalUser(friendName)
    setFriendModalEntries([])
    setFriendModalUserPrefs({ flavors: [], body: '' })
    setIsFriendModalOpen(true)
    setIsLoadingFriendModal(true)

    // Make sure the leaderboard is loaded so we can show the user's rank
    // in the modal even when it's opened from Search / Recs / Following
    // without ever visiting the Leaderboard tab first.
    if (exploreUsers.length === 0) {
      void fetchExploreData(false).catch(() => {})
    }

    try {
      const [ratingsResp, prefsResp] = await Promise.all([
        apiFetch<{ friendName: string; ratings: RatingEntry[] }>(`/friends/${encodeURIComponent(friendName)}/ratings`),
        apiFetch<{ userName: string; flavors: string[]; body: string }>(`/users/${encodeURIComponent(friendName)}/preferences`).catch(() => ({ userName: friendName, flavors: [], body: '' })),
      ])
      setFriendModalEntries(ratingsResp.ratings)
      setFriendModalUserPrefs({ flavors: prefsResp.flavors || [], body: prefsResp.body || '' })
    } catch {
      setFriendModalEntries([])
      setFriendModalUserPrefs({ flavors: [], body: '' })
    } finally {
      setIsLoadingFriendModal(false)
    }
  }

  function applyLocationSuggestion(value: string) {
    setLocation(value)
    setShowLocationSuggestions(false)
    setLocationSuggestions([])
  }

  const [originalEntryPhoto, setOriginalEntryPhoto] = useState<string>('')

  function startEntryEdit(entry: RatingEntry) {
    setSelectedEntryId(entry.id)
    setIsEditingEntry(true)
    setEditRating(entry.rating)
    setEditLocation(entry.location)
    setEditThoughts(entry.thoughts)
    setEditEntryPhoto(entry.photo)
    setOriginalEntryPhoto(entry.photo)
    const prefs: Record<string, number> = {}
    if (entry.flavorPreferences && typeof entry.flavorPreferences === 'object') {
      for (const [k, v] of Object.entries(entry.flavorPreferences)) {
        const num = Number(v)
        if (!Number.isNaN(num)) prefs[k] = num
      }
    }
    setEditFlavorPrefs(prefs)
  }

  async function saveEntryEdit(entryId: number) {
    if (!currentUserName) {
      alert('Unable to save without a user session.')
      return
    }

    if (editRating < 0 || editRating > 5) {
      alert('Rating must be between 0 and 5 stars.')
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
          photo: photoUrl,
          flavorPreferences: editFlavorPrefs
        })
      })

      const updated = await apiFetch<{ ratings: RatingEntry[] }>(`/ratings?userName=${encodeURIComponent(currentUserName)}`)
      setMyEntries(updated.ratings)
      setIsEditingEntry(false)
      setSelectedEntryId(null)
      setEditEntryPhoto('')
      setRecsRefreshKey((k) => k + 1)
    } catch (error) {
      console.error('Save rating failed:', error)
      const status = error instanceof ApiError ? error.status : 500
      alert(friendlyErrorMessage(status))
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
                <img
                  className="auth-logo"
                  src={`${import.meta.env.BASE_URL}icon-192.png`}
                  alt="Matcha tea"
                />
                <h1 className="h3 fw-bold text-success mb-2">Sip &amp; Score</h1>
                <p className="text-muted small">Track your matcha journey, one sip at a time</p>
              </div>
              <p className="text-muted mb-4 text-center small">
                Whether you're a matcha enthusiast or just starting, let's rate every tea experience together.
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
                <img
                  className="auth-logo"
                  src={`${import.meta.env.BASE_URL}icon-192.png`}
                  alt="Matcha tea"
                />
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
                <img
                  className="auth-logo"
                  src={`${import.meta.env.BASE_URL}icon-192.png`}
                  alt="Matcha tea"
                />
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
          <div>🍵 Welcome back, {welcomeMessage}!</div>
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
                      <div className="card-body py-2">
                        <div className="d-flex justify-content-between flex-wrap gap-2">
                          <strong>{entry.userName}</strong>
                          <span className="text-muted small">{entry.date}</span>
                        </div>
                        <div className="small text-muted mb-1">{entry.location || selectedExplorePlaceName}</div>
                        <div className="entry-metrics">
                          <div className="fw-bold mb-2">Taste rating: {entry.rating.toFixed(1)} / 5.0</div>
                          <div className="fw-bold mb-2">Overall score: {(getWeightedScore(entry.rating, entry.greenness) / 2).toFixed(1)} / 100</div>
                          <div style={{ color: '#6c757d', marginBottom: '0.5rem', fontWeight: 'normal' }}>Matcha Greenness: {entry.greenness.toFixed(0)}%</div>
                          {entry.flavorPreferences && Object.entries(entry.flavorPreferences).some(([k, v]) => v > 0 && isKnownFlavor(k)) && (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginTop: '0.5rem' }}>
                              {sortFlavorsByColor(Object.entries(entry.flavorPreferences).filter(([k, v]) => v > 0 && isKnownFlavor(k)).map(([k]) => k)).map((flavor) => (
                                <span
                                  key={flavor}
                                  className="badge"
                                  style={{
                                    fontSize: '0.65rem',
                                    background: flavorColor(flavor).bg,
                                    border: '1px solid ' + flavorColor(flavor).border,
                                    color: flavorColor(flavor).fg,
                                    fontWeight: '600',
                                    textTransform: 'capitalize',
                                    padding: '0.2rem 0.4rem',
                                    textAlign: 'center',
                                    whiteSpace: 'nowrap'
                                  }}
                                >
                                  {flavor}
                                </span>
                              ))}
                            </div>
                          )}
                          {getBodyProfile(entry.flavorPreferences) && (
                            <div className="mt-2"><span className="badge" style={{ ...(function(){ const _b = getBodyProfile(entry.flavorPreferences); const _c = bodyColor(_b); return { background: _c.bg, border: '1px solid ' + _c.border, color: _c.fg, fontWeight: 600, fontSize: '0.7rem', padding: '0.25rem 0.55rem' }; })() }}>Body: {bodyProfileLabel(getBodyProfile(entry.flavorPreferences))}</span></div>
                          )}
                        </div>
                        {entry.thoughts && <p className="mt-1 mb-0">{entry.thoughts}</p>}
                        <img src={entry.photo || noPhotoPlaceholderUrl} alt="" className="entry-hero-photo" loading="lazy" decoding="async" onError={(e) => { const img = e.currentTarget; if (img.src !== noPhotoPlaceholderUrl) img.src = noPhotoPlaceholderUrl }} />
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

      {false && isMyRatingsFilterOpen && createPortal(
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
                  Overall score
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
                  Overall score
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

      {isEditNotesModalOpen && createPortal(
        <div className="notes-modal-overlay" role="dialog" aria-modal="true" aria-label="Edit notes">
          <div className="notes-modal card border-0 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <div className="notes-modal-header d-flex align-items-center p-4 border-bottom" style={{ flexWrap: 'nowrap' }}>
              <h3 className="h5 fw-bold text-success mb-0" style={{ flexShrink: 0 }}>Your thoughts...</h3>
              <button
                type="button"
                className="close-btn"
                onClick={() => setIsEditNotesModalOpen(false)}
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
                value={editThoughts}
                onChange={(event) => setEditThoughts(event.target.value)}
                autoFocus
              />
            </div>
            <div className="notes-modal-footer p-4 border-top d-flex gap-2">
              <button
                type="button"
                className="btn btn-success flex-grow-1"
                onClick={() => setIsEditNotesModalOpen(false)}
              >
                Done
              </button>
            </div>
          </div>
        </div>,
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
            <div style={{ padding: '0.75rem', borderBottom: '1px solid #e9ecef', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h6 className="fw-bold text-success mb-0">{currentUserName}</h6>
              <button
                type="button"
                className="close-btn"
                onClick={() => setIsProfileDrawerOpen(false)}
                aria-label="Close profile"
              >
                ✕
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
            <div style={{ padding: '0.75rem', borderBottom: '1px solid #e9ecef', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h6 className="fw-bold text-success mb-0">My Matcha Preferences</h6>
              <button
                type="button"
                className="close-btn"
                onClick={() => setIsPreferencesModalOpen(false)}
                aria-label="Close preferences"
              >
                ✕
              </button>
            </div>

            <div style={{ padding: '1rem', overflowY: 'auto', flex: 1 }}>
              <label className="form-label fw-semibold mb-2 text-success">Your Matcha preferences</label>
              <div className="text-muted small mb-2" style={{ fontSize: '0.75rem' }}>Flavors</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.5rem', marginBottom: '1rem' }}>
                {['sweet', 'nutty', 'umami', 'vegetal', 'sugary', 'creamy', 'floral', 'earthy', 'Chocolatey', 'mellow'].map((flavor) => {
                  const isSelected = userFlavors.includes(flavor)
                  return (
                  <button
                    key={flavor}
                    type="button"
                    style={{
                      textTransform: 'capitalize',
                      fontSize: '0.8rem',
                      padding: '0.375rem 0.75rem',
                      borderRadius: '0.5rem',
                      border: '1px solid ' + (isSelected ? '#0d4f4a' : 'rgba(176, 222, 214, 0.3)'),
                      background: isSelected ? '#0d4f4a' : 'linear-gradient(135deg, #d4ede9 0%, #e0f3f0 100%)',
                      color: isSelected ? '#ffffff' : '#6b9e95',
                      fontWeight: isSelected ? '600' : '500',
                      cursor: 'pointer'
                    }}
                    onClick={() => setUserFlavors(userFlavors.includes(flavor)
                      ? userFlavors.filter(f => f !== flavor)
                      : [...userFlavors, flavor]
                    )}
                  >
                    {flavor}
                  </button>
                  )
                })}
              </div>

              <div className="text-muted small mb-2 d-inline-flex align-items-center gap-2" style={{ fontSize: '0.75rem' }}>
                Body
                <BodyInfoIcon />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem', marginBottom: '0.75rem' }}>
                {BODY_PROFILE_OPTIONS.map((opt) => {
                  const active = userBodyPref === opt.value
                  return (
                    <button
                      key={`pref-body-${opt.value}`}
                      type="button"
                      title={opt.desc}
                      style={{
                        fontSize: '0.8rem',
                        padding: '0.375rem 0.5rem',
                        borderRadius: '0.5rem',
                        border: '1px solid ' + (active ? '#0d4f4a' : 'rgba(176, 222, 214, 0.3)'),
                        background: active ? '#0d4f4a' : 'linear-gradient(135deg, #d4ede9 0%, #e0f3f0 100%)',
                        color: active ? '#ffffff' : '#6b9e95',
                        fontWeight: active ? '600' : '500',
                        cursor: 'pointer'
                      }}
                      onClick={() => setUserBodyPref(active ? '' : opt.value)}
                    >
                      {opt.label}
                    </button>
                  )
                })}
              </div>

                <button
                  type="button"
                  className="btn w-100"
                  onClick={async () => {
                    try {
                      setIsPreferencesModalOpen(false)
                      setIsProfileDrawerOpen(false)
                      try {
                        if (userBodyPref) {
                          localStorage.setItem('matchaBodyPref', userBodyPref)
                        } else {
                          localStorage.removeItem('matchaBodyPref')
                        }
                      } catch { /* ignore */ }
                      // Persist locally BEFORE the network call. If the API
                      // request fails on a bad connection, we still have the
                      // user's picks on-device and can re-sync on next launch.
                      writeCache(currentUserName, 'flavors', userFlavors)
                      const flavorsToSave = userBodyPref
                        ? [...userFlavors, `__body:${userBodyPref}`]
                        : userFlavors
                      const response = await apiFetch('/preferences', {
                        method: 'POST',
                        body: JSON.stringify({
                          flavors: flavorsToSave
                        })
                      })
                      console.log('Preferences saved:', response)
                      setRecsRefreshKey((k) => k + 1)
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
            <div style={{ padding: '0.75rem', borderBottom: '1px solid #e9ecef', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h6 className="fw-bold text-success mb-0">Privacy Policy</h6>
              <button
                type="button"
                className="close-btn"
                onClick={() => setIsPrivacyPolicyModalOpen(false)}
                aria-label="Close privacy policy"
              >
                ✕
              </button>
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
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card card border-0 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <div className="card-header bg-white border-bottom d-flex align-items-center justify-content-between p-4">
              <h3 className="h5 fw-bold text-success mb-0" style={{ flexShrink: 0 }}>Edit Rating</h3>
              <button
                type="button"
                className="close-btn"
                onClick={() => {
                  setIsEditingEntry(false)
                  setEditEntryPhoto('')
                }}
                aria-label="Close edit"
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
                          event.preventDefault()
                          const target = event.currentTarget as HTMLElement
                          const rect = target.getBoundingClientRect()
                          const isLeftHalf = (event.clientX - rect.left) < rect.width / 2
                          const value = isLeftHalf ? starIndex - 0.5 : starIndex
                          setEditRating((prev) => (prev === value ? 0 : value))
                        }}
                        onContextMenu={(event) => event.preventDefault()}
                        aria-label={`Edit to ${starIndex} stars`}
                      >
                        <img className="star-base" src={pixelStarUrl} alt="" draggable={false} />
                        <span className="star-fill-clip" style={{ width: `${fillAmount * 100}%` }}>
                          <img className="star-fill" src={pixelStarFilledUrl} alt="" draggable={false} />
                        </span>
                      </button>
                    )
                  })}
                </div>
                <div className="d-flex justify-content-center mt-2">
                  <button
                    type="button"
                    className="btn btn-link btn-sm text-muted"
                    onClick={(event) => {
                      event.stopPropagation()
                      setEditRating(0)
                    }}
                    style={{ textDecoration: 'none' }}
                  >
                    Clear rating
                  </button>
                </div>
              </div>

              <div style={{ marginBottom: '1.5rem' }}>
                <label className="form-label fw-semibold mb-2 text-success">Location</label>
                <input
                  type="text"
                  className="form-control"
                  value={editLocation}
                  readOnly
                  disabled
                  style={{ backgroundColor: '#f8f9fa', color: '#6c757d', cursor: 'not-allowed' }}
                />
                <small className="text-muted d-block mt-1">Location can't be changed. Delete this entry and log a new one to use a different place.</small>
              </div>

              <div style={{ marginBottom: '1.5rem' }}>
                <label className="form-label fw-semibold mb-2 text-success">Photo</label>
                <div className="d-flex flex-column align-items-center gap-2">
                  <img
                    src={editEntryPhoto || noPhotoPlaceholderUrl}
                    alt="Current entry photo"
                    className="entry-hero-photo"
                    onError={(e) => { const img = e.currentTarget; if (img.src !== noPhotoPlaceholderUrl) img.src = noPhotoPlaceholderUrl }}
                  />
                  <div className="d-flex gap-2 w-100">
                    <button
                      type="button"
                      className="btn btn-outline-success btn-sm flex-grow-1"
                      onClick={openPhotoLibrary}
                    >
                      Change Photo
                    </button>
                    {originalEntryPhoto && editEntryPhoto !== originalEntryPhoto && (
                      <button
                        type="button"
                        className="btn btn-outline-secondary btn-sm"
                        onClick={() => setEditEntryPhoto(originalEntryPhoto)}
                      >
                        Revert to original
                      </button>
                    )}
                  </div>
                </div>
              </div>

              <div style={{ marginBottom: '1.5rem' }}>
                <label className="form-label fw-semibold mb-2 text-success">Flavor profile</label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.5rem', placeItems: 'center' }}>
                  {FLAVOR_LIST.map((flavor) => {
                    const active = (editFlavorPrefs[flavor] || 0) > 0
                    const c = flavorColor(flavor)
                    return (
                      <button
                        type="button"
                        key={`edit-flavor-${flavor}`}
                        className={`flavor-bubble${active ? ' active' : ''}`}
                        onClick={() => {
                          setEditFlavorPrefs((prev) => {
                            const next = { ...prev }
                            if ((next[flavor] || 0) > 0) {
                              next[flavor] = 0
                            } else {
                              next[flavor] = 100
                            }
                            return next
                          })
                        }}
                        style={{
                          border: active ? '1px solid ' + c.border : 'none',
                          background: active ? c.bg : '#f1f3f5',
                          color: active ? c.fg : '#495057',
                          borderRadius: '999px',
                          padding: '0.35rem 0.75rem',
                          fontSize: '0.8rem',
                          fontWeight: active ? 600 : 500,
                          textTransform: 'capitalize',
                          minWidth: '70px'
                        }}
                      >
                        {flavor}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div style={{ marginBottom: '1.5rem' }}>
                <label className="form-label fw-semibold mb-2 text-success">Matcha body profile</label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem', placeItems: 'center' }}>
                  {BODY_PROFILE_OPTIONS.map((opt) => {
                    const active = getBodyProfile(editFlavorPrefs) === opt.value
                    const c = bodyColor(opt.value)
                    return (
                      <button
                        type="button"
                        key={`edit-body-${opt.value}`}
                        onClick={() => setEditFlavorPrefs((prev) => setBodyProfile(prev, active ? '' : opt.value))}
                        title={opt.desc}
                        style={{
                          border: active ? '1px solid ' + c.border : 'none',
                          background: active ? c.bg : '#f1f3f5',
                          color: active ? c.fg : '#495057',
                          borderRadius: '999px',
                          padding: '0.35rem 0.75rem',
                          fontSize: '0.8rem',
                          fontWeight: active ? 600 : 500,
                          minWidth: '90px'
                        }}
                      >
                        {opt.label}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div style={{ marginBottom: '1.5rem' }}>
                <label className="form-label fw-semibold mb-2 text-success">Notes</label>
                <button
                  type="button"
                  className="btn btn-link text-start text-muted p-0 d-flex align-items-start gap-2 w-100"
                  onClick={() => setIsEditNotesModalOpen(true)}
                  style={{ textDecoration: 'none' }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0, marginTop: '2px' }}>
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                  </svg>
                  {editThoughts.trim() ? (
                    <span className="flex-grow-1" style={{ whiteSpace: 'normal', textAlign: 'left', color: '#212529' }}>
                      {editThoughts.trim()}
                    </span>
                  ) : (
                    <span className="flex-grow-1" style={{ whiteSpace: 'nowrap' }}>Edit notes</span>
                  )}
                  <span className="text-muted" style={{ flexShrink: 0 }}>›</span>
                </button>
              </div>
            </div>
            <div className="card-footer bg-white border-top p-4 d-flex gap-2">
              <button type="button" className="btn btn-success flex-grow-1" disabled={isSavingEntry} onClick={() => void saveEntryEdit(selectedEntryId!)}>
                {isSavingEntry ? 'Saving...' : 'Save'}
              </button>
              <button type="button" className="btn btn-outline-secondary flex-grow-1" disabled={isSavingEntry} onClick={() => {
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

      {isFriendModalOpen && createPortal(
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`${friendModalUser}'s ratings`}
          onClick={() => setIsFriendModalOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1060, padding: '1rem' }}
        >
          <div
            className="card shadow-lg border-0"
            onClick={(e) => e.stopPropagation()}
            style={{ width: '100%', maxWidth: '640px', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}
          >
            <div className="card-header bg-white border-bottom p-3">
              <div className="d-flex align-items-start justify-content-between gap-2 mb-2">
                <div className="flex-grow-1">
                  <h5 className="mb-1 text-success fw-bold">{friendModalUser}</h5>
                  <div className="small text-muted d-flex flex-wrap gap-2 align-items-center">
                    {friendModalRank !== null && (
                      <span>Rank <strong className="text-success">#{friendModalRank}</strong></span>
                    )}
                    {friendModalRank !== null && <span aria-hidden="true">•</span>}
                    <span><strong className="text-success">{friendModalPlaceCount}</strong> places rated</span>
                  </div>
                </div>
                <div className="d-flex align-items-center gap-2">
                  {friendModalUser && friendModalUser.toLowerCase() !== (currentUserName || '').toLowerCase() && (
                    <button
                      type="button"
                      className={`btn btn-sm rounded-pill ${followingSet.has(friendModalUser) ? 'btn-success' : 'btn-outline-success'}`}
                      onClick={async (e) => {
                        e.stopPropagation()
                        const isFollowing = followingSet.has(friendModalUser)
                        try {
                          if (isFollowing) {
                            await apiFetch(`/follows/${friendModalUser}`, { method: 'DELETE' })
                            followingSet.delete(friendModalUser)
                          } else {
                            await apiFetch(`/follows/${friendModalUser}`, { method: 'POST' })
                            followingSet.add(friendModalUser)
                          }
                          setFollowingSet(new Set(followingSet))
                        } catch (error) {
                          console.error('Failed to update follow status:', error)
                          alert(error instanceof Error ? error.message : 'Failed to update follow status')
                        }
                      }}
                    >
                      {followingSet.has(friendModalUser) ? '✓ Following' : '+ Follow'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn-close"
                    aria-label="Close"
                    onClick={() => setIsFriendModalOpen(false)}
                  />
                </div>
              </div>
              {(friendModalPrefs.flavors.length > 0 || friendModalPrefs.body) && (
                <div className="mt-2">
                  <div className="small text-muted mb-1">Matcha preferences</div>
                  <div className="d-flex flex-wrap gap-1 align-items-center">
                    {friendModalPrefs.flavors.map((flavor) => {
                      const _c = flavorColor(flavor)
                      return (
                        <span key={flavor} className="badge" style={{ fontSize: '0.7rem', textTransform: 'capitalize', background: _c.bg, color: _c.fg, border: '1px solid ' + _c.border, fontWeight: 600, padding: '0.25rem 0.55rem' }}>
                          {flavor}
                        </span>
                      )
                    })}
                    {friendModalPrefs.body && (
                      <span className="badge" style={{ ...(function(){ const _c = bodyColor(friendModalPrefs.body); return { background: _c.bg, border: '1px solid ' + _c.border, color: _c.fg, fontWeight: 600, fontSize: '0.7rem', padding: '0.25rem 0.55rem' }; })() }}>
                        Body: {bodyProfileLabel(friendModalPrefs.body)}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
            <div className="card-body p-3" style={{ overflowY: 'auto' }}>
              {isLoadingFriendModal ? (
                <div className="text-center text-muted py-4">Loading ratings...</div>
              ) : friendModalEntries.length === 0 ? (
                <div className="alert alert-light border mb-0">No ratings to show yet.</div>
              ) : (
                <div className="d-flex flex-column gap-2">
                  {friendModalEntries.map((entry) => (
                    <article key={`friend-modal-${entry.id}`} className="card border-0 shadow-sm">
                      <div className="card-body py-2">
                        <div className="d-flex justify-content-between flex-wrap gap-2">
                          <strong>{entry.location || 'Unknown location'}</strong>
                          <span className="text-muted small">{entry.date}</span>
                        </div>
                        <div className="entry-metrics">
                          <div className="fw-bold mb-1">Overall score: {(getWeightedScore(entry.rating, entry.greenness) / 2).toFixed(1)} / 100</div>
                          <div style={{ color: '#6c757d', fontWeight: 'normal' }} className="mb-1">Taste rating: {entry.rating.toFixed(1)} / 5.0</div>
                          <div style={{ color: '#6c757d', fontWeight: 'normal' }}>Matcha Greenness: {entry.greenness.toFixed(0)}%</div>
                        </div>
                        {entry.thoughts && (
                          <div className="small text-muted mt-2" style={{ whiteSpace: 'pre-wrap' }}>{entry.thoughts}</div>
                        )}
                        <img
                          src={entry.photo || noPhotoPlaceholderUrl}
                          alt=""
                          className="entry-hero-photo"
                          loading="lazy"
                          decoding="async"
                          onError={(e) => { const img = e.currentTarget; if (img.src !== noPhotoPlaceholderUrl) img.src = noPhotoPlaceholderUrl }}
                        />
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
            <div className="card-footer bg-white border-top p-3 d-flex justify-content-end gap-2">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setIsFriendModalOpen(false)}>
                Close
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
          {isNewLogOpen && createPortal(
            <div className="modal-overlay new-log-modal-overlay" role="dialog" aria-modal="true" aria-label="New Log">
              <div className="new-log-modal card shadow-lg border-0 matcha-shell" onClick={(e) => e.stopPropagation()}>
                <div className="card-body p-3 p-md-4">
                  <div className="d-flex align-items-center justify-content-between mb-3">
                    <h1 className="h3 fw-bold mb-0 text-success">New Log</h1>
                    <button
                      type="button"
                      className="close-btn"
                      onClick={() => setIsNewLogOpen(false)}
                      aria-label="Close new log"
                    >
                      ✕
                    </button>
                  </div>

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
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        applyLocationSuggestion(location.trim())
                      } else if (event.key === 'Escape') {
                        setShowLocationSuggestions(false)
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

                  {showLocationSuggestions && location.trim().length >= 2 && (() => {
                    const trimmed = location.trim()
                    const alreadyListed = locationSuggestions.some(
                      (s) => s.toLowerCase() === trimmed.toLowerCase()
                    )
                    const showUseTyped = !isLocationLookupPending && !alreadyListed
                    return (
                      <div className="location-dropdown border rounded shadow-sm bg-white">
                        {isLocationLookupPending && <div className="location-item muted">Searching locations…</div>}

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

                        {showUseTyped && (
                          <button
                            type="button"
                            className="location-item"
                            onMouseDown={(event) => {
                              event.preventDefault()
                              applyLocationSuggestion(trimmed)
                            }}
                            style={{ fontStyle: 'italic' }}
                          >
                            {locationSuggestions.length === 0
                              ? `Use “${trimmed}” as the location`
                              : `Can’t find it? Use “${trimmed}”`}
                          </button>
                        )}
                      </div>
                    )
                  })()}
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
                  <span>{photoDataUrl && photoDataUrl !== noPhotoPlaceholderUrl ? 'Change photo' : 'Add photo'}</span>
                  <span className="text-muted">›</span>
                </button>
                {photoDataUrl && photoDataUrl !== noPhotoPlaceholderUrl && (
                  <div className="small text-muted mt-1">Only one photo per log. Choosing another will replace this one.</div>
                )}
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
                      onClick={openPhotoLibrary}
                    >
                      Change photo
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-outline-danger flex-grow-1"
                      onClick={() => setPhotoDataUrl(noPhotoPlaceholderUrl)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              )}
              
              <center> 
              {(isAnalyzingGreenness || matchaGreenness !== null) && (
                <div className="mb-3 text-success fw-semibold">
                  {isAnalyzingGreenness
                    ? 'How green is your matcha?'
                    : `Matcha Greenness: ${matchaGreenness!.toFixed(0)}%`}
                </div>
              )}
              </center>

              <hr className="my-3" style={{ borderColor: '#e9ecef', opacity: 0.5 }} />

              <div className="mb-3">
                <label className="form-label fw-semibold d-block">Flavor profile</label>
                <div className="small text-muted mb-3">Click bubbles to toggle flavors</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.5rem', placeItems: 'center' }}>
                  {FLAVOR_LIST.map((flavor) => {
                    const intensity = ratingFlavorPrefs[flavor]
                    const isActive = intensity > 0
                    const c = flavorColor(flavor)

                    return (
                      <button
                        key={flavor}
                        type="button"
                        className="btn"
                        style={{
                          backgroundColor: isActive ? c.bg : '#e9ecef',
                          color: isActive ? c.fg : '#666',
                          border: isActive ? '1px solid ' + c.border : 'none',
                          borderRadius: '20px',
                          padding: '0.3rem 0.7rem',
                          transition: 'all 0.2s ease',
                          textTransform: 'capitalize',
                          fontSize: '0.75rem',
                          fontWeight: isActive ? 600 : 500,
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

              <div className="mb-3">
                <label className="form-label fw-semibold d-inline-flex align-items-center gap-2">
                  Matcha body profile
                  <BodyInfoIcon />
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem', placeItems: 'center', marginTop: '0.5rem' }}>
                  {BODY_PROFILE_OPTIONS.map((opt) => {
                    const active = getBodyProfile(ratingFlavorPrefs) === opt.value
                    const c = bodyColor(opt.value)
                    return (
                      <button
                        type="button"
                        key={`new-body-${opt.value}`}
                        className="btn"
                        onClick={() => setRatingFlavorPrefs((prev) => setBodyProfile(prev, active ? '' : opt.value))}
                        title={opt.desc}
                        style={{
                          backgroundColor: active ? c.bg : '#e9ecef',
                          color: active ? c.fg : '#666',
                          border: active ? '1px solid ' + c.border : 'none',
                          borderRadius: '20px',
                          padding: '0.3rem 0.7rem',
                          fontSize: '0.75rem',
                          fontWeight: active ? 600 : 500,
                          minWidth: '95px'
                        }}
                      >
                        {opt.label}
                      </button>
                    )
                  })}
                </div>
                {getBodyProfile(ratingFlavorPrefs) && (
                  <div className="small text-muted mt-2">
                    {BODY_PROFILE_OPTIONS.find((o) => o.value === getBodyProfile(ratingFlavorPrefs))?.desc}
                  </div>
                )}
              </div>

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
                        onContextMenu={(event) => event.preventDefault()}
                        aria-label={`Rate ${starIndex} stars`}
                      >
                        <img className="star-base" src={pixelStarUrl} alt="" draggable={false} />
                        <span className="star-fill-clip" style={{ width: `${fillAmount * 100}%` }}>
                          <img className="star-fill" src={pixelStarFilledUrl} alt="" draggable={false} />
                        </span>
                      </button>
                    )
                  })}
                </div>
                <div className="d-flex justify-content-center mt-2">
                  <button
                    type="button"
                    className="btn btn-link btn-sm text-muted"
                    onClick={() => setCurrentRating(0)}
                    style={{ textDecoration: 'none' }}
                  >
                    Clear rating
                  </button>
                </div>
              </div>

              <hr className="my-3" style={{ borderColor: '#e9ecef', opacity: 0.5 }} />

              <div className="mb-3">
                <button
                  type="button"
                  className="btn btn-link text-start text-muted p-0 d-flex align-items-start gap-2 w-100"
                  onClick={() => setIsNotesModalOpen(true)}
                  style={{ textDecoration: 'none' }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0, marginTop: '2px' }}>
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                  </svg>
                  {thoughts.trim() ? (
                    <span className="flex-grow-1" style={{ whiteSpace: 'normal', textAlign: 'left', color: '#212529' }}>
                      {thoughts.trim()}
                    </span>
                  ) : (
                    <span className="flex-grow-1" style={{ whiteSpace: 'nowrap' }}>Add notes</span>
                  )}
                  <span className="text-muted" style={{ flexShrink: 0 }}>›</span>
                </button>
              </div>

              <button type="button" className="btn btn-success w-100" onClick={() => void saveEntry()} disabled={isSavingEntry}>
                {isSavingEntry ? 'Saving...' : 'Save Rating'}
              </button>
                </div>
              </div>
            </div>,
            document.body
          )}

          <section className="mb-5">
            <div className="d-flex flex-column gap-2 mb-3">
              <div className="d-flex align-items-center justify-content-between gap-2 flex-wrap">
                <div>
                  <h2 className="h4 fw-bold text-success mb-0">
                    My Ratings
                  </h2>
                  <small className="text-muted">Tap to edit</small>
                </div>
                <button
                  type="button"
                  className="btn new-log-inline-btn"
                  onClick={() => setIsNewLogOpen(true)}
                  aria-label="Add new log"
                >
                  <span className="new-log-inline-plus" aria-hidden="true">+</span>
                  <span>New Log</span>
                </button>
              </div>

              <div className="my-ratings-controls d-flex gap-2 align-items-center">
                <div className="search-bar-wrapper flex-grow-1">
                  <span className="search-bar-icon" aria-hidden="true">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="11" cy="11" r="8" />
                      <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                  </span>
                  <input
                    id="my-ratings-search-input"
                    type="text"
                    className="form-control search-bar-input"
                    placeholder="Search your list"
                    value={myLogsSearchTerm}
                    onChange={(event) => setMyLogsSearchTerm(event.target.value)}
                  />
                </div>
                <div className="filter-dropdown-wrapper" style={{ position: 'relative' }}>
                  <button
                    type="button"
                    className="filter-icon-button"
                    onClick={() => setIsMyRatingsFilterOpen((open) => !open)}
                    aria-label="Filter and sort"
                    title="Filter and sort"
                    aria-expanded={isMyRatingsFilterOpen}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
                    </svg>
                  </button>
                  {isMyRatingsFilterOpen && (
                    <>
                      <div
                        className="filter-dropdown-backdrop"
                        onClick={() => setIsMyRatingsFilterOpen(false)}
                      />
                      <div className="filter-dropdown-menu" role="menu">
                        <div className="filter-dropdown-label">Sort by</div>
                        {[
                          { value: 'highest' as const, label: 'Highest to lowest score' },
                          { value: 'lowest' as const, label: 'Lowest to highest score' },
                          { value: 'greenest' as const, label: 'Greenness' },
                          { value: 'newest' as const, label: 'Date added' },
                        ].map((opt) => (
                          <button
                            key={opt.value}
                            type="button"
                            role="menuitemradio"
                            aria-checked={myRatingsSort === opt.value}
                            className={`filter-dropdown-item${myRatingsSort === opt.value ? ' active' : ''}`}
                            onClick={() => {
                              setMyRatingsSort(opt.value)
                              setIsMyRatingsFilterOpen(false)
                            }}
                          >
                            {opt.label}
                            {myRatingsSort === opt.value && <span aria-hidden="true">✓</span>}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
            <div className="d-flex flex-column gap-3">
              {isMyRatingsLoading && (
                <div className="rating-loading-shell" aria-live="polite">
                  <div className="text-muted small">Loading your log…</div>
                </div>
              )}

              {!isMyRatingsLoading && filteredMine.length === 0 && <div className="alert alert-light border">Your matcha journey starts here 🍵</div>}

              {!isMyRatingsLoading && filteredMine.slice(0, myLogsVisibleCount).map((entry) => (
                <article key={entry.id} data-entry-id={entry.id} className="card border-0 shadow-sm entry-card" onClick={() => startEntryEdit(entry)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') startEntryEdit(entry) }}>
                  <div className="card-body">
                    <div className="d-flex gap-2 align-items-start justify-content-between mb-2">
                      <div className="d-flex align-items-center gap-2 flex-grow-1">
                        <div className="entry-rank-circle">#{myRankById.get(entry.id) || 0}</div>
                        <div className="flex-grow-1">
                          <div className="d-flex justify-content-between flex-wrap gap-2">
                            <strong>{entry.location || 'Unknown location'}</strong>
                            <span className="text-muted small">{entry.date}</span>
                          </div>
                        </div>
                      </div>
                      <div className="entry-actions" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="entry-action-btn"
                          onClick={(e) => { e.stopPropagation(); startEntryEdit(entry) }}
                          aria-label="Edit rating"
                          title="Edit"
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 20h9"/>
                            <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="entry-action-btn entry-action-danger"
                          onClick={(e) => {
                            e.stopPropagation()
                            if (window.confirm('Delete this rating entry?')) {
                              void deleteEntry(entry.id)
                            }
                          }}
                          aria-label="Delete rating"
                          title="Delete"
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                            <path d="M10 11v6"/>
                            <path d="M14 11v6"/>
                            <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>
                          </svg>
                        </button>
                      </div>
                    </div>
                    <div className="entry-metrics">
                      <div className="fw-bold mb-2">Overall score: {(getWeightedScore(entry.rating, entry.greenness) / 2).toFixed(1)} / 100</div>
                      <div style={{ color: '#6c757d', marginBottom: '0.5rem', fontWeight: 'normal' }}>Matcha Greenness: {entry.greenness.toFixed(0)}%</div>
                      {entry.flavorPreferences && Object.entries(entry.flavorPreferences).some(([k, v]) => v > 0 && isKnownFlavor(k)) && (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem', maxWidth: '280px', marginTop: '0.5rem' }}>
                          {sortFlavorsByColor(Object.entries(entry.flavorPreferences).filter(([k, v]) => v > 0 && isKnownFlavor(k)).map(([k]) => k)).map((flavor) => (
                            <span
                              key={flavor}
                              className="badge"
                              style={{
                                fontSize: '0.7rem',
                                background: flavorColor(flavor).bg,
                                border: '1px solid ' + flavorColor(flavor).border,
                                color: flavorColor(flavor).fg,
                                fontWeight: '600',
                                textTransform: 'capitalize',
                                padding: '0.25rem 0.5rem',
                                textAlign: 'center'
                              }}
                            >
                              {flavor}
                            </span>
                          ))}
                        </div>
                      )}
                      {getBodyProfile(entry.flavorPreferences) && (
                        <div className="mt-2"><span className="badge" style={{ ...(function(){ const _b = getBodyProfile(entry.flavorPreferences); const _c = bodyColor(_b); return { background: _c.bg, border: '1px solid ' + _c.border, color: _c.fg, fontWeight: 600, fontSize: '0.7rem', padding: '0.25rem 0.55rem' }; })() }}>Body: {bodyProfileLabel(getBodyProfile(entry.flavorPreferences))}</span></div>
                      )}
                    </div>
                    {entry.thoughts && <p className="mt-2 mb-0">{entry.thoughts}</p>}
                    <img
                      src={entry.photo || noPhotoPlaceholderUrl}
                      alt=""
                      className="entry-hero-photo"
                      loading="lazy"
                      decoding="async"
                      onError={(e) => { const img = e.currentTarget; if (img.src !== noPhotoPlaceholderUrl) img.src = noPhotoPlaceholderUrl }}
                    />
                  </div>

                  {false && selectedEntryId === entry.id && !isEditingEntry && (
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
              {filteredMine.length > myLogsVisibleCount && (
                <button
                  type="button"
                  className="btn btn-outline-success w-100 mt-2"
                  onClick={() => setMyLogsVisibleCount((c) => Math.min(c + 10, filteredMine.length))}
                >
                  See More
                </button>
              )}
              {myLogsVisibleCount > 10 && filteredMine.length > 10 && (
                <button
                  type="button"
                  className="btn btn-link text-success w-100 mt-1"
                  onClick={() => setMyLogsVisibleCount(10)}
                >
                  See Less
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
                  className={`btn btn-link p-0 fw-semibold ${communityActiveTab === 'search' ? 'text-success' : 'text-muted'}`}
                  onClick={() => {
                    setCommunityActiveTab('search')
                    setSelectedFriend('')
                  }}
                  style={{ textDecoration: 'none', borderBottom: communityActiveTab === 'search' ? '2px solid var(--primary-green)' : 'none', paddingBottom: '0.5rem' }}
                >
                  Search Users
                </button>
              </div>

              {/* Search Users Tab */}
              {communityActiveTab === 'search' && (
                <div className="mb-4">
                  <p className="text-muted small mb-3">Discover and connect with other matcha enthusiasts</p>
                  <div className="mb-3">
                    <label className="form-label fw-semibold">Search Users</label>
                    <input
                      type="text"
                      className="form-control"
                      value={friendQuery}
                      placeholder="Enter username"
                      onChange={(event) => void searchFriends(event.target.value)}
                    />
                  </div>

                  {friendQuery.trim() !== '' && friendSuggestions.length === 0 && (
                    <div className="text-muted small mt-3">
                      No user found matching “{friendQuery.trim()}”.
                    </div>
                  )}

                  {friendSuggestions.length > 0 && (
                    <div className="mt-3">
                      <div className="row g-3">
                        {friendSuggestions.map((friend) => (
                          <div key={friend.userName} className="col-12 col-sm-6 col-md-4">
                            <div
                              className="card border-0 shadow-sm h-100"
                              role="button"
                              tabIndex={0}
                              style={{ cursor: 'pointer' }}
                              onClick={() => void openFriendModal(friend.userName)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  event.preventDefault()
                                  void openFriendModal(friend.userName)
                                }
                              }}
                            >
                              <div className="card-body">
                                <h6 className="card-title fw-semibold text-success mb-2">
                                  {friend.userName}
                                </h6>
                                <p className="text-muted small mb-0">{friend.placeCount} places rated</p>
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
                        <div
                          className="card border-0 shadow-sm h-100"
                          role="button"
                          tabIndex={0}
                          style={{ cursor: 'pointer' }}
                          onClick={() => void openFriendModal(friend)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              void openFriendModal(friend)
                            }
                          }}
                        >
                          <div className="card-body">
                            <h6 className="card-title fw-semibold text-success mb-3">{friend}</h6>
                            <button
                              type="button"
                              className="btn btn-sm btn-outline-danger w-100"
                              onClick={async (e) => {
                                e.stopPropagation()
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
                      <p className="mb-2">You haven't set your flavor preferences yet, so there's nothing to match on. Set them now and we'll surface users and places that share your taste.</p>
                      <button
                        type="button"
                        className="btn btn-success btn-sm"
                        onClick={() => {
                          setIsProfileDrawerOpen(true)
                          setIsPreferencesModalOpen(true)
                        }}
                      >
                        Set my preferences →
                      </button>
                    </div>
                  ) : (
                    <div>
                      <div className="mb-4">
                        <button
                          type="button"
                          className="btn btn-outline-success btn-sm d-inline-flex align-items-center gap-2"
                          onClick={() => {
                            setIsProfileDrawerOpen(true)
                            setIsPreferencesModalOpen(true)
                          }}
                        >
                          <span aria-hidden="true">✏️</span>
                          Edit my matcha preferences
                        </button>
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
                                {similarUsers.slice(0, similarUsersVisible).map((user) => (
                                  <div key={user.userName} className="col-12 col-sm-6 col-md-4">
                                    <div
                                      className="card border-0 shadow-sm h-100"
                                      role="button"
                                      tabIndex={0}
                                      style={{ cursor: 'pointer' }}
                                      onClick={() => void openFriendModal(user.userName)}
                                      onKeyDown={(event) => {
                                        if (event.key === 'Enter' || event.key === ' ') {
                                          event.preventDefault()
                                          void openFriendModal(user.userName)
                                        }
                                      }}
                                    >
                                      <div className="card-body">
                                        <div className="d-flex justify-content-between align-items-start mb-2">
                                          <h6 className="card-title fw-semibold text-success mb-0">
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
                                        {user.flavors.filter((f) => !f.startsWith('__') && isKnownFlavor(f)).length > 0 && (
                                          <div className="small mt-2">
                                            <p className="text-muted mb-2">Shared flavors:</p>
                                            <div className="d-flex flex-wrap gap-1">
                                              {sortFlavorsByColor(user.flavors.filter((f) => !f.startsWith('__') && isKnownFlavor(f))).map((flavor) => {
                                                const _c = flavorColor(flavor)
                                                return (
                                                <span key={flavor} className="badge" style={{ fontSize: '0.7rem', textTransform: 'capitalize', background: _c.bg, color: _c.fg, border: '1px solid ' + _c.border, fontWeight: 600, padding: '0.25rem 0.55rem' }}>
                                                  {flavor}
                                                </span>
                                                )
                                              })}
                                            </div>
                                          </div>
                                        )}
                                        {user.body && (
                                          <div className="small mt-2">
                                            <p className="text-muted mb-2">Matcha body profile:</p>
                                            <span className="badge" style={{ ...(function(){ const _c = bodyColor(user.body!); return { background: _c.bg, border: '1px solid ' + _c.border, color: _c.fg, fontWeight: 600, fontSize: '0.7rem', padding: '0.25rem 0.55rem' }; })() }}>
                                              {bodyProfileLabel(user.body)}
                                            </span>
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                            {similarUsers.length > similarUsersVisible && (
                              <div className="text-center mt-3">
                                <button type="button" className="btn btn-outline-success btn-sm" onClick={() => setSimilarUsersVisible((n) => n + 10)}>
                                  See more ({similarUsers.length - similarUsersVisible} more)
                                </button>
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
                                {similarPlaces.slice(0, 10).map((place) => {
                                  const cleanFlavors = sortFlavorsByColor(
                                    (place.flavors || []).filter((f) => !f.startsWith('__') && isKnownFlavor(f))
                                  )
                                  const derivedBody = place.body || (
                                    (place.flavors || []).find((f) => f.startsWith('__body:'))?.slice('__body:'.length) || ''
                                  )
                                  return (
                                  <div key={place.location} className="col-12 col-sm-6 col-md-4">
                                    <div
                                      className="card border-0 shadow-sm h-100"
                                      role="button"
                                      tabIndex={0}
                                      style={{ cursor: 'pointer' }}
                                      onClick={() => void openExplorePlaceRatings(place.location)}
                                      onKeyDown={(event) => {
                                        if (event.key === 'Enter' || event.key === ' ') {
                                          event.preventDefault()
                                          void openExplorePlaceRatings(place.location)
                                        }
                                      }}
                                    >
                                      <div className="card-body">
                                        <div className="d-flex justify-content-between align-items-start mb-2">
                                          <h6 className="card-title fw-semibold text-success mb-0">
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
                                        {cleanFlavors.length > 0 && (
                                          <div className="small mt-2">
                                            <p className="text-muted mb-2">Featured flavors:</p>
                                            <div className="d-flex flex-wrap gap-1">
                                              {cleanFlavors.map((flavor) => {
                                                const _c = flavorColor(flavor)
                                                return (
                                                <span key={flavor} className="badge" style={{ fontSize: '0.7rem', textTransform: 'capitalize', background: _c.bg, color: _c.fg, border: '1px solid ' + _c.border, fontWeight: 700, padding: '0.3rem 0.55rem' }}>
                                                  {flavor}
                                                </span>
                                                )
                                              })}
                                            </div>
                                          </div>
                                        )}
                                        {derivedBody && (
                                          <div className="small mt-2">
                                            <p className="text-muted mb-2">Matcha body profile:</p>
                                            <span className="badge" style={{ ...(function(){ const _c = bodyColor(derivedBody); return { background: _c.bg, border: '1px solid ' + _c.border, color: _c.fg, fontWeight: 600, fontSize: '0.7rem', padding: '0.25rem 0.55rem' }; })() }}>
                                              {bodyProfileLabel(derivedBody)}
                                            </span>
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                  )
                                })}
                              </div>
                            )}
                            {similarPlaces.length > 10 && (
                              <div className="text-center mt-3">
                                <p className="text-muted small mb-0">Showing top 10 matches</p>
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
                  <div className="card-body">
                    <div className="d-flex gap-2 align-items-start justify-content-between mb-2">
                      <div className="d-flex align-items-center gap-2 flex-grow-1">
                        <div className="entry-rank-circle">#{friendRankById.get(entry.id) || 0}</div>
                        <div className="flex-grow-1">
                          <div className="d-flex justify-content-between flex-wrap gap-2">
                            <strong>{entry.location || 'Unknown location'}</strong>
                            <span className="text-muted small">{entry.date}</span>
                          </div>
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
                    <div className="entry-metrics">
                      <div className="fw-bold mb-2">Overall score: {(getWeightedScore(entry.rating, entry.greenness) / 2).toFixed(1)} / 100</div>
                      <div style={{ color: '#6c757d', marginBottom: '0.5rem', fontWeight: 'normal' }}>Matcha Greenness: {entry.greenness.toFixed(0)}%</div>
                      {entry.flavorPreferences && Object.entries(entry.flavorPreferences).some(([k, v]) => v > 0 && isKnownFlavor(k)) && (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem', maxWidth: '280px', marginTop: '0.5rem' }}>
                          {sortFlavorsByColor(Object.entries(entry.flavorPreferences).filter(([k, v]) => v > 0 && isKnownFlavor(k)).map(([k]) => k)).map((flavor) => (
                            <span
                              key={flavor}
                              className="badge"
                              style={{
                                fontSize: '0.7rem',
                                background: flavorColor(flavor).bg,
                                border: '1px solid ' + flavorColor(flavor).border,
                                color: flavorColor(flavor).fg,
                                fontWeight: '600',
                                textTransform: 'capitalize',
                                padding: '0.25rem 0.5rem',
                                textAlign: 'center'
                              }}
                            >
                              {flavor}
                            </span>
                          ))}
                        </div>
                      )}
                      {getBodyProfile(entry.flavorPreferences) && (
                        <div className="mt-2"><span className="badge" style={{ ...(function(){ const _b = getBodyProfile(entry.flavorPreferences); const _c = bodyColor(_b); return { background: _c.bg, border: '1px solid ' + _c.border, color: _c.fg, fontWeight: 600, fontSize: '0.7rem', padding: '0.25rem 0.55rem' }; })() }}>Body: {bodyProfileLabel(getBodyProfile(entry.flavorPreferences))}</span></div>
                      )}
                    </div>
                    {entry.thoughts && <p className="mt-2 mb-0">{entry.thoughts}</p>}
                    <img
                      src={entry.photo || noPhotoPlaceholderUrl}
                      alt=""
                      className="entry-hero-photo"
                      loading="lazy"
                      decoding="async"
                      onError={(e) => { const img = e.currentTarget; if (img.src !== noPhotoPlaceholderUrl) img.src = noPhotoPlaceholderUrl }}
                    />
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
                            <div className="fw-bold">Overall score: {(place.averageScore / 2).toFixed(1)} / 100</div>
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
                        <article
                          key={`${user.userName}-${index}`}
                          className="card border-0 shadow-sm"
                          role="button"
                          tabIndex={0}
                          style={{ cursor: 'pointer' }}
                          onClick={() => void openFriendModal(user.userName)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              void openFriendModal(user.userName)
                            }
                          }}
                        >
                          <div className="card-body d-flex justify-content-between align-items-center flex-wrap gap-2 py-2">
                            <div className="fw-semibold">
                              #{index + 1}{' '}
                              <span className="explore-user-link">
                                {user.userName}
                              </span>
                            </div>
                            <div className="d-flex gap-3 align-items-center">
                              <div className="text-success fw-bold">{user.placeCount}</div>
                              {user.userName.toLowerCase() !== (currentUserName || '').toLowerCase() && (
                                <button
                                  type="button"
                                  className="btn btn-link btn-sm text-muted p-0"
                                  style={{ textDecoration: 'none' }}
                                  onClick={async (event) => {
                                    event.stopPropagation()
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
                              )}
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
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            {/* Classic filled trophy with side handles and base */}
            <path d="M7 3a1 1 0 0 0-1 1v1H4a2 2 0 0 0-2 2v1a4 4 0 0 0 4 4h.29c.63 2.36 2.42 4.24 4.71 4.9V19H8.5a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-1a1 1 0 0 0-1-1H13v-2.1c2.29-.66 4.08-2.54 4.71-4.9H18a4 4 0 0 0 4-4V7a2 2 0 0 0-2-2h-2V4a1 1 0 0 0-1-1H7Zm-1 4v4a2 2 0 0 1-2-2V7h2Zm14 0v2a2 2 0 0 1-2 2V7h2Z"/>
          </svg>
          <span className="label">Leaderboard</span>
        </button>
      </nav>
</>
  )
}

export default App
