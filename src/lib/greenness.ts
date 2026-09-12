// Client-side matcha greenness analyzer.
// Runs a lightweight random-forest drink-area detector against the image,
// then flood-fills matcha-colored regions and scores the average shade.
// Extracted from App.tsx for maintainability. Pure module — no app state.
export type DrinkRegion = {
  source: 'heuristic' | 'ml-mask'
  contains: (x: number, y: number) => boolean
}

export type DetectResult = {
  region: DrinkRegion
  statusMessage: string
  coveragePercent: number | null
  confidencePercent: number | null
}

let randomForestModel: any = null
let randomForestPromise: Promise<any> | null = null

export async function loadRandomForest() {
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

export function analyzeGreennessFromDataUrl(dataUrl: string): Promise<{
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
        const paleThreshold = darkLighting ? 3 : 8

        if (
          greenDominance >= emeraldThreshold &&
          g >= r + (darkLighting ? 3 : 7) &&
          g >= b + (darkLighting ? 3 : 7) &&
          saturation >= (darkLighting ? 0.04 : 0.08)
        ) {
          return { bucket: 'emerald' as const, weight: 1 }
        }

        // Pale (light-green) matcha: green must actually lead red, not just tie.
        // This prevents olive/beige drinks (where R ~ G) from earning matcha credit.
        if (
          g > r + (darkLighting ? 2 : 5) &&
          g > b + (darkLighting ? 2 : 5) &&
          greenDominance >= paleThreshold &&
          saturation >= (darkLighting ? 0.04 : 0.06)
        ) {
          return { bucket: 'pale' as const, weight: darkLighting ? 0.6 : 0.45 }
        }

        return { bucket: 'none' as const, weight: 0 }
      }

      // Detect off-color pixels within the drink region: dull/muted, yellow-leaning,
      // olive/khaki (yellowish-green with red equal to or greater than green),
      // or brown-leaning. These indicate faded, oxidized, or low-grade matcha.
      function classifyOffColorPixel(r: number, g: number, b: number) {
        const brightness = (r + g + b) / (255 * 3)
        const maxRGB = Math.max(r, g, b)
        const minRGB = Math.min(r, g, b)
        const saturation = maxRGB ? (maxRGB - minRGB) / maxRGB : 0

        if (brightness < 0.08) return 'none' as const

        // Brown: warm tones where red leads, green is muted, blue is lowest.
        if (
          r > g && g > b &&
          r - b >= 22 &&
          r - g >= 6 &&
          brightness >= 0.15 && brightness <= 0.62 &&
          saturation >= 0.15
        ) {
          return 'brown' as const
        }

        // Yellow: R and G high and close (or R even higher), blue much lower.
        if (
          r >= 120 && g >= 120 &&
          Math.abs(r - g) <= 25 &&
          (Math.min(r, g) - b) >= 30 &&
          saturation >= 0.18
        ) {
          return 'yellow' as const
        }

        // Olive / khaki: yellowish-green where R is close to or exceeds G,
        // with a smaller blue drop than a pure yellow — the classic muddy matcha look.
        // R>=G-3 kills the "clearly green" story, and B being lower than both indicates warmth.
        if (
          r >= g - 3 &&
          b < r && b < g &&
          (Math.min(r, g) - b) >= 12 &&
          brightness >= 0.18 && brightness <= 0.75 &&
          saturation >= 0.08
        ) {
          return 'olive' as const
        }

        // Dull / muted: low saturation, mid brightness, tight RGB spread (chalky/beige).
        if (
          saturation < 0.18 &&
          brightness >= 0.22 && brightness <= 0.82 &&
          maxRGB - minRGB < 48
        ) {
          return 'dull' as const
        }

        return 'none' as const
      }

      function isInside(x: number, y: number) {
        return x >= 0 && y >= 0 && x < img.width && y < img.height
      }

      let totalWeightedScore = 0
      let totalBucketPixels = 0
      let emeraldPixelCount = 0
      let palePixelCount = 0
      let matchaLikePixelCount = 0
      let dullPixelCount = 0
      let yellowPixelCount = 0
      let brownPixelCount = 0
      let olivePixelCount = 0
      let regionNonWhitePixelCount = 0

      for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
          if (!region.contains(x, y)) continue

          const index = getPixelIndex(x, y)

          // Tally off-color pixels within the drink region on a single pass,
          // independent of the matcha-only flood-fill below.
          const offPixelOffset = (y * img.width + x) * 4
          const offR = imageData[offPixelOffset]
          const offG = imageData[offPixelOffset + 1]
          const offB = imageData[offPixelOffset + 2]
          if (!(offR > 230 && offG > 230 && offB > 230)) {
            regionNonWhitePixelCount++
            const offBucket = classifyOffColorPixel(offR, offG, offB)
            if (offBucket === 'dull') dullPixelCount++
            else if (offBucket === 'yellow') yellowPixelCount++
            else if (offBucket === 'brown') brownPixelCount++
            else if (offBucket === 'olive') olivePixelCount++
          }

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
            const matchaShareOfRegion = regionNonWhitePixelCount
              ? matchaLikePixelCount / regionNonWhitePixelCount
              : 0

            // Small analytical adjustment so similarly green drinks separate.
            const analyticalAdjustment = (emeraldRatio * 0.45) + (coverageRatio * 0.35) + (paleRatio * 0.1)

            // Off-color penalty: dull/muted, olive/khaki, yellow, brown.
            const denom = Math.max(1, regionNonWhitePixelCount)
            const dullRatio = dullPixelCount / denom
            const yellowRatio = yellowPixelCount / denom
            const brownRatio = brownPixelCount / denom
            const oliveRatio = olivePixelCount / denom
            const rawPenalty = (oliveRatio * 90) + (yellowRatio * 80) + (brownRatio * 75) + (dullRatio * 55)

            // When the drink is clearly emerald-dominant, dull/foam/ice/garnish
            // pixels are almost always toppings — not muddy matcha. Dampen the
            // penalty as emerald share climbs. Full weight below 0.25 emeraldRatio,
            // near-zero weight above 0.7.
            const penaltyDampen = emeraldRatio >= 0.7
              ? 0.15
              : emeraldRatio >= 0.5
                ? 0.35
                : emeraldRatio >= 0.35
                  ? 0.6
                  : emeraldRatio >= 0.25
                    ? 0.85
                    : 1
            const offColorPenalty = Math.min(70, rawPenalty * penaltyDampen)

            // Excellence bonus: reward deep, unmistakably emerald drinks.
            // Emerald ratio 0.6+ contributes up to +12; strong matcha share adds up to +4.
            const emeraldBonus = Math.max(0, emeraldRatio - 0.4) * 20 + Math.min(4, matchaShareOfRegion * 5)

            let finalScore = baseScore + analyticalAdjustment + emeraldBonus - offColorPenalty

            // Floor for genuinely emerald-dominant drinks so foam/cream toppings
            // can't drag a clearly-vibrant matcha out of the "great" tier.
            if (emeraldRatio >= 0.65) finalScore = Math.max(finalScore, 94)
            else if (emeraldRatio >= 0.5) finalScore = Math.max(finalScore, 88)
            else if (emeraldRatio >= 0.35) finalScore = Math.max(finalScore, 78)

            return Number(Math.max(0, Math.min(100, finalScore)).toFixed(1))
          })()
        : 0
      resolve({ score, statusMessage, coveragePercent, confidencePercent })
    }
    img.onerror = () => resolve({ score: 0, statusMessage: 'Failed to load image.', coveragePercent: null, confidencePercent: null })
    img.src = dataUrl
  })
}
