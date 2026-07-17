# JWT auth

Replaces go-bid's `scs` sessions. **Stateless** — no session or token table. Two HS256 JWTs
delivered as httpOnly cookies.

## Tokens

| Token | TTL | Cookie | Claims |
|---|---|---|---|
| Access | ~15m (`CHATAPP_ACCESS_TOKEN_TTL`) | `access_token`, `Path=/` | `sub`=userID, `exp`, `iat`, `typ:"access"` |
| Refresh | ~7d (`CHATAPP_REFRESH_TOKEN_TTL`) | `refresh_token`, `Path=/api/v1/auth/refresh` | `sub`=userID, `exp`, `iat`, `typ:"refresh"` |

Both signed HS256 with `CHATAPP_JWT_SECRET`. Cookie flags: `HttpOnly`, `SameSite=Lax`,
`Secure` (true in prod / false in local dev). Scoping the refresh cookie to the refresh path
keeps it off every other request.

Because tokens are stateless, **logout just clears both cookies** (set `MaxAge=-1`). There is
no server-side revocation of a still-valid access token — its short TTL bounds the exposure.
Upgrade path if true revocation is later required: add a `refresh_tokens` table (jti + user_id
+ revoked_at) and check it in `/refresh`.

## jwtutils (`internal/jwtutils`)

Owns minting and parsing. Suggested surface:

```go
type Config struct {
	Secret     []byte
	AccessTTL  time.Duration
	RefreshTTL time.Duration
	Secure     bool
}

func (c Config) MintAccess(userID uuid.UUID) (string, error)
func (c Config) MintRefresh(userID uuid.UUID) (string, error)
func (c Config) Parse(token, wantType string) (uuid.UUID, error) // verifies sig, exp, typ; returns sub

// cookie helpers
func (c Config) SetAuthCookies(w http.ResponseWriter, access, refresh string)
func (c Config) SetAccessCookie(w http.ResponseWriter, access string)
func ClearAuthCookies(w http.ResponseWriter)
```

## Middleware (`internal/api/middleware.go`)

```go
type ctxKey string
const userIDKey ctxKey = "userID"

func (api *Api) AuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie("access_token")
		if err != nil {
			jsonutils.EncodeJson(w, r, http.StatusUnauthorized, map[string]any{"error": "must be logged in"})
			return
		}
		userID, err := api.Jwt.Parse(c.Value, "access")
		if err != nil {
			jsonutils.EncodeJson(w, r, http.StatusUnauthorized, map[string]any{"error": "invalid or expired token"})
			return
		}
		ctx := context.WithValue(r.Context(), userIDKey, userID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
```

Handlers then read `r.Context().Value(userIDKey).(uuid.UUID)`. The WebSocket upgrade endpoint
sits behind this same middleware — the browser sends the `access_token` cookie on the upgrade
request, so no bespoke WS auth is needed.

## Endpoints (`/api/v1/auth`)

| Method | Path | Auth | Behavior |
|---|---|---|---|
| POST | `/signup` | public | create user (bcrypt hash), return `201 {user_id}` |
| POST | `/login` | public | verify credentials, mint both tokens, set both cookies, `200` |
| POST | `/refresh` | refresh cookie | verify `refresh_token`, mint new access, set access cookie, `200` |
| POST | `/logout` | access cookie | clear both cookies, `200` |
| GET | `/me` | access cookie | return the current user (`id, username, email`) |

On the client, a `401` from any protected call triggers a single `POST /auth/refresh`, then a
retry. If refresh also fails, the user is genuinely logged out.
