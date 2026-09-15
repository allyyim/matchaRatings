// Shared constants used across route modules.

// The demo/recruiter-facing seed user. Hidden from all public/social surfaces
// (friends search, explore leaderboards, similar users/places, follows) so
// recruiter-facing seed data never leaks into the real PWA experience.
export const DEMO_USER_NAME = 'demo'

// Base URL for demo-only static photo assets. Points to the GitHub Pages
// build so the images load correctly whether the demo runs on Render or on
// the GH Pages mirror. Files are checked in at public/demo/*.png.
export const DEMO_PHOTO_BASE = 'https://allyyim.github.io/matchaRatings/demo'
