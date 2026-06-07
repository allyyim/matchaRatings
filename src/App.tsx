import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, MouseEvent } from 'react'
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

type Page = 'home' | 'friends'

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

const drinkAreaModelConfig = {
  modelUrl: `${import.meta.env.BASE_URL}ml/drink-area/model.json`,
  inputSize: 224,
  maskThreshold: 0.45
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
      let emeraldCount = 0
      let pixelCount = 0

      for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
          if (!region.contains(x, y)) continue

          const i = (y * img.width + x) * 4
          const r = imageData[i]
          const g = imageData[i + 1]
          const b = imageData[i + 2]

          if (r > 230 && g > 230 && b > 230) continue

          if (
            g > r + 5 &&
            g > b + 5 &&
            g > 30 &&
            r > 10 &&
            b > 10 &&
            g < 255 &&
            r < 255 &&
            b < 255
          ) {
            pixelCount++
            const maxRGB = Math.max(r, g, b)
            const minRGB = Math.min(r, g, b)
            const saturation = maxRGB ? (maxRGB - minRGB) / maxRGB : 0
            let scoreBoost = 1
            if (saturation < 0.15) scoreBoost -= 0.5
            if (r > 80 && g - r < 30) scoreBoost -= 0.5

            if (g > 120 && b > 20 && b < g && r < 150 && saturation > 0.08) {
              emeraldCount += 2 * scoreBoost
            } else if (g > 60 && b > 10 && b < g && r < 180 && saturation > 0.05) {
              emeraldCount += scoreBoost
            }
          }
        }
      }

      const score = pixelCount ? Math.min(100, Math.round((emeraldCount / pixelCount) * 100)) : 0
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
  const [thoughts, setThoughts] = useState('')
  const [photoDataUrl, setPhotoDataUrl] = useState('')
  const [matchaGreenness, setMatchaGreenness] = useState<number | null>(null)
  const [mlStatus, setMlStatus] = useState('Checking ML drink-area model...')
  const [mlCoveragePercent, setMlCoveragePercent] = useState<number | null>(null)
  const [mlConfidencePercent, setMlConfidencePercent] = useState<number | null>(null)
  const [cameraReady, setCameraReady] = useState(false)
  const [cameraError, setCameraError] = useState('')
  const videoRef = useRef<HTMLVideoElement>(null)
  const cameraStreamRef = useRef<MediaStream | null>(null)

  const [myEntries, setMyEntries] = useState<RatingEntry[]>([])
  const [friendQuery, setFriendQuery] = useState('')
  const [friendSuggestions, setFriendSuggestions] = useState<string[]>([])
  const [selectedFriend, setSelectedFriend] = useState('')
  const [friendEntries, setFriendEntries] = useState<RatingEntry[]>([])

  const sortedMine = useMemo(() => {
    return [...myEntries].sort((a, b) => {
      if (b.rating !== a.rating) return b.rating - a.rating
      return b.greenness - a.greenness
    })
  }, [myEntries])

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

    async function loadMyRatings() {
      try {
        const response = await apiFetch<{ ratings: RatingEntry[] }>(`/ratings?userName=${encodeURIComponent(currentUserName)}`)
        setMyEntries(response.ratings)
      } catch {
        setMyEntries([])
      }
    }

    void loadMyRatings()
  }, [isUserReady, currentUserName])

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

  function updateRatingFromClick(starIndex: number, event: MouseEvent<HTMLButtonElement>) {
    const bounds = event.currentTarget.getBoundingClientRect()
    const clickX = event.clientX - bounds.left
    const step = clickX < bounds.width / 2 ? 0.5 : 1
    setCurrentRating((starIndex - 1) + step)
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
    void processImage(dataUrl)
  }

  async function handlePhotoSelection(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = async (loadEvent) => {
      const dataUrl = String(loadEvent.target?.result || '')
      await processImage(dataUrl)
    }
    reader.readAsDataURL(file)
  }

  async function saveEntry() {
    if (!currentRating || matchaGreenness === null || !photoDataUrl || !currentUserName) {
      alert('Please upload/capture a photo, analyze greenness, and choose a rating first.')
      return
    }

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
    setMatchaGreenness(null)
    setMlCoveragePercent(null)
    setMlConfidencePercent(null)
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

  async function openFriendRatings(friendName: string) {
    if (!friendName.trim()) return
    setSelectedFriend(friendName)
    setActivePage('friends')
    const response = await apiFetch<{ friendName: string; ratings: RatingEntry[] }>(`/friends/${encodeURIComponent(friendName)}/ratings`)
    setFriendEntries(response.ratings)
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
      <nav className="navbar navbar-expand-lg navbar-light bg-white border-bottom sticky-top soft-nav">
        <div className="container d-flex justify-content-between align-items-center">
          <div className="d-flex flex-column">
            <span className="navbar-brand fw-semibold text-success mb-0">Sip &amp; Score</span>
            <small className="text-muted">Logged in as {currentUserName}</small>
          </div>

          <div className="d-flex align-items-center gap-2 nav-actions">
            <button
              type="button"
              className={`btn btn-sm ${activePage === 'home' ? 'btn-success' : 'btn-outline-success'}`}
              onClick={() => setActivePage('home')}
            >
              🏠 Home
            </button>
            <button
              type="button"
              className={`btn btn-sm ${activePage === 'friends' ? 'btn-success' : 'btn-outline-success'}`}
              onClick={() => setActivePage('friends')}
            >
              👥 Friends Ratings
            </button>
          </div>
        </div>
      </nav>

      {activePage === 'home' && (
        <main className="container py-3 py-md-5 px-3 px-md-4">
          <div className="card shadow-sm border-0 matcha-shell">
            <div className="card-body p-3 p-md-4">
              <h1 className="display-6 fw-bold mb-3 text-success">Rate &amp; Log Your Matcha Reviews</h1>

              <div className="mb-3">
                <label className="form-label fw-semibold">Location</label>
                <input
                  type="text"
                  className="form-control"
                  value={location}
                  onChange={(event) => setLocation(event.target.value)}
                  placeholder="Cafe name or city"
                />
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
                  type="file"
                  className="form-control"
                  accept="image/*,.jpg,.jpeg,.png,.jfif,.webp"
                  capture="environment"
                  onChange={handlePhotoSelection}
                />
              </div>

              {photoDataUrl && (
                <div className="preview-wrap mb-3">
                  <img src={photoDataUrl} alt="Matcha preview" className="preview-image" />
                </div>
              )}

              <div className="mb-3 text-success fw-semibold">
                {matchaGreenness !== null ? `Greenness (out of 100): ${matchaGreenness}` : 'Greenness score will appear after upload.'}
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
                <label className="form-label fw-semibold d-block">Rating (half stars allowed)</label>
                <div id="star-rating" className="d-flex gap-2">
                  {Array.from({ length: 5 }, (_, idx) => {
                    const starIndex = idx + 1
                    const fillAmount = Math.max(0, Math.min(1, currentRating - idx))
                    return (
                      <button
                        type="button"
                        key={starIndex}
                        className="star"
                        onClick={(event) => updateRatingFromClick(starIndex, event)}
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

              <button type="button" className="btn btn-success w-100" onClick={() => void saveEntry()}>
                Save Rating
              </button>
            </div>
          </div>

          <section className="mt-4 mb-5">
            <h2 className="h4 fw-bold text-success mb-3">Your Ratings Log</h2>
            <div className="d-flex flex-column gap-3">
              {sortedMine.length === 0 && <div className="alert alert-light border">No ratings yet.</div>}

              {sortedMine.map((entry) => (
                <article key={entry.id} className="card border-0 shadow-sm">
                  <div className="card-body d-flex gap-3 align-items-start">
                    <img src={entry.photo} alt="Matcha" className="entry-thumb" />
                    <div className="flex-grow-1">
                      <div className="d-flex justify-content-between flex-wrap gap-2">
                        <strong>{entry.location || 'Unknown location'}</strong>
                        <span className="text-muted small">{entry.date}</span>
                      </div>
                      <div>Rating: {entry.rating.toFixed(1)} / 5</div>
                      <div>Greenness: {entry.greenness} / 100</div>
                      <div>Combined score: {entry.comboScore.toFixed(1)}</div>
                      {entry.thoughts && <p className="mt-2 mb-0">{entry.thoughts}</p>}
                    </div>
                  </div>
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
                    disabled={!friendQuery.trim()}
                  >
                    Open Friend Log
                  </button>
                </div>
              </div>

              {friendSuggestions.length > 0 && (
                <div className="mt-3 d-flex flex-wrap gap-2">
                  {friendSuggestions.map((friend) => (
                    <button key={friend} type="button" className="btn btn-outline-success btn-sm" onClick={() => void openFriendRatings(friend)}>
                      {friend}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section>
            <h3 className="h4 fw-bold text-success mb-3">
              {selectedFriend ? `${selectedFriend}'s ratings (best to worst)` : 'Select a friend to view their log'}
            </h3>
            <div className="d-flex flex-column gap-3">
              {selectedFriend && friendEntries.length === 0 && (
                <div className="alert alert-light border">No ratings found for this friend.</div>
              )}

              {friendEntries.map((entry) => (
                <article key={entry.id} className="card border-0 shadow-sm">
                  <div className="card-body d-flex gap-3 align-items-start">
                    <img src={entry.photo} alt="Friend's matcha" className="entry-thumb" />
                    <div className="flex-grow-1">
                      <div className="d-flex justify-content-between flex-wrap gap-2">
                        <strong>{entry.location || 'Unknown location'}</strong>
                        <span className="text-muted small">{entry.date}</span>
                      </div>
                      <div>Rating: {entry.rating.toFixed(1)} / 5</div>
                      <div>Greenness: {entry.greenness} / 100</div>
                      <div>Combined score: {entry.comboScore.toFixed(1)}</div>
                      {entry.thoughts && <p className="mt-2 mb-0">{entry.thoughts}</p>}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </main>
      )}
    </>
  )
}

export default App
