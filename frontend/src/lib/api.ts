/** Every route the Go API serves lives under this prefix. */
const API_PREFIX = '/api/v1'

/**
 * Where the Go API lives. Set `VITE_API_BASE_URL` to the API's *origin* only
 * (`https://api.example.com`) when it runs on its own host — the prefix above is
 * appended here, so it must not be repeated in the variable. Unset means
 * same-origin, which is what the dev proxy and a co-hosted deployment serve.
 *
 * A cross-origin API needs CORS with credentials, since the auth cookies stop
 * being same-origin.
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

  constructor(status: number, message: string, fields: Record<string, string> = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.fields = fields
  }
}

let refreshInFlight: Promise<boolean> | null = null

/**
 * Swaps the refresh cookie for a fresh access cookie. Concurrent callers share
 * one request so a burst of 401s doesn't fire a refresh each.
 */
function refreshSession(): Promise<boolean> {
  if (!refreshInFlight) {
    const pending = fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    })
      .then((res) => res.ok)
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null
      })

    refreshInFlight = pending
  }

  return refreshInFlight
}

async function parseBody(res: Response): Promise<unknown> {
  if (res.status === 204 || res.headers.get('content-length') === '0') return null

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

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, skipRefresh = false, headers, ...init } = options

  const send = () =>
    fetch(`${API_BASE}${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

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
