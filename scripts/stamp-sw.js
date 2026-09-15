// Stamps a unique build ID into dist/service-worker.js so every deploy
// invalidates the browser cache — regardless of host (Render, GitHub
// Pages, etc). Runs automatically at the end of `npm run build`.
//
// Prefers the git commit SHA (deterministic, human-readable). Falls
// back to a timestamp when no git metadata is available (e.g. a
// stripped Render build).
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const swPath = path.join(projectRoot, 'dist', 'service-worker.js')

if (!fs.existsSync(swPath)) {
  console.warn(`[stamp-sw] skip: ${swPath} not found (was vite build run?)`)
  process.exit(0)
}

let buildId
try {
  buildId = execSync('git rev-parse --short HEAD', { cwd: projectRoot }).toString().trim()
} catch {
  buildId = `t${Date.now()}`
}

const contents = fs.readFileSync(swPath, 'utf8')
const replaced = contents.replace(
  /const CACHE_NAME = 'sip-score-cache-[^']*';/,
  `const CACHE_NAME = 'sip-score-cache-${buildId}';`
)

if (contents === replaced) {
  console.warn('[stamp-sw] warning: CACHE_NAME line not found — did service-worker.js format change?')
  process.exit(0)
}

fs.writeFileSync(swPath, replaced)
console.log(`[stamp-sw] CACHE_NAME → sip-score-cache-${buildId}`)
