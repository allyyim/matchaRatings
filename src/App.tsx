import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import * as tf from '@tensorflow/tfjs'
import './App.css'

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

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api'
const pixelStarUrl = `${import.meta.env.BASE_URL}blank.png`
const pixelStarFilledUrl = `${import.meta.env.BASE_URL}filled.png`
const pencilIconUrl = `${import.meta.env.BASE_URL}pencil.svg`
const trashIconUrl = `${import.meta.env.BASE_URL}trash.svg`

const drinkAreaModelConfig = {
  modelUrl: `${import.meta.env.BASE_URL}ml/drink-area/model.json`,
  inputSize: 224,
  maskThreshold: 0.45
}

const LOW_RATING_GREENNESS_WEIGHT = 0.8
const FULL_GREENNESS_WEIGHT = 1

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

function getBrowserId() {
  const existing = localStorage.getItem('matchaBrowserId')
  if (existing) return existing
  const generated = crypto.randomUUID()
  localStorage.setItem('matchaBrowserId', generated)
  return generated
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {})
    },
    ...init
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `Request failed with status ${response.status}`)
  }

  return response.json() as Promise<T>
}

function App() {
  const [activePage, setActivePage] = useState<Page>('home')
  const [browserId] = useState(() => getBrowserId())
  const [currentUserName, setCurrentUserName] = useState('')
  const [isUserReady, setIsUserReady] = useState(false)
  const [loadingMessage, setLoadingMessage] = useState('Connecting to ratings service...')

  const [currentRating, setCurrentRating] = useState(0)
  const [location, setLocation] = useState('')
  const [locationSuggestions, setLocationSuggestions] = useState<string[]>([])
  const [isLocationLookupPending, setIsLocationLookupPending] = useState(false)
  const [showLocationSuggestions, setShowLocationSuggestions] = useState(false)
  const locationDebounceRef = useRef<number | null>(null)
  const locationBlurTimeoutRef = useRef<number | null>(null)
  const locationLookupSequenceRef = useRef(0)
  const [thoughts, setThoughts] = useState('')
  const [photoDataUrl, setPhotoDataUrl] = useState('')
  const [matchaGreenness, setMatchaGreenness] = useState<number | null>(null)
  const [mlStatus, setMlStatus] = useState('Checking ML drink-area model...')
  const [mlCoveragePercent, setMlCoveragePercent] = useState<number | null>(null)
  const [mlConfidencePercent, setMlConfidencePercent] = useState<number | null>(null)
  const [cameraReady, setCameraReady] = useState(false)
  const [cameraError, setCameraError] = useState('')
  const videoRef = useRef<HTMLVideoElement>(null)
  const photoInputRef = useRef<HTMLInputElement>(null)
  const cameraStreamRef = useRef<MediaStream | null>(null)

  const [myEntries, setMyEntries] = useState<RatingEntry[]>([])
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
  const [isRatingDragActive, setIsRatingDragActive] = useState(false)
  const [isEditRatingDragActive, setIsEditRatingDragActive] = useState(false)

  const showLoadingOverlay = isSavingEntry || isLoadingFriendRatings || isLoadingExplorePlaces
  const loadingOverlayText = isSavingEntry
    ? 'Saving your rating...'
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

  const rankedFriendEntries = useMemo(() => {
    return [...friendEntries].sort(compareEntriesForRank)
  }, [friendEntries])

  const friendRankById = useMemo(() => {
    return new Map(rankedFriendEntries.map((entry, index) => [entry.id, index + 1]))
  }, [rankedFriendEntries])

  const filteredFriendEntries = useMemo(() => {
    if (!friendLogsSearchTerm.trim()) return rankedFriendEntries

    const searchLower = friendLogsSearchTerm.toLowerCase()
    return rankedFriendEntries.filter((entry) =>
      entry.location.toLowerCase().includes(searchLower) ||
      entry.thoughts.toLowerCase().includes(searchLower)
    )
  }, [rankedFriendEntries, friendLogsSearchTerm])

  useEffect(() => {
    loadDrinkAreaModel()
      .then((model) => {
        if (model) {
          setMlStatus('ML drink-area detector loaded.')
        } else {
          setMlStatus('ML model not found. Using heuristic drink area.')
        }
      })
      .catch(() => {
        setMlStatus('ML initialization failed. Using heuristic drink area.')
      })
  }, [])

  useEffect(() => {
    let mounted = true

    async function initUserSession() {
      try {
        const savedName = localStorage.getItem('matchaUserName') || ''
        let candidate = savedName.trim()

        if (!candidate) {
          candidate = window.prompt('Enter your name to create your ratings log:')?.trim() || ''
        }

        while (!candidate) {
          candidate = window.prompt('Name is required. Enter your name to continue:')?.trim() || ''
        }

        const session = await apiFetch<{ requiresName: boolean; userName: string }>('/users/session', {
          method: 'POST',
          body: JSON.stringify({ browserId, userName: candidate })
        })

        if (!mounted) return

        localStorage.setItem('matchaUserName', session.userName)
        setCurrentUserName(session.userName)
        setIsUserReady(true)
        setLoadingMessage('')
      } catch {
        if (!mounted) return
        setLoadingMessage('Unable to connect to API. Start PostgreSQL API server and refresh.')
      }
    }

    void initUserSession()
    return () => {
      mounted = false
    }
  }, [browserId])

  useEffect(() => {
    if (!isUserReady || !currentUserName) return

    let cancelled = false

    async function loadMyRatings() {
      try {
        const response = await apiFetch<{ ratings: RatingEntry[] }>(`/ratings?userName=${encodeURIComponent(currentUserName)}`)
        if (cancelled) return
        setMyEntries(response.ratings)

        const refreshedEntries = await refreshGreennessForEntries(response.ratings, currentUserName)
        if (!cancelled) {
          setMyEntries(refreshedEntries)
        }
      } catch {
        if (!cancelled) {
          setMyEntries([])
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

    const lookupId = ++locationLookupSequenceRef.current
    const controller = new AbortController()
    setIsLocationLookupPending(true)

    locationDebounceRef.current = window.setTimeout(() => {
      void (async () => {
        try {
          const photonResponse = await fetch(
            `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=8&osm_tag=amenity:cafe&osm_tag=amenity:restaurant&osm_tag=amenity:fast_food&osm_tag=shop:coffee`,
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
              `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=10&addressdetails=1&namedetails=1&q=${encodeURIComponent(venueBiasedQuery)}`,
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

          if (lookupId !== locationLookupSequenceRef.current) return

          const deduped = Array.from(new Set(suggestionList)).slice(0, 5)
          setLocationSuggestions(deduped)
        } catch {
          if (lookupId !== locationLookupSequenceRef.current) return
          setLocationSuggestions([])
        } finally {
          if (lookupId === locationLookupSequenceRef.current) {
            setIsLocationLookupPending(false)
          }
        }
      })()
    }, 350)

    return () => {
      controller.abort()
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
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } }
        })
        if (!mounted) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }

        cameraStreamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play()
        }
        setCameraError('')
        setCameraReady(true)
      } catch {
        if (mounted) {
          setCameraError('Unable to access camera. You can still upload a photo.')
          setCameraReady(false)
        }
      }
    }

    void startCamera()

    return () => {
      mounted = false
      if (cameraStreamRef.current) {
        cameraStreamRef.current.getTracks().forEach((track) => track.stop())
        cameraStreamRef.current = null
      }
    }
  }, [])

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
    setPhotoDataUrl(dataUrl)
    setMlStatus('Analyzing drink area...')
    setMlCoveragePercent(null)
    setMlConfidencePercent(null)
    const { score, statusMessage, coveragePercent, confidencePercent } = await analyzeGreennessFromDataUrl(dataUrl)
    setMatchaGreenness(score)
    setMlStatus(statusMessage)
    setMlCoveragePercent(coveragePercent)
    setMlConfidencePercent(confidencePercent)
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
    const dataUrl = captureCanvas.toDataURL('image/png')
    stopCameraAccess()
    void processImage(dataUrl)
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
    if (matchaGreenness === null || !photoDataUrl || !currentUserName) {
      alert('Please upload/capture a photo and analyze greenness first.')
      return
    }

    setIsSavingEntry(true)
    const overlayShownAt = Date.now()
    try {
      await apiFetch<{ rating: RatingEntry }>('/ratings', {
        method: 'POST',
        body: JSON.stringify({
          userName: currentUserName,
          photo: photoDataUrl,
          rating: currentRating,
          greenness: matchaGreenness,
          location: location.trim(),
          thoughts: thoughts.trim()
        })
      })

      const updated = await apiFetch<{ ratings: RatingEntry[] }>(`/ratings?userName=${encodeURIComponent(currentUserName)}`)
      setMyEntries(updated.ratings)

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

  async function refreshGreennessForEntries(entries: RatingEntry[], persistUserName?: string) {
    const refreshedEntries = await Promise.all(
      entries.map(async (entry) => {
        try {
          const { score } = await analyzeGreennessFromDataUrl(entry.photo)
          return withUpdatedGreenness(entry, score)
        } catch {
          return entry
        }
      })
    )

    if (persistUserName) {
      const changedEntries = refreshedEntries.filter((entry, index) => entry.greenness !== entries[index].greenness)
      await Promise.all(
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

      const refreshedEntries = await refreshGreennessForEntries(response.ratings)
      setFriendEntries(refreshedEntries)
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
  }

  if (!isUserReady) {
    return (
      <main className="container py-5">
        <div className="alert alert-warning border">{loadingMessage}</div>
      </main>
    )
  }

  return (
    <>
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

      {isExplorePlaceModalOpen && createPortal(
        <div className="explore-place-modal-overlay" role="dialog" aria-modal="true" aria-label={`${selectedExplorePlaceName} ratings`}>
          <div className="explore-place-modal card border-0 shadow-lg">
            <div className="card-body p-3 p-md-4">
              <div className="d-flex justify-content-between align-items-start gap-3 mb-3">
                <div>
                  <h3 className="h5 fw-bold text-success mb-1">{selectedExplorePlaceName}</h3>
                  <div className="small text-muted">All ratings logged for this place</div>
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
                        <img src={entry.photo} alt="Matcha" className="entry-thumb" />
                        <div className="flex-grow-1">
                          <div className="d-flex justify-content-between flex-wrap gap-2">
                            <strong>{entry.userName}</strong>
                            <span className="text-muted small">{entry.date}</span>
                          </div>
                          <div className="small text-muted mb-1">{entry.location || selectedExplorePlaceName}</div>
                          <div className="entry-metrics">
                            <div>Rating: {entry.rating.toFixed(1)} / 5.0</div>
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

      <nav className="navbar navbar-expand-lg navbar-light bg-white border-bottom sticky-top soft-nav">
        <div className="container d-flex flex-column flex-lg-row justify-content-between align-items-start align-items-lg-center gap-2">
          <div className="d-flex flex-column">
            <span className="navbar-brand fw-semibold text-success mb-0">Sip &amp; Score</span>
            <small className="text-muted nav-user">Logged in as {currentUserName}</small>
          </div>

          <div className="d-flex align-items-center gap-2 nav-actions w-100">
            <button
              type="button"
              className={`btn btn-sm ${activePage === 'home' ? 'btn-success' : 'btn-outline-success'}`}
              onClick={() => setActivePage('home')}
            >
              🏠 My Log
            </button>
            <button
              type="button"
              className={`btn btn-sm ${activePage === 'friends' ? 'btn-success' : 'btn-outline-success'}`}
              onClick={() => setActivePage('friends')}
            >
              👥 Friends Ratings
            </button>
            <button
              type="button"
              className={`btn btn-sm ${activePage === 'explore' ? 'btn-success' : 'btn-outline-success'}`}
              onClick={() => setActivePage('explore')}
            >
              🧭 Explore
            </button>
          </div>
        </div>
      </nav>

      {activePage === 'home' && (
        <main className="container py-3 py-md-5 px-3 px-md-4">
          <div className="card shadow-sm border-0 matcha-shell">
            <div className="card-body p-3 p-md-4">
              <h1 className="display-6 fw-bold mb-3 text-success">Rate &amp; Log Your Matcha!</h1>

              <div className="mb-3">
                <label className="form-label fw-semibold">Location (if you can't find your location, manually enter it)</label>
                <div className="location-autocomplete">
                  <input
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
                    placeholder="Location (e.g. cafe name)"
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
                <label className="form-label fw-semibold">Camera capture</label>
                <div className="camera-wrap mb-2">
                  <video ref={videoRef} className="camera-video" autoPlay playsInline muted />
                </div>
                <div className="d-flex gap-2 flex-wrap align-items-center justify-content-center justify-content-md-start">
                  <button type="button" className="btn btn-outline-success" onClick={captureFromCamera} disabled={!cameraReady}>
                    Capture photo
                  </button>
                  {cameraError && <span className="small text-danger align-self-center">{cameraError}</span>}
                </div>
              </div>

              <div className="mb-3">
                <label className="form-label fw-semibold">Upload matcha photo</label>
                <input
                  ref={photoInputRef}
                  type="file"
                  className="form-control"
                  accept="image/*,.jpg,.jpeg,.png,.jfif,.webp"
                  onChange={handlePhotoSelection}
                />
              </div>

              {photoDataUrl && (
                <div className="preview-wrap mb-3">
                  <img src={photoDataUrl} alt="Matcha preview" className="preview-image" />
                </div>
              )}

              <div className="mb-3 text-success fw-semibold">
                {matchaGreenness !== null ? `Greenness (out of 100): ${matchaGreenness.toFixed(1)}` : 'Greenness score will appear after upload.'}
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
                <label className="form-label fw-semibold d-block">Rating (half and 0 stars allowed)</label>
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
                <div className="small text-muted mt-1">Selected: {currentRating.toFixed(1)} / 5</div>
              </div>

              <div className="mb-3">
                <label className="form-label fw-semibold">Thoughts</label>
                <textarea
                  className="form-control"
                  rows={3}
                  placeholder="What did you like about this matcha?"
                  value={thoughts}
                  onChange={(event) => setThoughts(event.target.value)}
                />
              </div>

              <button type="button" className="btn btn-success w-100" onClick={() => void saveEntry()} disabled={isSavingEntry}>
                {isSavingEntry ? 'Saving...' : 'Save Rating'}
              </button>
            </div>
          </div>

          <section className="mt-4 mb-5">
            <div className="d-flex justify-content-between align-items-center gap-2 mb-3">
              <div className="d-flex align-items-center gap-2 flex-grow-1">
                <div>
                  <h2 className="h4 fw-bold text-success mb-0" style={{ cursor: 'pointer' }} onClick={() => setIsMyLogsExpanded(!isMyLogsExpanded)}>
                    My Ratings {isMyLogsExpanded ? '▼' : '▶'}
                  </h2>
                  <small className="text-muted">Tap any entry to edit or delete</small>
                </div>
              </div>
              <input
                type="text"
                className="form-control"
                style={{ maxWidth: '200px' }}
                placeholder="Search by Location"
                value={myLogsSearchTerm}
                onChange={(event) => setMyLogsSearchTerm(event.target.value)}
              />
            </div>
            <div className="d-flex flex-column gap-3">
              {sortedMine.length === 0 && <div className="alert alert-light border">No ratings yet.</div>}

              {(isMyLogsExpanded ? sortedMine : sortedMine.slice(0, 3)).map((entry) => (
                <article key={entry.id} className="card border-0 shadow-sm entry-card" onClick={() => openEntryOverlay(entry)}>
                  <div className="card-body d-flex gap-3 align-items-start">
                    <div className="entry-media-col">
                      <img src={entry.photo} alt="Matcha" className="entry-thumb" />
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

                  {selectedEntryId === entry.id && (
                    <div className="entry-overlay" onClick={(event) => event.stopPropagation()}>
                      {!isEditingEntry && (
                        <div className="entry-overlay-actions d-flex gap-2">
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
                            placeholder="Location (e.g. cafe name)"
                          />

                          <textarea
                            className="form-control mb-2"
                            rows={2}
                            value={editThoughts}
                            onChange={(event) => setEditThoughts(event.target.value)}
                            placeholder="Thoughts"
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
            </div>
          </section>
        </main>
      )}

      {activePage === 'friends' && (
        <main className="container py-3 py-md-5 px-3 px-md-4">
          <section className="card border-0 shadow-sm matcha-shell mb-4">
            <div className="card-body p-3 p-md-4">
              <h2 className="h3 fw-bold text-success mb-3">Friends Ratings</h2>
              <div className="row g-2 align-items-end">
                <div className="col-12 col-md-8">
                  <label className="form-label fw-semibold">Search friend by name</label>
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
                    Open Friend Log
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
                {selectedFriend ? `${selectedFriend}'s ratings` : 'Select a friend to view their log'} {selectedFriend && (isFriendLogsExpanded ? '▼' : '▶')}
              </h3>
              {selectedFriend && (
                <input
                  type="text"
                  className="form-control"
                  style={{ maxWidth: '200px' }}
                  placeholder="Search Ratings"
                  value={friendLogsSearchTerm}
                  onChange={(event) => setFriendLogsSearchTerm(event.target.value)}
                />
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
                      <img src={entry.photo} alt="Friend's matcha" className="entry-thumb" />
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
              ))}
            </div>
          </section>
        </main>
      )}

      {activePage === 'explore' && (
        <main className="container py-3 py-md-5 px-3 px-md-4">
          <section className="card border-0 shadow-sm matcha-shell mb-4">
            <div className="card-body p-3 p-md-4">
              <h2 className="h3 fw-bold text-success mb-2">Explore</h2>
  
              <section className="mb-4">
                <h3 className="h5 fw-bold text-success mb-2" style={{ cursor: 'pointer' }} onClick={() => setIsExplorePlacesExpanded((prev) => !prev)}>
                  Top Places {isExplorePlacesExpanded ? '▼' : '▶'}
                </h3>
                <p className="text-muted mb-3">
                Top places ranked by average score out of 200 from all users. Refreshes weekly. Click a place to see all ratings logged for it.
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
                  User Rankings {isExploreUsersExpanded ? '▼' : '▶'}
                </h3>
                <p className="text-muted mb-3">Across all accounts, see how many different places each user has logged. Click a user to see all ratings logged for them.</p>

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
