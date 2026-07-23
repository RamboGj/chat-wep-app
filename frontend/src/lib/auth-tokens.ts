/**
 * Where the session lives now that it is a bearer token rather than an httpOnly
 * cookie.
 *
 * The cookies this replaced were third-party — the frontend and the API sit on
 * unrelated registrable domains — so WebKit dropped them outright and nobody on
 * iOS could log in. A bearer token has no origin rules, at the cost of being
 * readable by any script on this origin: an XSS bug now leaks the session,
 * where httpOnly used to contain it.
 *
 * The in-memory copy is what the current tab reads; localStorage is only what
 * survives a reload. Safari's private mode has historically thrown on write, so
 * every access is guarded — a session that does not outlive a reload still
 * beats one that cannot start.
 */

const ACCESS_KEY = 'chatapp.access_token'
const REFRESH_KEY = 'chatapp.refresh_token'

/** Refresh this far before expiry, so a request in flight cannot age out mid-trip. */
const EXPIRY_SKEW_MS = 30_000

let accessToken: string | null = null
let refreshToken: string | null = null
let loaded = false

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    // Storage unavailable: the in-memory copy still carries this tab's session.
  }
}

/** Hydrates from localStorage once, on the first read after a page load. */
function load() {
  if (loaded) return
  loaded = true
  accessToken = readStored(ACCESS_KEY)
  refreshToken = readStored(REFRESH_KEY)
}

export function getAccessToken(): string | null {
  load()
  return accessToken
}

export function getRefreshToken(): string | null {
  load()
  return refreshToken
}

/**
 * True when there is anything to authenticate with. A refresh token alone
 * counts: `apiFetch` trades it for a fresh access token on the first 401.
 */
export function hasSession(): boolean {
  return getAccessToken() !== null || getRefreshToken() !== null
}

/** Omitting `refresh` keeps the stored one — /auth/refresh does not rotate it. */
export function setTokens({
  access,
  refresh,
}: {
  access: string
  refresh?: string
}) {
  load()

  accessToken = access
  writeStored(ACCESS_KEY, access)

  if (refresh !== undefined) {
    refreshToken = refresh
    writeStored(REFRESH_KEY, refresh)
  }
}

export function clearTokens() {
  load()
  accessToken = null
  refreshToken = null
  writeStored(ACCESS_KEY, null)
  writeStored(REFRESH_KEY, null)
}

/**
 * Reads `exp` out of the JWT payload. The signature is the server's business —
 * this only needs to know when to bother asking for a new token, and a token
 * this cannot parse is treated as expired so the refresh path handles it.
 */
export function accessTokenExpired(token: string): boolean {
  const payload = token.split('.')[1]
  if (!payload) return true

  try {
    // JWTs are base64url; atob wants plain base64.
    const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    const { exp } = JSON.parse(decoded) as { exp?: number }
    if (typeof exp !== 'number') return true

    return exp * 1000 - EXPIRY_SKEW_MS <= Date.now()
  } catch {
    return true
  }
}
