#!/usr/bin/env node
// CI guard: block re-introducing client-supplied identity in server routes.
//
// The rule: caller identity must always come from `req.session.userName`,
// never from `req.body.userName` or `req.query.userName`. Reading a
// user's own name from an untrusted request field is the setup step for
// every IDOR bug in this codebase's history — see commit history + the
// server route split for context.
//
// Legitimate exceptions:
//   - auth.routes.js: signup + Google verify run BEFORE a session exists,
//     so they must read the requested username from the body.
//   - account.routes.js POST /api/account/username: reads `newUserName`
//     from body to rename yourself (still gated by requireSession + name
//     uniqueness). Grep pattern only flags `userName`, not `newUserName`.
//   - Any route accepting a TARGET userName (viewing someone else's
//     profile, following a friend) reads it from `req.params.userName` —
//     which is a URL path segment, not caller identity. This script only
//     flags body/query reads.
//
// Run: `node scripts/check-identity-sources.js`.
// Exits non-zero on any violation.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const ROUTES_DIR = join(REPO_ROOT, 'server', 'routes')

// Files exempt from the check — pre-session or self-rename endpoints.
const EXEMPT = new Set(['auth.routes.js', 'account.routes.js'])

// Match req.body.userName / req.body?.userName / req.query.userName / req.query?.userName
// (but NOT newUserName, targetUserName, confirmedUserName, etc.).
const BAD_PATTERN = /req\.(body|query)\??\.userName\b/

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (name.endsWith('.js')) out.push(full)
  }
  return out
}

const violations = []
for (const file of walk(ROUTES_DIR)) {
  const base = file.split(/[\\/]/).pop()
  if (EXEMPT.has(base)) continue
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  lines.forEach((line, idx) => {
    if (BAD_PATTERN.test(line)) {
      violations.push({
        file: relative(REPO_ROOT, file),
        line: idx + 1,
        code: line.trim(),
      })
    }
  })
}

if (violations.length) {
  console.error('\n✗ Identity-source violations found:\n')
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`)
    console.error(`    ${v.code}`)
  }
  console.error(
    '\nCaller identity must come from req.session.userName, not the request body/query.'
  )
  console.error(
    'If this endpoint genuinely needs a target username, use req.params.userName instead.'
  )
  console.error(
    'If it runs before a session exists, add the file to EXEMPT in scripts/check-identity-sources.js.\n'
  )
  process.exit(1)
}

console.log('✓ No client-supplied identity reads in server/routes/')
