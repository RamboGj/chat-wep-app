# JWT auth

Replaces go-bid's `scs` sessions. **Stateless** — no session or token table. Two HS256 JWTs,
returned in the response body and presented as **bearer tokens**.

## Why not cookies

This used to deliver both tokens as httpOnly cookies. The frontend is on `*.vercel.app` and
the API on `*.onrender.com` — unrelated registrable domains — so those cookies were
**third-party**, and `SameSite=None` only kept them alive in browsers that still permit
third-party cookies. WebKit's ITP blocks them outright, and every browser on iOS is WebKit, so
Safari/Chrome/Brave on iPhone all took a `200 OK` from `/auth/login`, dropped the cookie, and
bounced the user back to the login screen with no error. Brave on Android did the same.

A bearer token has no origin rules, so it works regardless of how the two hosts are related.
**Do not reintroduce cookie auth** unless the frontend and API are moved onto a shared
registrable domain (`app.example.com` + `api.example.com`), at which point `SameSite=Lax`
would be safe again.

The tradeoff accepted here: the token lives in `localStorage`, readable by any script on the
origin, so an XSS bug leaks the session where `httpOnly` used to contain it.

## Tokens

| Token | TTL | Transport | Claims |
|---|---|---|---|
| Access | ~15m (`CHATAPP_ACCESS_TOKEN_TTL`) | `Authorization: Bearer <token>` | `sub`=userID, `exp`, `iat`, `typ:"access"` |
| Refresh | ~7d (`CHATAPP_REFRESH_TOKEN_TTL`) | `{"refresh_token": …}` in the `/auth/refresh` body | `sub`=userID, `exp`, `iat`, `typ:"refresh"` |

Both signed HS256 with `CHATAPP_JWT_SECRET`. `Parse` enforces `typ`, so an access token is
rejected at `/refresh` and a refresh token cannot authenticate a protected route — keeping the
two on separate channels (header vs. body) makes that mix-up harder to make in the first place.

The refresh token is **not rotated**: `/auth/refresh` returns only a new access token and the
client keeps the refresh token it already holds.

Because tokens are stateless, **logout is client-side** — the client discards both tokens. The
`/auth/logout` endpoint remains only so there is one call site; it cannot invalidate anything,
and a token copied off the device stays valid until it expires. Upgrade path if true
revocation is needed: add a `refresh_tokens` table (jti + user_id + revoked_at) and check it
in `/refresh`.

## jwtutils (`internal/jwtutils`)

Owns minting and parsing only — no transport concerns.

```go
type Config struct {
	Secret     []byte
	AccessTTL  time.Duration
	RefreshTTL time.Duration
}

func (c Config) MintAccess(userID uuid.UUID) (string, error)
func (c Config) MintRefresh(userID uuid.UUID) (string, error)
func (c Config) Parse(token, wantType string) (uuid.UUID, error) // verifies sig, exp, typ; returns sub
```

## Middleware (`internal/api/middleware.go`)

Two entry points share one `authenticate` core, differing only in where they find the token:

- `AuthMiddleware` — reads `Authorization: Bearer <token>`. Used by every protected HTTP route.
- `WSAuthMiddleware` — reads `Sec-WebSocket-Protocol`. Used by `/ws` alone.

The browser's `WebSocket` constructor cannot set request headers, and its only other channel
is the URL — where the token would be written into every access log, since chi's
`middleware.Logger` logs the full path. So the client offers two subprotocols,
`["bearer", "<access token>"]`, and the server selects `"bearer"`:

```go
const WSAuthProtocol = "bearer"
```

`wsUpgrader` must list that sentinel in `Upgrader.Subprotocols`, or gorilla answers the
handshake without a `Sec-WebSocket-Protocol` header and the browser fails the connection.

Handlers read `userIDFromContext(r.Context())` either way.

## CORS

`Authorization` is not a CORS-safelisted request header, so it **must** appear in
`AllowedHeaders` or every authenticated cross-origin call fails its preflight.
`AllowCredentials` is off — no cookies cross the boundary any more.

## Endpoints (`/api/v1/auth`)

| Method | Path | Auth | Behavior |
|---|---|---|---|
| POST | `/signup` | public | create user (bcrypt hash), return `201 {user_id}` |
| POST | `/login` | public | verify credentials, return `200 {access_token, refresh_token, token_type, expires_in}` |
| POST | `/refresh` | refresh token in body | return `200 {access_token, token_type, expires_in}`; `422` if blank, `401` if invalid |
| POST | `/logout` | none | `200`; a formality — the client discards its tokens |
| GET | `/me` | bearer access token | return the current user (`id, username, email`) |

On the client, a `401` from any protected call triggers a single `POST /auth/refresh`, then a
retry. If refresh also fails, the user is genuinely logged out.
