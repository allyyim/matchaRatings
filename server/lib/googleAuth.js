// Shared Google OAuth client. Null when GOOGLE_CLIENT_ID isn't configured
// (routes should check + return 501 in that case).

import { OAuth2Client } from 'google-auth-library'

export const googleClient = process.env.GOOGLE_CLIENT_ID
  ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID)
  : null
