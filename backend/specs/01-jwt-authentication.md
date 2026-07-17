# Feature 1 — JWT Authentication

Users sign up, sign in, stay signed in via refresh, and sign out. Auth is **stateless JWT in
httpOnly cookies** (see the `go-chat-backend` skill → `references/jwt-auth.md` for the full
token/cookie/middleware design).

## Goals

- Sign up with `username`, `email`, `password`.
- Sign in → receive access + refresh cookies.
- Stay signed in across the session: a short-lived access token, refreshed on demand.
- Sign out → both cookies cleared.

## Entities

`users` — see [`schema.md`](./schema.md). Password stored as a **bcrypt** hash (`cost 12`) in
`password_hash BYTEA`. Never return `password_hash` in any response.

## Endpoints (`/api/v1/auth`)

| Method | Path | Auth | Request body | Success |
|---|---|---|---|---|
| POST | `/signup` | public | `{username, email, password}` | `201 {user_id}` |
| POST | `/login` | public | `{email, password}` | `200 {message}` + Set-Cookie ×2 |
| POST | `/refresh` | refresh cookie | — | `200 {message}` + Set-Cookie (access) |
| POST | `/logout` | access cookie | — | `200 {message}` + cleared cookies |
| GET | `/me` | access cookie | — | `200 {id, username, email}` |

Cookies: `access_token` (`Path=/`, ~15m) and `refresh_token` (`Path=/api/v1/auth/refresh`,
~7d), both `HttpOnly`, `SameSite=Lax`, `Secure` in prod.

## DTOs (`internal/usecase/user`)

- `CreateUserRequest{username, email, password}` — `username` not blank & ≤ 50 chars; `email`
  matches `EmailRX`; `password` ≥ 8 chars.
- `LoginUserRequest{email, password}` — `email` matches `EmailRX`; `password` not blank.

## Service (`internal/services/user_service.go`)

```
CreateUser(ctx, username, email, password) (uuid.UUID, error)
    - bcrypt hash, INSERT, map 23505 → ErrDuplicatedEmailOrUsername
AuthenticateUser(ctx, email, password) (uuid.UUID, error)
    - GetUserByEmail; pgx.ErrNoRows → ErrInvalidCredentials
    - bcrypt.CompareHashAndPassword; mismatch → ErrInvalidCredentials
GetUserByID(ctx, id) (pgstore.User, error)   // for /me
```

Sentinel errors: `ErrDuplicatedEmailOrUsername`, `ErrInvalidCredentials`.

## Queries (`queries/users.sql`)

`CreateUser :one` (RETURNING id), `GetUserByEmail :one`, `GetUserByID :one`. Never select
`password_hash` for `/me`.

## Handler behavior

- **signup**: decode+validate → `CreateUser`. `ErrDuplicatedEmailOrUsername` → `422`; else
  `500`; success `201 {user_id}`. (Do not auto-login on signup for the MVP; client calls
  `/login` next.)
- **login**: decode+validate → `AuthenticateUser`. `ErrInvalidCredentials` → `400
  {"error":"invalid email or password"}`. On success mint both tokens and set both cookies.
- **refresh**: read `refresh_token` cookie → `Jwt.Parse(v, "refresh")`. Invalid/expired → `401`.
  Mint a new access token, set the access cookie.
- **logout**: clear both cookies (`MaxAge=-1`), `200`. (Idempotent — safe without a valid token
  beyond the middleware check.)
- **me**: read `userID` from context → `GetUserByID` → return public fields.

## Middleware

`AuthMiddleware` (`internal/api/middleware.go`) verifies the `access_token` cookie and injects
`userID` into the request context under `userIDKey`. Protected routes are grouped under it in
`routes.go`. The same middleware guards `/ws` (Feature 3) and all of Features 2 & 3.

## Acceptance criteria

- [ ] Signup rejects duplicate email or username with `422`.
- [ ] Signup rejects password < 8 chars and invalid email with `422` field errors.
- [ ] Login with wrong password returns `400`, never reveals which field was wrong.
- [ ] Login sets `access_token` and `refresh_token` httpOnly cookies.
- [ ] A protected endpoint returns `401` with no/invalid/expired access cookie.
- [ ] After access token expires, `POST /auth/refresh` (with a valid refresh cookie) returns a
      new access cookie and the protected endpoint works again.
- [ ] `POST /auth/logout` clears both cookies; subsequent protected calls return `401`.
- [ ] `password_hash` never appears in any response body.
