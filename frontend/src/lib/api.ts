import {
  accessTokenExpired,
  clearTokens,
  getAccessToken,
  getRefreshToken,
  setTokens,
} from './auth-tokens'
import type { RefreshedAccessToken } from '@/types/api'

/** Every route the Go API serves lives under this prefix. */
const API_PREFIX = '/api/v1'

/**
 * Where the Go API lives. Set `VITE_API_BASE_URL` to the API's *origin* only
 * (`https://api.example.com`) when it runs on its own host — the prefix above is
 * appended here, so it must not be repeated in the variable. Unset means
 * same-origin, which is what the dev proxy and a co-hosted deployment serve.
 *
 * A cross-origin API needs CORS allowing the Authorization header.
 *
 * Note this is inlined at build time: changing it in the host's dashboard has no
 * effect until the frontend is rebuilt.
 */
export const API_BASE =
  (import.meta.env.VITE_API_BASE_URL ?? '')
    .replace(/\/+$/, '')
    // Tolerate the prefix being included anyway, rather than silently 404ing on
    // a doubled `/api/v1/api/v1`.
    .replace(new RegExp(`${API_PREFIX}$`), '') + API_PREFIX

/**
 * A non-2xx response from the API. `fields` carries the per-field messages the
 * backend's validator returns on 422; `message` is the flat `{error}` string
 * everything else responds with.
 */
export class ApiError extends Error {
  readonly status: number
  readonly fields: Record<string, string>

  constructor(
    status: number,
    message: string,
    fields: Record<string, string> = {},
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.fields = fields
  }
}

let refreshInFlight: Promise<boolean> | null = null

/**
 * Swaps the refresh token for a fresh access token. Concurrent callers share
 * one request so a burst of 401s doesn't fire a refresh each.
 */
function refreshSession(): Promise<boolean> {
  if (!refreshInFlight) {
    const refresh = getRefreshToken()

    const pending = (
      refresh === null
        ? Promise.resolve(false)
        : fetch(`${API_BASE}/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: refresh }),
          }).then(async (res) => {
            if (!res.ok) {
              // A rejected token is spent; anything else (a 5xx, the free
              // instance waking up) is worth keeping the session for, since
              // dropping it would sign the user out over a blip.
              if (res.status === 401) clearTokens()
              return false
            }

            const data = (await res.json()) as RefreshedAccessToken
            setTokens({ access: data.access_token })
            return true
          })
    )
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null
      })

    refreshInFlight = pending
  }

  return refreshInFlight
}

/**
 * An access token that is good right now, refreshing first if the stored one
 * has aged out. `apiFetch` doesn't need this — a 401 tells it the same thing —
 * but the WebSocket does: its upgrade is rejected outright with a stale token,
 * and a reconnect would carry the same stale token, so the socket would retry
 * forever instead of recovering.
 */
export async function ensureAccessToken(): Promise<string | null> {
  const token = getAccessToken()
  if (token !== null && !accessTokenExpired(token)) return token

  await refreshSession()
  return getAccessToken()
}

async function parseBody(res: Response): Promise<unknown> {
  if (res.status === 204 || res.headers.get('content-length') === '0')
    return null

  const text = await res.text()
  if (!text) return null

  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function toApiError(status: number, body: unknown): ApiError {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>

    if (typeof record.error === 'string') {
      return new ApiError(status, record.error)
    }

    // 422 from DecodeValidJson: a flat map of field name -> message.
    const fields = Object.fromEntries(
      Object.entries(record).filter(([, v]) => typeof v === 'string'),
    ) as Record<string, string>

    if (Object.keys(fields).length > 0) {
      return new ApiError(status, Object.values(fields)[0], fields)
    }
  }

  return new ApiError(status, `Request failed with status ${status}`)
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown
  /** Skip the refresh-and-retry dance (used by the auth endpoints themselves). */
  skipRefresh?: boolean
}

export async function apiFetch<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { body, skipRefresh = false, headers, ...init } = options

  // The token is read per attempt, not once: the retry below runs after a
  // refresh has replaced it, and must send the new one.
  const send = () => {
    const token = getAccessToken()

    return fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  let res = await send()

  // The access token lives ~15m; a 401 usually just means it aged out.
  if (res.status === 401 && !skipRefresh) {
    if (await refreshSession()) {
      res = await send()
    }
  }

  const parsed = await parseBody(res)

  if (!res.ok) throw toApiError(res.status, parsed)

  return parsed as T
}
